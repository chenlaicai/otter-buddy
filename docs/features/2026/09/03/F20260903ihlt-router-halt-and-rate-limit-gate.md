---
id: F20260903ihlt
title: 信号路由器调度闸门：用户中断停机与限流熔断
doc_type: feature

summary: |
  修复 09-03 12:45 Self-Healing 会话事故暴露的两个调度层缺口：用户点「中断」后路由器
  50ms 去抖重扫继续逐只点火 pending 獭（中断 a 弹出 b）；429 限流期间路由器持续排空
  收件箱逐条撞墙。机制：路由器加两级调度闸门——用户停机（markUserHalt 冻结会话全部
  点火，用户发新消息/IM/手动 retry 解除）与限流熔断（healing 台账 rate_limit 事件
  窗口内整会话拒点火，transient 10min / exhausted 60min 分级）。信号全部保留
  （pending 不动），失效模式落哑火侧。

causal_links:
  from:
    - F20260902sgp2   # 信号协议 v2：路由器/台账/pending 语义的母体
    - F20260903damp   # 热循环阻尼（同族失效模式：重扫驱动的自动点火失控）

status: implemented
change_type: fix
tags: [signal-router, dispatch, rate-limit, user-abort]
modules:
  - src/usecases/conversation/signal-router.ts
  - src/interface-adapters/http/controllers/message-controller.ts
  - src/usecases/conversation/agent-dispatch-service.ts
capability_test: "n/a: 纯调度层代码逻辑改动（A 类），无 LLM 叧行为变化"
---

# F20260903ihlt: 信号路由器调度闸门——用户中断停机与限流熔断

## 背景与需求

### 问题描述

09-03 12:45《🩺 Self-Healing》会话：模型 429 限流后海獭逐只被唤醒、逐只失败；
用户手动点「中断」后，系统仍不断弹出下一只海獭的重试（中断小獭 a，弹出小獭 b）。

### 根因分析

取证（台账 note 前情链 + 服务日志 signal-ledger 决策序列）确认两层问题：

1. **【已修未部署，非本 PR 范围】同信号重燃**：事发进程跑的是 #755 合入前的旧二进制
   （全天日志 0 条「阻尼」记录），pending 判据只排除 in_progress 行——completed 终态
   的信号回流 pending，被 50ms 去抖重扫反复重燃。同一 (信号,目标) 最多被 router 重复
   点火 48 次（间隔 8~42s = 一个 LLM 回合 + 50ms）。#755 的 `NOT EXISTS` 全行排除 +
   60s 最小点火间隔已修，部署后此路径免疫。
2. **【本 PR 修】调度层没有「用户叫停」和「模型不可用」的概念**：
   - web 中断按钮的完整链路只有 `POST /abort → agentInvoker.abort(otterId, messageId)`
     ——只 abort 单条消息的 SDK session。被中断 invoke 结束 → 路由器 `finally` 释放
     inFlight → 50ms 去抖重扫 → 点火台账里下一个 pending 目标。中断与路由器零耦合，
     「中断是最高优先级」只存在于单条消息的 orchestrator 分类里，不存在于调度层。
   - 429 是模型级故障，但路由器不认识它：每只 pending 獭照常被点火、逐条撞墙、
     逐条落一条 rate_limit healing 事件——对用户观感等价于无限重试的机枪风暴。

### 数据实锤

- 台账：大獭单条信号 note 里 50 层 `prev=in_progress/completed @router @chain` 交替
  （≈25 次真实点火）；检视獭-760 同信号约 100 层。
- 日志：`completed 落账 → 54ms 后 router 重新点火同一信号` 循环，pid 19431 全程。
- 429 风暴段：12:45:02~12:45:22 四只獭（开发獭-752/检视獭-760/检视獭2-760/大獭）
  依次点火依次 failed，间隔 5~10s——排空收件箱的机枪节奏。

## 方案设计

### 技术方案

路由器加两级调度闸门，求值点在 `routePendingSignals` 扫描级（每轮一次）与
`drainBusyQueue` 队首（消化前）：

**闸门 1：用户停机（userHalted，会话级内存 Set）**
- `markUserHalt(conversationId)`：中断端点在 abort SDK session 后调用。
- `clearUserHalt(conversationId)`：三个用户显式恢复动作调用——web 发新消息
  （streamDispatchResponse 入口，多模态直连链分支同样覆盖）、IM 用户发言
  （agent-dispatch-service）、手动 retry（startRetryChain）。
- 语义：置位后本会话 pending/busyQueue 全部冻结，信号保留不丢；内存态与 busyQueue
  同生命周期（重启即失 = 安全侧，最坏回到无闸门现状）。

**闸门 2：限流熔断（会话级，healing 台账驱动）**
- 数据源 = orchestrator #543 在 429 终态落的 `rate_limit` healing 事件（含 exhausted
  分级）——不新增真相源。
- 窗口：transient（SDK 重试耗尽）10 分钟；exhausted（配额耗尽）1 小时。窗口过后
  恢复点火，若限流仍在，第一发撞墙再落事件再熔断（最坏 1 次/窗口，哑火侧）。
- 会话级而非模型级：otter 实体无 model 字段，模型映射不在路由器可及范围；宁可整会话
  停也不要逐獭撞墙。手动 retry 走直连链不经路由器，不受此闸影响。
