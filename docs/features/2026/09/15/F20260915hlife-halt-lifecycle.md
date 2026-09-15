---
id: F20260915hlife
title: 獭间信号生命周期加固：halt 跨世代残留修复 + unhalt 解除路径 + 悬置老化告警
summary: 修复 #927——halt 打标跨 invoke/世代残留（endInvoke 只清 active 不清 pending）导致被 halt 獭所有工具调用被拦只能发 blocked 求救；blocked 信号悬置 6 天无人裁决暴露消费方单点。三层修复：机制层 halt invoke 作用域语义 + 打标前活跃性检查（根治孤儿指令，chen 架构裁决否决 TTL 兜底）+ unhalt_otter 工具；流程层独立老化扫描 worker。
change_type: fix
capability_test: "单测锁定：tests/usecases/signal/halt-lifecycle-927.test.ts 20 用例（endInvoke 清 pending / halt_otter 活跃性检查 5 场景 / clear 解除 / unhalt 工具 / aging worker 含去重）"
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
  - src/usecases/ports/agent-tools.ts
  - src/frameworks/agent/tool-builder.ts
  - src/frameworks/agent/pi-session-factory.ts
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

### 机制层（halt-registry.ts + signal-tools.ts + pi-session-factory.ts）

- **endInvoke 清 pending + active**：halt 是 invoke 作用域指令——被 halt 獭合规响应后 invoke 自然结束，halt 使命完成；改派新 invoke 不受旧指令拦截。仍需停手，大獭重发（halt_otter 幂等）
- **打标前活跃性检查（halt_otter 工具，#927 架构裁决）**：halt 的送达语义是「目标獭下一个工具调用边界」，消费对象是进行中的 invoke——endInvoke 挂 invoke finally，行动结束必清 pending。因此打标时目标不在执行中 = 指令无消费对象（孤儿），**直接拒绝打标**，引导大獭改派新 invoke 后再 halt 或用 unhalt_otter 解除。这是根治，不用 TTL 兜底——设计不留模糊区（chen 终审裁决：否决原方案的 30 分钟 TTL 时间窗兜底，理由：TTL 防「挂而不化」但本质是兜底，前置检查才是根治）。活跃性查询走 `ToolContext.isOtterRunning` 可选回调（PiSessionFactory.isRunning 同源，activeSessions 查询），invoke 生命周期语义一致
- **unhalt_otter 工具（新增，仅 big 型）**：大獭误 halt（打错目标/需求撤回）时立即清除 pending+active 全部打标；未消费指令对应的 signal_events 落账 pending→dismissed（解除理由写台账，审计闭环）。注册进 tool-manifest.json orchestration 组 + big 型 fallback 名单，small 型天然隔离

### 流程层（signal-aging-worker.ts，新增）

`SignalAgingWorker`：app 级 1h setInterval（unref 不阻退出，随 shutdown 停），扫 signal_events 中 pending 态 objection/blocked（halt 不扫——无待裁决事项，首次注入即 resolved），created_at 距今 >24h 落一条 medium healing event（context.signalId 供跟进）。独立于 daily review 调度链——调度断档期不再有告警盲区。

去重：同一 signalId 只落一次老化告警（查 open healing 的 context.signalId）；healing 被 resolve 后信号仍 pending 则下轮再落（持续悬置本就该持续可见）。

severity 取 medium 不取 high：悬置 24h 是流程违规（裁决义务被遗忘）不是运行时故障，high 走 C3 即时唤醒链路留给系统异常。

### 存量处置

6 天悬置的 blocked 信号（12247204）已在 issue 提交时同步 dismissed（halt 场景已过期，无续办价值），台账留痕。

## 设计取舍

- **不做「halt 绑定 session 世代」的强绑定方案**：活跃性检查 + invoke 作用域清理的组合已覆盖现场形态（合规响应后残留 / 打标时目标不在跑），世代 ID 追踪引入跨模块依赖（session 表），复杂度不成比例
- **活跃性检查而非 TTL（chen 终审架构裁决）**：TTL 30 分钟是时间窗兜底——防「挂而不化」但本质是兜底；活跃性检查是根治——halt 的消费对象必然是进行中的 invoke（endInvoke 必清 pending），打标时检查目标是否在执行中，不在则直接拒绝，孤儿指令从入口被杜绝。isOtterRunning 走 ToolContext 可选回调（PiSessionFactory.isRunning 同源，activeSessions 查询），invoke 生命周期语义一致
- **老化阈值 24h**：对齐 SYSTEM.md「objection 下一轮派工前裁决 / blocked 当场裁决」义务的违约界——24h 内大獭可能离场睡觉，不算违约
- **不扫 halt 类型**：halt 落账即闭环（首次注入 resolved by system），pending 态 halt 只出现在「打标后目标獭从未到达工具调用边界」——那是活跃性检查的管辖范围（打标时被拒），台账 pending 恰是「未执行」的审计证据

## 验证

- 新增 20 单测（tests/usecases/signal/halt-lifecycle-927.test.ts）：endInvoke 清 pending / halt_otter 活跃性检查 5 场景（不在执行中拒绝 / 在执行中正常 / 未注入跳过 / 目标不存在 / 自我 halt）/ clear 解除语义 / unhalt 工具四场景 / aging worker 六场景（含去重、halt 不扫、repos 未注入）
- 既有测试适配：halt-core fixture 硬编码日期改相对当前时间（#931 同类问题的现场复现）；coding-tools 工具数断言 35→36
- 全量 2974/2974 + tsc 0 + eslint 0；F20260826mwrd C1 halt 注入链路（halt-injection-wiring / capability 剧本）零回归

## 关联

- closes #927
- 地基：F20260826mwrd（信号协议 C1 halt 机制 + C3 healing 高危路由）
- 姊妹：#931（测试硬编码日期漂移——本 PR 开发中又抓到一起同类）
