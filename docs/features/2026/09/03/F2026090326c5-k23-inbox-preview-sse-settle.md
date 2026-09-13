---
id: F2026090326c5
title: "信号协议 v2 交互增强（K2/K3）：收件箱预告前缀 + SSE 生命周期挂台账终态"
doc_type: feature
summary: >
  sgp2 v2 的交互语义收尾件（flash 提案 K2/K3，#695 交互契约的落法）。K2：invoke 上下文
  注入「N 条待消化」预告（台账 pending 推导，含 busyQueue 排队信号，HALT 特别注明）——
  獭能主动告知用户「插话看到了，跑完就处理」。K3：web POST SSE 关流判据从「路由器返回」
  改为「本轮信号 attempt 全部到终态」（30s 超时兜底）——用户看到流关闭 = 本轮触发的活都落地。
status: implemented
change_type: feature
tags: [signal-protocol, dispatch-ledger, sse-lifecycle, inbox-preview, sgp2-k23]
modules: [src/usecases/conversation/, src/interface-adapters/http/, src/frameworks/db/conversation/]
capability_test: tests/usecases/conversation/k23-inbox-preview.test.ts
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
causal_links:
  from:
    - F20260902sgp2   # 母设计（S2 后的交互增强排期）
    - F20260902u5tr   # 轨迹 UI（K1 状态盒——本设计是其 K2/K3 延伸）
    - F20260903dmpe   # S2.1 阻尼（pending 判据的 failed 排除——K2 预告计数同源）
---

# F2026090326c5: 信号协议 v2 交互增强（K2/K3）

## 目标

补齐 #695 交互契约提案中排期在 S2 后的两件收尾（前置全部就绪：S2 路由器重挂 + 台账真相源）：

- **K2 收件箱预告**：獭在 invoke 时知道自己名下还有多少待消化信号——能主动告知用户
  「你插的话我看到了，当前跑完就处理」（flash 提案缺口 1：排队信号对獭是暗物质 → 精确解）
- **K3 SSE 挂终态**：web 用户看到的流关闭 = 「本轮请求触发的活都落地了」，而非
  「点火决策已发出」——消除「发送后立刻静默」的体验断层

## 方案设计

### K2：收件箱预告前缀（dispatch-chain-engine.ts）

- 注入点：`buildMessageWithContext`（所有入口的 invoke 上下文组装必经之路），
  在「当前时间」之后插入一行 `> 收件箱预告：你名下还有 N 条信号待消化（当前任务完成后按序处理即可）`
- **数据源 = `listPendingSignals`（pendingClause 同一真相源），不过滤目标即取本獭行**：
  - busyQueue 排队中的信号不写账 = 仍是 pending → **天然计入预告**，无需查路由器内存态
  - 本轮触发信号已被 recordStart 写 in_progress → NOT EXISTS 天然排除（不算"待消化"）
  - #755 阻尼后的 pendingClause 已排除 failed/aborted/dissolved——预告数字精确
- **HALT 在列时特别注明**：「（含 N 条 HALT 停机请求，优先处理）」——停机请求优先级最高
- **措辞纪律（#695 裁决固化）**：只说「待消化」，不说「正在忙」（busy 判定是近似）、
  不说队列位置（内存态重启会说谎）
- **零侵入**：台账未注入 → 无预告；查询失败 → 静默无预告。预告是增强信息，不是流程依赖

### K3：SSE 生命周期挂台账终态（message-controller.ts + sse-settle-waiter.ts）

- 旧语义：`routePendingSignals` 返回（同步决策 + fire-and-forget 点火完成）→ 立即关流
  → 用户看到「发送后立刻静默」，实际链还在跑
- 新语义：路由器返回后进入 `awaitTriggerAttemptsSettled`（sse-settle-waiter.ts）——
  轮询台账（500ms 间隔），**本轮触发消息的全部 attempt 行到终态**（completed/failed/aborted）
  才关流
- **无行不算 settled**：全部目标 busy 排队时无 attempt 行（排队不写账纪律）——等
  busyQueue 消化后出现行再正常关流；超时兜底 30s（排队后被别的入口消化等等不到的场景，
  流不悬死，状态由轨迹 UI 承载）
- **failed 也是终态**：失败关流（消息层已有 failed 终态展示），不卡「处理中」假象
- 台账未注入（装配降级）→ 立即返回 = 回退旧关流语义（回滚面完整）
- 抽独立模块 `sse-settle-waiter.ts`（纯函数 + 显式依赖，controller 已超行数门禁；
  platforms.ts 同款先例的 disable 注释用于 DI 决定行数的 controller 本体）

## 影响范围

- 链引擎：buildMessageWithContext + buildPendingPreview（新私有方法，纯增量）
- message-controller：路由器分支 finally 块（~8 行净增）+ 可选 DI（dispatchAttemptRepo）
- bootstrap/controllers.ts：注入一行
- **只动读路径与展示层**：点火、记账、重扫、busyQueue 逻辑零改动
- 回滚面：revert 本 PR 或摘 dispatchAttemptRepo 注入（K2 无预告 / K3 回旧关流语义）

## 取舍表

| # | 决策 | 取 | 舍 | 理由 |
|---|------|----|----|------|
| 1 | K2 数据源 | listPendingSignals 过滤本獭 | 新增 countPendingForTarget SQL | 同一真相源少一个查询入口；排队不写账天然计入是「正确行为」而非巧合（预告就该含排队中的） |
| 2 | K3 关流判据 | attempt 终态轮询 | 订阅 attempt 写入事件 | sqlite 同步写无事件面；轮询 500ms 是最小实现，终态判定 30s 内必然命中或兜底 |
| 3 | 无 attempt 行 | 等待（不算 settled）| 立即关流 | 排队是常态而非异常——立即关会把「排队必达」的用户体验打回「发送后静默」 |
| 4 | 超时 30s | 硬编码常量 | 进 AppConfig | 当前无用户调节诉求；真有长排队场景应由轨迹 UI 承载状态而非拉长流生命周期（S3 观察后再议配置化） |
| 5 | waiter 独立模块 | sse-settle-waiter.ts | 内联 controller | controller 行数门禁 450 已顶（DI 决定行数）；独立纯函数可单测 |

## 验证

- K2：5 用例（真实台账 × 真实投影）——计数含排队/排除本轮 / HALT 注明 / 无 pending 无预告 / 未注入降级 / 措辞纪律（不含「正在忙」「第 N 位」）
- K3：4 用例端到端——终态关流 / failed 也关流 / 无行超时兜底 / 未注入回退旧语义
- 后端 2842 全绿 + 前端 391 全绿 + tsc/eslint 0 error
