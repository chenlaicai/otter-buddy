---
id: F20260901schf
title: 修复 function executor 成功路径 FOREIGN KEY 记账回滚
summary: 撮合定时任务（executorType=function）成功后调 completeExecution 传 messageId=''，空串穿透 ?? null 链写入 message_id，被 FK（REFERENCES messages）拒绝导致整笔回滚。双端修复：service 层传 null + repo 层空串归一化防御。
change_type: fix
status: locked
created_in_conversation: 53d775fd-2167-465a-ae2e-c6962d5f4dfb
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - src/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.ts
  - src/usecases/scheduled-task/scheduled-task-repository.ts
tags:
  - scheduler
  - paper-trading
  - bugfix
from:
  - F20260829ppta
capability_test: "n/a: 纯代码逻辑改动，无 LLM 参与行为"
---

# 修复 function executor 成功路径 FOREIGN KEY 记账回滚

## 背景

纸面交易撮合定时任务（paper-trading-match-orders，executorType=function）连续两天 15:05 失败。9/1 15:25（大獭建户后）错误为 `FOREIGN KEY constraint failed`。

## 根因

scheduler-service.ts:437 function executor 成功路径：

```ts
await this.completeExecution(executionId, task.conversationId, '');
```

- `completeExecution` → `taskRepo.updateExecutionStatus(executionId, { ..., messageId: '' })`
- sqlite repo 绑定参数：`updates.messageId ?? null` —— **空串不是 null**，`'' ?? null` 原样穿透
- 写入 `message_id = ''`，而 schema 定义 `message_id TEXT REFERENCES messages(id)`（F20260721x8k9），外键找不到 id 为空串的消息 → `FOREIGN KEY constraint failed` → **撮合结果整笔事务回滚**

注意 turn_id 是无辜的：`activeTurn?.id` 无活跃 turn 时为 undefined → null，外键允许 NULL。

8/31 首日失败（"no active paper account found"）是建户前预期行为，9/1 新失败是本 bug 首次暴露——修复后撮合链路才算真正打通。

## 修复

双层防御：

1. **service 层**（scheduler-service.ts:437）：`completeExecution(executionId, task.conversationId, null)`——function executor 无消息，语义上就是 null。签名从 `messageId: string` 收窄为 `messageId: string | null`。
2. **repo 层**（sqlite-scheduled-task-repository.ts）：新增 `toNullableId` 归一化——空串/undefined 统一转 null。`createExecution` 与 `updateExecutionStatus` 两处出参绑定均应用，防未来 caller 再传空串。
3. **接口类型**（scheduled-task-repository.ts:38-39）：`messageId?: string | null; turnId?: string | null`——null 是「无」的 SQL 语义。

## 验证

- 新增回归测试 4 条：
  - service 层：function executor 成功后 execution 记 completed + messageId=null + resetConsecutiveFailures 被调用；LLM executor 路径不受影响（仍传 anchor message.id）
  - repo 层：messageId='' 归一化为 null 不触发 FK 炸（真 sqlite `:memory:` + `foreign_keys=ON`）；turnId='' 同样归一化
- 定向 93 测试通过；tsc/eslint 干净
- 生产验证：明晚 15:05 撮合任务应记 completed（而非 failed），账本 trades 正常落库

## 影响范围

- 只影响 function executor 路径记账；LLM executor 路径行为不变
- 撮合幂等性已由 PR4 保证，两天失败未造成账本损伤，无需数据修复
