---
id: F20260915hlife
title: 獭间信号生命周期加固：halt 跨世代残留修复 + unhalt 解除路径 + 悬置老化告警
summary: 修复 #927——halt 打标跨 invoke/世代残留（endInvoke 只清 active 不清 pending）导致被 halt 獭所有工具调用被拦只能发 blocked 求救；blocked 信号悬置 6 天无人裁决暴露消费方单点。三层修复：机制层 halt invoke 作用域语义 + pending 30min TTL + unhalt_otter 工具；流程层独立老化扫描 worker。
change_type: fix
capability_test: "单测锁定：tests/usecases/signal/halt-lifecycle-927.test.ts 18 用例（endInvoke 清 pending / TTL 惰性过期+边界 / clear 解除 / unhalt 工具 / aging worker 含去重）"
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
created_at: 2026-09-15
intent:
  problem: "halt 打标跨世代残留：被 halt 獭合规响应后 pending 未清，改派新 invoke 第一个工具调用即被拦；blocked 求救信号悬置 6 天无消费方"
  expected_effect: "halt 作用域=单 invoke，合规响应后自动解除；误 halt 可 unhalt 立即撤销；pending 信号 >24h 自动落 healing 告警，不再依赖 daily review 单点"
  verify_by:
    type: behavior_check
tags: [signal, halt, reliability]
modules:
  - src/usecases/signal/halt-registry.ts
  - src/usecases/signal/signal-aging-worker.ts
  - src/interface-adapters/agent-runtime/tools/signal-tools.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/session-helpers.ts
  - src/app.ts
  - config/tool-manifest.json
  - tests/usecases/signal/halt-lifecycle-927.test.ts
  - tests/usecases/signal/halt-core.test.ts
  - tests/frameworks/agent/coding-tools.test.ts
---

# 獭间信号生命周期加固（#927）

## 背景

9/9 现场事故（issue #927 实证）：gen1 小獭被 halt 后合规响应（speak 报告 + 停止），但其后未消费的 pending halt 打标跨世代残留到 gen2——新 session 的**所有工具调用**被拦，只能发 blocked 信号求救；而 blocked 信号又悬置 6 天无人裁决（daily review 调度链 9/10-9/13 断档，signal 对账段是唯一消费方）。双重失败叠加 = 小獭永久瘫痪 + 求救无门。

## 根因

1. **机制层**：`endInvoke` 只清 `active`（已送达）不清 `pending`（未送达）——halt 的送达语义是「目标獭下一个工具调用边界」，该 invoke 结束后 pending 指令已无消费对象，跨 invoke 保留只形成世代残留
2. **流程层**：pending objection/blocked 的裁决告警只有 daily review 一个消费方，调度断档期违规漏网

## 修复

### 机制层（halt-registry.ts）

- **endInvoke 清 pending + active**：halt 是 invoke 作用域指令——被 halt 獭合规响应后 invoke 自然结束，halt 使命完成；改派新 invoke 不受旧指令拦截。仍需停手，大獭重发（halt_otter 幂等）
- **pending TTL 30 分钟（HALT_PENDING_TTL_MS）**：打标后目标獭长时间未被唤醒（对话静默）时指令挂而不化——惰性过期（takeForBlock/isHalted/peekPending 读取时清扫 issuedAt 超时项），无 timer 成本，进程重启自然归零
- **unhalt_otter 工具（新增，仅 big 型）**：大獭误 halt（打错目标/需求撤回）时立即清除 pending+active 全部打标；未消费指令对应的 signal_events 落账 pending→dismissed（解除理由写台账，审计闭环）。注册进 tool-manifest.json orchestration 组 + big 型 fallback 名单，small 型天然隔离

### 流程层（signal-aging-worker.ts，新增）

`SignalAgingWorker`：app 级 1h setInterval（unref 不阻退出，随 shutdown 停），扫 signal_events 中 pending 态 objection/blocked（halt 不扫——无待裁决事项，首次注入即 resolved），created_at 距今 >24h 落一条 medium healing event（context.signalId 供跟进）。独立于 daily review 调度链——调度断档期不再有告警盲区。

去重：同一 signalId 只落一次老化告警（查 open healing 的 context.signalId）；healing 被 resolve 后信号仍 pending 则下轮再落（持续悬置本就该持续可见）。

severity 取 medium 不取 high：悬置 24h 是流程违规（裁决义务被遗忘）不是运行时故障，high 走 C3 即时唤醒链路留给系统异常。

### 存量处置

6 天悬置的 blocked 信号（12247204）已在 issue 提交时同步 dismissed（halt 场景已过期，无续办价值），台账留痕。

## 设计取舍

- **不做「halt 绑定 session 世代」的强绑定方案**：TTL + invoke 作用域清理的组合已覆盖现场形态（合规响应后残留 / 静默挂起），世代 ID 追踪引入跨模块依赖（session 表），复杂度不成比例
- **TTL 30 分钟**：大獭打标后目标獭理应在数分钟内到达工具调用边界（最坏延迟=单个工具调用时长），30 分钟是宽松上限；超时后仍需停手重发即可
- **老化阈值 24h**：对齐 SYSTEM.md「objection 下一轮派工前裁决 / blocked 当场裁决」义务的违约界——24h 内大獭可能离场睡觉，不算违约
- **不扫 halt 类型**：halt 落账即闭环（首次注入 resolved by system），pending 态 halt 只出现在「打标后目标獭从未被唤醒」——那是 TTL 的管辖范围（内存态已过期），台账 pending 恰是「未执行」的审计证据

## 验证

- 新增 18 单测（tests/usecases/signal/halt-lifecycle-927.test.ts）：endInvoke 清 pending / TTL 惰性过期 + 边界 / clear 解除语义 / unhalt 工具四场景 / aging worker 六场景（含去重、halt 不扫、repos 未注入）
- 既有测试适配：halt-core fixture 硬编码日期改相对当前时间（TTL 会把 8/26 旧日期当超时——#931 同类问题的现场复现）；coding-tools 工具数断言 35→36
- 全量 2943/2943 + tsc 0 + eslint 0；F20260826mwrd C1 halt 注入链路（halt-injection-wiring / capability 剧本）零回归

## 关联

- closes #927
- 地基：F20260826mwrd（信号协议 C1 halt 机制 + C3 healing 高危路由）
- 姊妹：#931（测试硬编码日期漂移——本 PR 开发中又抓到一起同类）
