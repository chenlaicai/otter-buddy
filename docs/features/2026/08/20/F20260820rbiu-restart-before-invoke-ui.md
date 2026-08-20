---
id: F20260820rbiu
title: restart-before-invoke-ui
doc_type: feature

# 记忆索引
summary: |
  Web UI 定时任务管理界面补充 restartBeforeInvoke 配置能力。
  后端（F20260815rstrt）已完整实现该字段，但 Web 端缺失：API DTO、mapper、Modal toggle、Section 标签。
  同时修复 UpdateScheduledTaskRequestDTO 和 controller 未透传该字段的问题。

# 因果链路
causal_links:
  from:
    - F20260815rstrt   # restartBeforeInvoke 后端实现

# 元数据
status: development
change_type: feature
tags: [scheduler, web-ui, restart-before-invoke, scheduled-task]
modules: [web/src, src/interface-adapters/http]

# 时间
created_at: 2026-08-20

# 能力测试
capability_test: "n/a: 纯前端 UI 字段补齐 + 后端 DTO 透传，无 LLM 行为变更"
---

# F20260820rbiu - Web UI 定时任务 restartBeforeInvoke 配置

## 1. 需求背景

### 1.1 问题陈述

| 问题 | 现象 | 根因 |
|------|------|------|
| Web UI 无法配置 restartBeforeInvoke | 定时任务 Modal 无 toggle | 前端未实现该字段 |
| API 更新不支持 restartBeforeInvoke | PATCH 接口忽略该字段 | UpdateScheduledTaskRequestDTO 缺失 |
| 现有任务全部 restartBeforeInvoke=false | Self-Healing、依赖升级等任务每次触发累积上下文 | 创建时未传该字段 |

搭档原话："我查看定时任务，我发现定时任务没地方配置是否每次触发执行都重启獭生"

### 1.2 现状分析

- 后端（F20260815rstrt）：实体、scheduler 逻辑、agent tool、HTTP DTO（create/response）、DB mapper 已完整实现
- 前端：`web/src/` 下零引用 `restartBeforeInvoke`
- 缺口：UpdateScheduledTaskRequestDTO（前后端）和 controller update 方法未透传

## 2. 目标

T1: Web UI 定时任务 Modal 支持 toggle `restartBeforeInvoke`
T2: PATCH API 支持更新 `restartBeforeInvoke`
T3: 任务列表展示 `restartBeforeInvoke` 状态标签

## 3. 非目标

- 数据修复（现有 4 个任务改 restartBeforeInvoke=true）— 通过 DB 或 API 手动操作，不包含在本 PR
- SYSTEM.md 提示词引导 — 独立变更

## 4. 方案设计

### 4.1 后端

| 文件 | 变更 |
|------|------|
| src/interface-adapters/http/dto/scheduled-task-dto.ts | UpdateScheduledTaskRequestDTO 新增 restartBeforeInvoke? |
| src/interface-adapters/http/controllers/scheduled-task-controller.ts | update 方法透传 restartBeforeInvoke |

### 4.2 前端

| 文件 | 变更 |
|------|------|
| web/src/api/client.ts | CreateScheduledTaskRequestDTO / UpdateScheduledTaskRequestDTO / ScheduledTaskDTO 新增字段 |
| web/src/lib/mappers.ts | LocalScheduledTask / ScheduledTaskDTO / mapScheduledTaskDTO 新增字段 |
| web/src/pages/conversation/ScheduledTaskModal.tsx | 新增 toggle 组件，onSave 回调携带字段 |
| web/src/pages/conversation/ScheduledTaskSection.tsx | restartBeforeInvoke=true 时展示"重启獭生"标签 |

### 4.3 数据流

```
ScheduledTaskModal (toggle state)
  → onSave({ ..., restartBeforeInvoke: boolean })
    → useScheduledTasks.create(data) / .update(id, data)
      → api.createScheduledTask / api.updateScheduledTask
        → POST/PATCH /api/conversations/:id/scheduled-tasks
          → ScheduledTaskController.create / .update
            → ManageScheduledTask.create / .update
```

## 5. 影响范围

- 定时任务创建/编辑流程
- 定时任务列表展示
- 无破坏性变更（字段可选，默认 false）

## 6. 验收场景

| AT | 场景 | 操作 | 预期 |
|----|------|------|------|
| AT-1 | 创建任务带 restartBeforeInvoke | Modal 中开启 toggle，创建 | 任务列表显示"重启獭生"标签 |
| AT-2 | 编辑任务开启 restartBeforeInvoke | 编辑现有任务，开启 toggle | 保存后列表显示标签 |
| AT-3 | 编辑任务关闭 restartBeforeInvoke | 编辑任务，关闭 toggle | 保存后标签消失 |
| AT-4 | 向后兼容 | 现有任务（无 toggle） | 正常显示，无标签 |

## 7. 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/interface-adapters/http/dto/scheduled-task-dto.ts | 修改 | UpdateScheduledTaskRequestDTO 新增 restartBeforeInvoke |
| src/interface-adapters/http/controllers/scheduled-task-controller.ts | 修改 | update 方法透传 restartBeforeInvoke |
| web/src/api/client.ts | 修改 | 3 个 DTO 接口新增字段 |
| web/src/lib/mappers.ts | 修改 | LocalScheduledTask / ScheduledTaskDTO / mapper 新增字段 |
| web/src/pages/conversation/ScheduledTaskModal.tsx | 修改 | toggle 组件 + onSave 携带字段 |
| web/src/pages/conversation/ScheduledTaskSection.tsx | 修改 | restartBeforeInvoke 标签展示 |
