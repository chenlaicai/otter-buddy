---
id: F20260811onst
title: once-scheduled-task
doc_type: feature

summary: |
  支持一次性定时任务（scheduleType=once），新增 create_scheduled_task Agent Tool。
  海獭可在对话中创建一次性提醒（如"下午5点提醒我喝水"），系统在指定时间触发并通知搭档。

causal_links:
  from:
    - F20260721x8k9

status: development
change_type: feature
tags: [scheduler, agent-tool, reminder]
modules:
  - src/entities/scheduled-task/
  - src/usecases/scheduled-task/
  - src/usecases/scheduler/
  - src/frameworks/db/scheduled-task/
  - src/frameworks/db/migration.ts
  - src/interface-adapters/agent-runtime/tools/
capability_test: "n/a: 纯 A 类改动（代码逻辑），无 LLM 参与行为"
---

# F20260811onst: 一次性定时任务

## 背景与需求

### 问题描述

搭档说："我下午五点有个会议，你提醒我 1.喝水 2.上厕所"。当前系统只有周期性定时任务（cron），无法表达"只触发一次"的语义。

### 现状分析

已有 80% 的基础设施：
- `ScheduledTask` 实体（cron 表达式、时区、状态管理）
- `ManageScheduledTask` CRUD + 状态校验
- `SchedulerService` 内存 timer 调度
- `SqliteScheduledTaskRepository` 持久化

缺失三样关键能力：
1. **Agent Tool** — 海獭没有"创建定时任务"的工具
2. **一次性语义** — 系统只有 cron（周期性），无法表达"只触发一次"
3. **当前时间感知** — 海獭不知道现在几点，算不出"还有多久到5点"

## 方案设计

### 数据模型变更

```typescript
interface ScheduledTask {
  // 新增字段
  scheduleType: 'cron' | 'once';  // 调度类型
  triggerAt: string | null;        // 一次性触发的精确 ISO 时间
}
```

### 核心逻辑

1. **once 任务调度**：`scheduleOnce` 计算 delay，过期则 disabled，否则 setTimeout
2. **触发后 disable**：once 任务触发成功后直接 `updateStatus('disabled')`
3. **专用重试**：失败后 `triggerOnceWithRetry` 延迟 65s 重试，最多 3 次
4. **交叉校验**：`validateUpdateCrossFields` 确保 scheduleType 与 cron/triggerAt 一致

### Agent Tool

新增 `create_scheduled_task` 工具，海獭可在对话中创建定时任务：
- `scheduleType='cron'`：周期性（如每天9点）
- `scheduleType='once'`：一次性（如今天下午5点）

### 数据库 Migration

`migration.ts` 追加 ALTER TABLE 补丁：
- `schedule_type TEXT NOT NULL DEFAULT 'cron'`
- `trigger_at TEXT`

## 验收场景

| AT | 场景 | 操作 | 预期 |
|----|------|------|------|
| AT-1 | 创建 once 任务 | 调用 create_scheduled_task，scheduleType=once，triggerAt=未来时间 | 任务创建成功，scheduleType=once |
| AT-2 | once 任务触发 | 等待 triggerAt 到达 | 任务触发，发送消息，状态变为 disabled |
| AT-3 | 过期 once 任务 | 创建 triggerAt 已过去的任务 | 任务直接 disabled，不触发 |
| AT-4 | once 任务失败重试 | 触发失败 | 延迟 65s 重试，最多 3 次 |
| AT-5 | 向后兼容 | 创建 cron 任务 | 正常工作，scheduleType 默认 'cron' |

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/entities/scheduled-task/scheduled-task.ts | 修改 | 新增 ScheduleType、triggerAt、isValidTriggerAt() |
| src/usecases/scheduled-task/manage-scheduled-task.ts | 修改 | 接口变更 + 交叉校验 |
| src/usecases/scheduler/scheduler-service.ts | 修改 | once 分支 + triggerOnceWithRetry |
| src/frameworks/db/scheduled-task/ | 修改 | mapper + repository 适配 |
| src/frameworks/db/migration.ts | 修改 | ALTER TABLE 补丁 |
| src/frameworks/db/schema.ts | 修改 | CREATE TABLE 新增列 |
| src/interface-adapters/agent-runtime/tools/scheduled-task-tools.ts | 新增 | create_scheduled_task 工具 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | 注册新工具 |
| src/bootstrap/platforms.ts | 修改 | resolveManageScheduledTask 延迟注入 |
| src/app.ts | 修改 | 调用 resolveManageScheduledTask |
| tests/ | 修改 | 新增 once 任务相关测试 |

## 决策史

| 决策 | 结论 | 理由 |
|------|------|------|
| once vs cron 复用 | 独立 once 类型 | 语义清晰，避免"每天 vs 某天"歧义 |
| 触发后直接 disable | 是 | 消除间接路径的时间窗口风险 |
| once 失败处理 | 专用重试（65s × 3 次） | scheduleNext 重建 timer 时 triggerAt 已过，走不到重试路径 |
| cron 占位值 | 空串 | 避免语义歧义 |
| migration 策略 | 现有 migration.ts 追加 | 遵循项目现有模式 |
| 工具注入方式 | resolveManageScheduledTask 延迟注入 | 解决 createAgentGateway 与 initUseCases 的循环依赖 |
