---
id: F202609048840
title: 服务重启恢复机制五连修复
date: 2026-09-04
summary: 修复服务重启自动恢复五项缺陷：跨会话串行饿死改并行、网络类 invoke 失败纳入重试、旧消息不再复位 streaming 消灭双 invoke 误读、done 语义以派发台账 settle 终态为真相源（invoke 失败标 failed 可重试）、队列时间戳改用完成时刻。
change_type: fix
tags: [resume, recovery, parallel, retry, zombie-display, done-semantics, timestamp]
modules: [src/usecases/conversation/resume-interrupted-service.ts, src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts, src/usecases/conversation/send-message.ts, src/usecases/conversation/conversation-repository.ts, src/frameworks/db/conversation/sqlite-conversation-repository.ts, src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts, src/entities/conversation/dispatch-attempt.ts, src/frameworks/db/schema.ts, src/frameworks/db/migration.ts, src/app.ts]
from: [F20260826rsme]
created_in_conversation: 71782d9a-32b7-4f3e-8f80-6a946b786a9d
intent:
  problem: "服务重启恢复机制五项缺陷：跨会话串行饿死（53分钟实证）、网络类 invoke 失败无重试、僵尸双 streaming 误读、done 说谎、时间戳倒流"
  expected_effect: "重启后多会话中断并行恢复互不阻塞；网络类 invoke 失败 3 次指数退避重试；恢复中旧消息保持 failed 终态无双 streaming；invoke 失败队列标 failed 文案如实；队列时间戳为完成时刻；全量测试绿"
  verify_by:
    type: capability_test
---

## 背景与需求

2026-09-04 17:05 重启后三会话中断恢复现场（DB 实证）：工具优化的恢复链 3 hop 跑 53 分钟，期间 echo agent/对话中invoke机制 两会话饿等；轮到时 echo 的目标獭已 dissolved 判 exhausted；invoke机制 的恢复 invoke 秒败（Connection error 无重试）；用户被迫手动 retry。

## 方案设计

### F1【P0】恢复循环跨会话并行

**问题**：当前 `resume()` 中 for-await 逐会话串行执行，当某个会话的恢复链耗时很长时（如53分钟），其他会话饿等。

**方案**：改为并行执行（Promise.allSettled 按会话分组并发），同会话内多条 item 仍串行（防 sequence_num 竞态）。终态系统消息（sendCompletedSafe）等全部完成后统一发。

**取舍**：
- 优点：多会话恢复不再互相阻塞
- 风险：并发增加系统负载，但实际恢复量小（单次重启 0~2 条），风险可控
- 决策：采用并行方案，在 `resume()` 方法中使用 `Promise.allSettled` 并行处理不同会话

### F2【P0】恢复 invoke 失败纳入重试

**问题**：`resumeOneWithRetry` 现在只认 429/rate limit 错误进行重试，Connection error / timeout 类错误直接失败。

**方案**：扩展可重试判定：Connection error / timeout 类（如 error message 含 "Connection error"/"timeout"/"ECONNRESET"/"fetch failed"）。仍限 3 次指数退避，非可重试错误维持现状快速终态。

**取舍**：
- 优点：临时网络问题可自动恢复，减少用户手动干预
- 风险：过度重试可能延长恢复时间
- 决策：仅对网络相关错误进行重试，保持3次指数退避上限

### F3【P1】僵尸展示收口

**问题**：恢复时旧消息 `prepareForRetry` 复位为 streaming，导致 UI 双 streaming 误读。

**方案**：恢复时旧消息不再复位为 streaming，保持 failed 终态，恢复链写新消息。

**调用方分析**：
1. `resume-interrupted-service.ts:281`：恢复路径调用 `prepareForRetry(item.messageId, true)`
2. `orchestrator.ts:693`：自动重试调用 `prepareForRetry(ctx.input.messageId, false)`
3. `orchestrator.ts:861`：no_yield 重试调用 `prepareForRetry(ctx.input.messageId, true)`

**取舍**：
- 风险：破坏手动 retry 的现有行为（web 手动 retry 可能共用！）
- 决策：添加新参数 `noResetToStreaming`，默认为 `false` 保持向后兼容。恢复路径传 `true`，其他调用方保持原行为。