- 判定失败 / healingRepo 未注入：不熔断（降级 = 现状行为）。

优先级序：**用户停机 > 限流熔断 > HALT 档位 > NORMAL 档位路由**。HALT 信号档位
（P3 物理停）与本机制正交：那是消息级停机请求，这是调度级用户停机。

### 目标

- T1: 中断后本会话零自动点火（含 50ms 去抖重扫与 busyQueue 消化路径）
- T2: 限流窗口内整会话零自动点火，信号保留（pending 计数不变）
- T3: 用户恢复动作（发消息/IM/retry）可靠解除停机

### 成功标准

- 中断 a 后 b 不再弹出（pending 计数不变，非销账式静默）
- rate_limit 事件窗口内 routePendingSignals 返回 skipped_rate_limited 且零 executeChain
- 全量测试绿 + tsc 零错

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 中断冻结点火 | markUserHalt 后 routePendingSignals（跨去抖周期） | skipped_halted + 零 invoke + pending 保留 |
| AT-2 | 中断不弹下一只 | 双目标 pending + halt + 路由 | 全部 skipped_halted，零点火 |
| AT-3 | 恢复动作解除停机 | clearUserHalt 后路由 | invoked，链点火一次 |
| AT-4 | 限流熔断拒点火 | 会话内 fresh rate_limit 事件 + 路由 | skipped_rate_limited + 零 invoke + pending 保留 |
| AT-5 | 窗口分级 | 30min 前事件：exhausted 拒 / transient 放 | 分别 skipped_rate_limited / invoked |
| AT-6 | 降级安全 | 非 rate_limit 事件在场照常点火；无 healingRepo 照常点火 | invoked |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| 全部 | n/a（A 类纯代码逻辑，单测覆盖） |

## 实现细节

### 代码修改

- `signal-router.ts`：`RouteAction` 增加 `skipped_halted` / `skipped_rate_limited`；
  `userHalted` Set + `markUserHalt` / `clearUserHalt` 公开方法；`isRateLimited` +
  `checkDispatchGates` 私有判定；`routePendingSignals` 扫描级闸门；`drainBusyQueue`
  队首闸门。
- `message-controller.ts`：abort 端点接 `markUserHalt`；streamDispatchResponse 与
  startRetryChain 入口接 `clearUserHalt`。
- `agent-dispatch-service.ts`：IM 入口路由前 `clearUserHalt`。

### 逻辑变更

路由决策序从「inactive 过滤 → 档位路由」变为「inactive 过滤 → **调度闸门** → 档位
路由」。闸门命中时信号原样留在 pending（无 attempt 行写入），K3 SSE settle 等待器
因全 skipped 动作（`action.startsWith("skipped")` 前缀约定保持）直接关流不白等。

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/conversation/signal-router.ts | 修改 | 闸门机制本体 |
| src/interface-adapters/http/controllers/message-controller.ts | 修改 | 中断置位 + 恢复解除接线 |
| src/usecases/conversation/agent-dispatch-service.ts | 修改 | IM 恢复接线 |
| tests/usecases/conversation/signal-router-ledger.test.ts | 修改 | 新增 H1/H2/RL1~RL3 判据块 |
| tests/interface-adapters/http/k23-sse-settle.test.ts | 修改 | router 桩补 clearUserHalt |

## 验收结果

### 测试结果

- `npx vitest run tests/usecases/conversation/signal-router-ledger.test.ts`：16/16 绿
- 全量 `npm test`：231 文件 / 2853 用例全绿；eslint 0 error
- `npx tsc --noEmit`：零错

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 中断冻结 | H1/H2 用例证明完成 | ✅ |
| T2 限流熔断 | RL1/RL2 用例证明完成 | ✅ |
| T3 恢复解除 | H1 后半段证明完成 | ✅ |
| 生产部署验证 | 待部署后观察（合入 ≠ 生效，见教训） | ❓ |

## 设计决策

- **闸门求值放扫描级而非逐目标**：一是复杂度门禁（routeTarget 12 上限），二是省掉
  同轮重复的 healing 查询；代价是 HALT 信号在停机期间同样冻结（用户停机优先于一切，
  语义上正确）。
- **熔断窗口过期自愈而非显式复位**：限流恢复没有可靠信号，窗口探测（最坏 1 次撞墙/
  窗口）比常驻探测任务简单且哑火侧。
- **不修同信号重燃**：那是旧二进制行为，#755 已修，本 PR 不重复——但事故再次实证
  「合入 ≠ 生效」，部署验证欠账记录在案。

## 对抗审视记录

- 自审 1：halt 期间 in-flight invoke 不受影响（仍会跑完）——本 PR 边界，多獭并发时
  用户需逐只中断或等其自然结束；物理停全部 in-flight 归 P3 中断决策协议。
- 自审 2：busyQueue 内存态，halt 后进程重启会丢队列内容——既有已知边界（v2 文档
  §busyQueue），非本 PR 引入。
- 自审 3：rate_limit 事件由 orchestrator 落账，若 healing 落账失败则熔断不触发——
  降级为现状行为（逐獭撞墙但每只终态可见），可接受。
