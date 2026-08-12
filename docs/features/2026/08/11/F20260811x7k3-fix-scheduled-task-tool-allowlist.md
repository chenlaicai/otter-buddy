---
id: F20260811x7k3
title: fix-scheduled-task-tool-allowlist
doc_type: feature

summary: |
  修复 create_scheduled_task 工具未加入允许列表的问题。
  PR226 实现了工具的完整链路（migration、注册、业务逻辑），
  但遗漏了将工具名加入 session-helpers.ts 的 allToolNames 列表，
  导致工具在运行时不可用。

causal_links:
  from:
    - F20260811onst

status: implemented
change_type: bugfix
tags: [agent, scheduled-task, tool-allowlist, bugfix]
modules:
  - src/frameworks/agent/session-helpers.ts

created_at: 2026-08-11
---

# F20260811x7k3 修复 create_scheduled_task 工具未加入允许列表的问题

## 问题描述

### 现象
- 用户请求创建定时任务时，大獭反馈没有 `create_scheduled_task` 工具
- 实际上 PR226 已经实现了该工具的完整链路

### 根因分析
- PR226 实现了：
  1. 数据库 migration（`schedule_type`、`trigger_at` 字段）
  2. 工具注册逻辑（`tool-factory.ts` 中的 `createCreateScheduledTaskTool`）
  3. 业务层实现（`ManageScheduledTask`）
- **遗漏**：未将 `create_scheduled_task` 加入 `session-helpers.ts` 的 `getOtterToolNamesForType` 函数返回的 `allToolNames` 列表

### 影响范围
- 影响 `big` 和 `small` 类型的 otter
- 移除 `invite_participant` 工具（历史遗留，无使用场景）
- 开放 `create_scheduled_task` 和 `manage_healing_events` 给小獭

## 修复方案

### 修改文件
**`src/frameworks/agent/session-helpers.ts`**

在 `getOtterToolNamesForType` 函数的 `allToolNames` 数组中添加 `"create_scheduled_task"`：

```typescript
const allToolNames = [
  "speak", "search_memory",
  // ... 其他工具
  "manage_healing_events",
  "create_scheduled_task",  // 新增
  "workspace_info", "workspace_list", "workspace_read", "workspace_write",
];
```

### 验证方式
1. 重启 otter 服务
2. 大獭的工具列表中应包含 `create_scheduled_task`
3. 用户可以说"提醒我 XX 点做 XX"来创建定时任务

## 决策记录

| 决策 | 结论 | 理由 |
|------|------|------|
| 修复方式 | 一行代码修改 | 最小改动，不引入新风险 |
| 是否需要额外测试 | 否 | 工具注册逻辑已有 PR226 测试覆盖，本 PR 只暴露工具名 |
| 是否需要特性文档 | 是 | 项目规范要求所有 PR 都有特性文档 |

## 关联 PR

- PR #230: https://github.com/chenlaicai/otter-buddy/pull/230

---

[大獭] 🦦