**设计**：
- 新增参数 `noResetToStreaming?: boolean` 到 `prepareForRetry` 方法
- 恢复路径调用时传 `true`，表示不复位为 streaming
- 其他调用方保持原有行为（传 `false` 或不传）

### F4【P1】done 语义拆分（done 不说谎）

**问题**：现在链跑完就标 done + 发「恢复完成：N 条已恢复」，即使 invoke 实际失败。

**方案**：区分「链完成且 invoke 成功」vs「链完成但 invoke 失败」。

**判据（实现中修正，关键）**：
- 初版判据「executeChain 抛异常 = invoke 失败」是**错的**——链引擎对 invoke 拒绝是 allSettled 吞错语义（processHopResults 只记日志不上抛，#599 同款），invoke 秒败时链正常返回（现场实证：2026-09-04 17:58 恢复 invoke 秒败，旧判据漏判 → done 说谎）
- 终版判据真相源 = **派发台账 settle 终态**：executeResumeChain 后查 `getAttempt(item.messageId, item.otterId)`，status=failed 即 invoke 失败；无行（记账链路异常）保守判成功

**状态设计**：
- 现有状态：`done`（成功）、`exhausted`（超限/失败，不再重试）
- 新增状态：`failed`（链完成但 invoke 失败，可手动重试）

**取舍**：
- 优点：done 语义准确，用户看到 done 就是真正恢复成功
- 风险：需要扩展状态枚举，可能影响现有 switch 消费点
- 决策：新增 `failed` 状态，更新 `updateResumeStatus` 方法签名，确保向后兼容

**消费方影响**：
- `updateResumeStatus` 方法需要支持新状态
- 终态消息构造器需要区分三种状态
- 特性文档需要记录状态定义

### F5【P2】时间戳修正

**问题**：`resumeOne` 里 `updateResumeStatus` 传的 `now` 是函数开头快照，链跑几十分钟后写入的还是开始时刻。

**方案**：改为写入时取新时刻。

**实现**：在 `resumeOne` 方法中，每次调用 `updateResumeStatus` 时都生成新的时间戳，而不是使用函数开头的快照。

## 实现细节

### F1 恢复循环跨会话并行
- **实现位置**：`resume-interrupted-service.ts` 的 `resume()` 方法
- **修改内容**：将 `for (const [conversationId, items] of byConversation)` 循环改为 `Promise.allSettled` 并行处理
- **关键约束**：同会话内多条 item 仍串行（在 `resumeConversation` 方法内保持 for 循环）
- **错误处理**：单个会话失败不阻塞其他会话，使用 try/catch 隔离

### F2 恢复 invoke 失败纳入重试
- **实现位置**：`resume-interrupted-service.ts` 新增 `isRetryableNetworkError` 方法
- **修改内容**：扩展可重试判定，包含 Connection error / timeout 类错误
- **支持的错误模式**：
  - "Connection error"
  - "timeout"
  - "ECONNRESET"
  - "fetch failed"
  - "network error"
  - "ECONNREFUSED"
  - "ETIMEDOUT"
- **重试策略**：仍限 3 次指数退避，非可重试错误维持现状快速终态

### F3 僵尸展示收口
- **实现位置**：`send-message.ts` 的 `prepareForRetry` 方法
- **新增参数**：`noResetToStreaming?: boolean`，默认为 `false`
- **恢复路径调用**：`prepareForRetry(item.messageId, true, true)` 传 `noResetToStreaming=true`
- **其他调用方**：保持原有行为（传 `false` 或不传）
- **关键行为**：
  - 恢复路径：保留 failed 状态，只保留 segments 和创建新 turn
  - 其他路径：保持原有行为（复位为 streaming）

### F4 done 语义拆分
- **实现位置**：`resume-interrupted-service.ts` 的 `resumeOne` + `settleResumedOutcome`（提取控复杂度）
- **状态扩展**：新增 `failed` 状态，区分「链完成但 invoke 失败」
- **判据（终版）**：
  - executeChain 返回后查台账 `getAttempt(messageId, otterId).status`：`failed` → 标 failed + 如实文案；`completed`/无行 → 标 done（观测缺失不误判）
  - executeChain 抛错（链前置失败）→ catch 标 failed
