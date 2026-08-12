---
id: F20260812a2b3
title: once-task-auto-remove
doc_type: feature

summary: |
  一次性定时任务（scheduleType=once）触发后自动删除，不再保留 disabled 状态。
  已过期的一次性任务也直接删除，重试耗尽的任务保留 error 状态。

causal_links:
  from:
    - F20260811onst

status: development
change_type: feature_update
tags: [scheduler, once-task, auto-remove]
modules:
  - src/usecases/scheduler/
  - tests/usecases/scheduler/
capability_test: "n/a: 纯 A 类改动（代码逻辑），无 LLM 参与行为"
---

# F20260812a2b3: 一次性任务触发后自动删除

## 背景与需求

### 问题描述

一次性定时任务（scheduleType=once）触发后，系统将其标记为 `disabled` 状态，侧边栏显示"已暂停"。但一次性任务触发完就没用了，应该直接移除。

### 现状分析

当前行为：
- once 任务触发成功 → 状态变为 `disabled`
- 已过期的 once 任务 → 状态变为 `disabled`
- 重试耗尽的 once 任务 → 状态变为 `error`

问题：
- 侧边栏显示"已暂停"的一次性任务，用户体验差
- 一次性任务完成后没有清理，占用数据库空间

## 方案设计

### 核心逻辑变更

1. **触发成功后删除**：once 任务触发成功后直接从数据库删除，不再保留 disabled 状态
2. **过期任务删除**：已过期的 once 任务也直接删除
3. **重试耗尽保留 error**：重试耗尽的 once 任务保留 error 状态，让用户能看到失败原因

### 数据库影响

- 删除任务时，`scheduled_task_executions` 表中的执行记录会通过 `ON DELETE CASCADE` 外键约束自动级联删除
- 这是期望的行为：一次性任务完成后，执行记录也不需要保留

## 验收场景

| AT | 场景 | 操作 | 预期 |
|----|------|------|------|
| AT-1 | once 任务触发成功 | 等待 triggerAt 到达 | 任务从数据库删除，侧边栏不再显示 |
| AT-2 | 已过期 once 任务 | 创建 triggerAt 已过去的任务 | 任务直接删除，不触发 |
| AT-3 | once 任务触发失败 | 触发失败 | 延迟 65s 重试，最多 3 次 |
| AT-4 | once 任务重试耗尽 | 所有重试失败 | 任务标记 error，保留在数据库 |

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/scheduler/scheduler-service.ts | 修改 | scheduleOnce 方法：过期删除、触发成功删除、重试成功删除 |
| tests/usecases/scheduler/scheduler-service.test.ts | 修改 | 更新测试验证一次性任务触发后从 store 中移除 |

## 决策史

| 决策 | 结论 | 理由 |
|------|------|------|
| 触发后行为 | 删除而非 disabled | 一次性任务完成后没有保留价值 |
| 过期任务行为 | 删除而非 disabled | 同上 |
| 重试耗尽行为 | 保留 error | 让用户能看到失败原因 |
| 执行记录处理 | 级联删除 | ON DELETE CASCADE 自动处理，不需要手动清理 |
