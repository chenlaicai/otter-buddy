---
id: F20260901ppfk
title: function executor 完成记账 FK 违规修复：撮合任务连续失败熔断风险
summary: 0901 15:25 撮合任务（paper-trading-match-orders）第二次失败，错误 FOREIGN KEY constraint failed——function executor 成功路径调用 completeExecution(executionId, conversationId, '')，updateExecutionStatus 写入 messageId=''，空串非 NULL 在 FK 开启的库上必然违规（messages 表无 id=''）。撮合功能本身已成功执行，死在记账步骤，且 consecutive_failures 累计到 2，明日再败即触发 3 次熔断停跑。修复：function executor 成功路径不走 completeExecution，直接 updateExecutionStatus 只传 status/completedAt，messageId/turnId 留 NULL。
change_type: fix
created_in_conversation: 53d775fd-2167-465a-ae2e-c6962d5f4dfb
from:
  - F20260829ppta
  - F20260901schd
tags: [scheduler, paper-trading, function-executor, sqlite-fk]
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - tests/usecases/scheduler/scheduler-service.test.ts
  - tests/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.test.ts
---

# function executor 完成记账 FK 违规修复（F20260901ppfk）

## 背景

2026-09-01 15:25 撮合任务第二次执行失败：

| 时间 | 错误 | 说明 |
|------|------|------|
| 08-31 15:05 | `no active paper account found` | 预期内——当时账本尚未初始化（当日 15:39 已建户 9DA32029） |
| 09-01 15:25 | `FOREIGN KEY constraint failed` | **新 bug**——建户后撮合功能本身执行成功（日志有 matchedOrders 结果），死在完成记账步骤 |

`consecutive_failures` 已累计到 2；按 #516 熔断规则，明日再失败一次任务即自动停跑（status=error）。

## 根因

调用链（file:line 锚定，行号基于本 PR 基点）：

1. `src/usecases/scheduler/scheduler-service.ts` triggerTask 的 PR4 function executor 分支：函数执行成功后调用 `this.completeExecution(executionId, task.conversationId, '')`
2. `completeExecution`（scheduler-service.ts:795）取 `getActiveTurn(conversationId)` 的 turnId，然后调 `taskRepo.updateExecutionStatus(executionId, { status, completedAt, messageId: '', turnId })`
3. `sqlite-scheduled-task-repository.ts:144` 一次 UPDATE 同时写 `message_id` 和 `turn_id`，两列均有 FK 约束（`REFERENCES messages(id)` / `REFERENCES turns(id)`）
4. **`messageId: ''` 空字符串不是 NULL**——SQLite FK 只豁免 NULL，`messages` 表不存在 id='' 的行 → `FOREIGN KEY constraint failed`
5. 异常被 catch 后走 `handleTaskExecutionFailure`：execution 落 failed、consecutive_failures +1——**功能成功但记账为失败**

为什么 PR4 冒烟测试（pr5-dry-run.test.ts）没抓到：干跑直接调 `ledger.matchOrders` / `paperTradingFunctionRegistry.execute`，不经过 scheduler 的 triggerTask 完成记账路径；而 scheduler-service.test.ts 的 mock taskRepo 的 `updateExecutionStatus` 是 vi.fn（Object.assign 原地更新），FK 约束在 mock 层不可见。两层测试都绕开了真实违规点。

## 修复方案

function executor 成功路径不走 `completeExecution`（它为 agent 会话路径设计：关联消息与活跃 turn），改直接调 `taskRepo.updateExecutionStatus` 只传 `status: 'completed'` + `completedAt`：

- `messageId`/`turnId` 留 NULL——FK 豁免，且语义正确：function executor 纯代码执行，无消息可关联
- agent 会话路径（completeExecution 带 messageId）不受影响

**第二层防御（竞态裁决后追加，源自同日另一修复方案）**：repo 层 `toNullableId` 归一化——`sqlite-scheduled-task-repository.ts` 的 `createExecution` 与 `updateExecutionStatus` 两处出参绑定，空串/undefined 统一转 NULL。未来任何调用方再传 `''` 都不再触发外键回滚。接口类型同步放宽 `messageId?: string | null; turnId?: string | null`（NULL 是「无」的 SQL 语义）。

> 背景：同日 session 重启竞态产生了第二份修复（PR #674，已关闭），裁决采用本 PR 的 service 层修法（绕开 completeExecution，不关联无关 turn）+ 移植其 repo 层防御层。

## 改动文件

| 文件 | 改动 |
|------|------|
| `src/usecases/scheduler/scheduler-service.ts` | function executor 成功路径改为直接 updateExecutionStatus（不写 messageId/turnId） |
| `src/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.ts` | toNullableId 归一化（''/undefined → null），createExecution 与 updateExecutionStatus 双落点 |
| `src/usecases/scheduled-task/scheduled-task-repository.ts` | 接口类型放宽 messageId/turnId 为 `string \| null` |
| `tests/usecases/scheduler/scheduler-service.test.ts` | 新增 `PR4: function executor 执行记账` describe：成功落 completed 且 messageId/turnId 为 NULL、不发消息不 invoke agent、函数抛错落 failed、registry 未注入抛 validation |
| `tests/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.test.ts` | 新增 3 个真库 FK 回归测试：`messageId=''` 被 repo 层归一化为 NULL 不再炸（验证防御层）；`turnId=''` 同样归一化；不传 messageId/turnId 干净落库 |

## 验证

- 定向 4 文件 95 测试通过（含 FK 回归）；全量 205 文件 2558 测试通过
- `npx tsc --noEmit` 干净；eslint 干净

## 关联

- 现场：撮合任务 0901 15:25 失败记录（scheduled_task_executions，error_message=FOREIGN KEY constraint failed）
- 同日 15:30 操盘任务迟到 20 分钟（15:50 补触发）属 F20260901schd #640 轮询修复范畴——运行中进程（08:01 启动）未加载该修复，重启后自愈，与本 PR 无关
- 前置：F20260829ppta（PR4/PR5 纸面交易账本与撮合任务设计）