- **支撑改动**：
  - `dispatch-attempt.ts` + `sqlite-dispatch-attempt-repo.ts`：新增 `getAttempt(messageId, targetOtterId)` 唯一键查单行
  - `schema.ts`：restart_pending_resumes.status CHECK 扩 `failed`（开发中实锄：老库 CHECK 拒写 failed，测试期望 failed 实得 exhausted 即此因）
  - `migration.ts`：`rebuildRestartPendingResumesStatusCheck` 四步重建存量库（#608/#654/#804 同模式）+ 三用例锁定
  - `app.ts`：装配注入 dispatchAttemptRepo
- **消费方更新**：
  - `conversation-repository.ts`：扩展 `updateResumeStatus` 状态类型
  - `sqlite-conversation-repository.ts`：支持新状态
  - `retry-policy.ts`：新增 `buildRestartResumeFailedInvokeMsg` 函数

### F5 时间戳修正
- **实现位置**：`resume-interrupted-service.ts` 的 `resumeOne` 方法
- **修改内容**：每次调用 `updateResumeStatus` 时都生成新的时间戳
- **影响范围**：所有 `updateResumeStatus` 调用点（共 5 处）

## 验证

### 测试计划

1. **F1 测试**：多会话并行+同会话串行+单会话失败不阻塞其他
2. **F2 测试**：connection error 退避重试+非可重试快速终态
3. **F3 测试**：不再复位 streaming+手动 retry 路径回归
4. **F4 测试**：失败不标 done+文案如实
5. **F5 测试**：时间戳修正

### 已过最简检查

- 方案已最简：所有修改都在现有架构内，没有引入不必要的抽象层
- 测试注入假时钟/小延迟的模式已有（delayMs/rateLimitBaseDelayMs 参数），沿用

## 验收场景

| 编号 | 修复项 | 场景 | 预期 |
|---|---|---|---|
| AT-1 | F1 并行化 | 三个会话各有1条恢复项 | 并行执行，互不阻塞 |
| AT-2 | F2 重试扩展 | Connection error 触发退避重试 | 3 次指数退避后终态 |
| AT-3 | F3 僵尸收口 | 恢复后旧消息 | 保持 failed，无双 streaming |
| AT-4 | F4 done 语义 | invoke 失败（链吞错返回） | 队列标 failed，文案如实 |
| AT-5 | F5 时间戳 | 恢复完成后队列 updated_at | 完成时刻，非开跑快照 |
| AT-6 | F4 迁移 | 老库（无 failed 枚举）跑迁移 | failed 可写，旧数据保留，幂等 |

## 验证结果（检视发现 3 处置后如实陈述）

- 全量测试：tsc 0 / eslint 0，全量用例数见 PR CI（rebase #807/#809 后基线变化）
- 本特性新增测试：
  - F1 并行：1 用例（三会话并行，前两会话挂起时第三会话已完成——串行实现下不可通过）
  - F2 网络重试：2 用例（台账 note=Connection error 触发 4 次判定=初始+3 重试；非网络 note 零重试快速终态）+ 429 用例升级强断言 toHaveBeenCalledTimes(4)（旧 toHaveBeenCalled 不查次数，内层吞错时假绿——检视发现 1）
  - F3：无新增测试。手动 retry 走 signalRouter.retrySignal（message-controller.ts），不经 prepareForRetry，签名扩展对其零影响；orchestrator 两处调用未传第三参保持默认。依据为路径分析而非回归测试
  - F4：台账判据 3 用例（不可重详 failed 标 failed / 网络类可重试 / 无台账行保守 done）+ 迁移 3 用例（老库重建/幂等/新库直通）
  - F5：1 用例（updated_at ≥ 种子时刻，快照语义移除）
- 检视发现 1 修复（F2 死路径）：settleResumedOutcome 对台账 failed+网络 note 抛可重试错误交 resumeOneWithRetry；内层 catch 对可重试错误重抛；重试耗尽标 failed（可手动重试）与 F4 语义统一
- 已过最简检查：所有修改在现有架构内（Promise.allSettled / 既有重试框架 / 既有台账接口 + 1 个查询方法 / 既有 migration 模式），无新抽象层