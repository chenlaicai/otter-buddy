---
id: F20260825b424
title: "manage_healing_events 批量 resolve by filter"
summary: |
  manage_healing_events 工具新增 batch_resolve action，支持按 filter 条件（status/errorType/日期范围）
  批量 resolve healing events，含 dryRun 预览和单批 100 上限。解决 8/25 健康检查逐条 resolve 漏事件的问题。
change_type: feature
status: active
capability_test: "n/a: 纯 A 类改动（SQL + 工具参数），无 LLM 行为依赖"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [healing, batch, tool]
modules:
  - src/interface-adapters/agent-runtime/tools/healing-tools.ts
  - src/frameworks/db/healing/sqlite-healing-event-repository.ts
  - src/usecases/healing/healing-event-repository.ts
from: []
supersedes: []
---

## 背景

8/25 健康检查批量处置 14 起 healing events 时靠逐条 resolve 漏了 1 起，暴露批量操作缺工具支撑。现 `manage_healing_events` 工具只支持 `query`（查询）+ `resolve`/`dismiss`（按 ID 列表逐条操作），没有按 filter 批量 resolve 的能力。

## 方案设计

### 新增 action: `batch_resolve`

在 `manage_healing_events` 工具中新增 `batch_resolve` action，支持按 filter 条件批量 resolve，替代逐条 ID 操作。

**Filter 参数**：
- `filterStatus` — 按状态筛选（默认 `open`）
- `filterErrorType` — 按错误类型筛选
- `filterCreatedBefore` — ISO 时间戳，筛选 `created_at < 此值` 的事件
- `filterCreatedAfter` — ISO 时间戳，筛选 `created_at > 此值` 的事件

所有 filter 条件 AND 组合。

**安全机制**：
- `dryRun: true` — 只返回匹配事件数，不执行 resolve（预览模式）
- `limit: 100` — 单批上限 100，防止误伤

### 跨层改动

| 层 | 文件 | 改动 |
|---|---|---|
| Repository 接口 | `healing-event-repository.ts` | 新增 `HealingEventBatchFilter` 接口 + `batchResolveByFilter` 方法 |
| SQLite 实现 | `sqlite-healing-event-repository.ts` | 动态 SQL WHERE 子句 + 单事务保证原子性 |
| Tool 层 | `healing-tools.ts` | 新增 `batch_resolve` action + 参数描述更新 |

### 设计取舍

1. **dryRun 默认 false**：工具主打「一键处置」，预览是可选行为
2. **单批上限 100**：足够覆盖日常场景，防止 filter 写错时误伤全部事件
3. **原子性**：SQLite `transaction()` 保证 match + update 原子，避免 match 和 update 之间数据变化
4. **参数命名用 `filterXxx` 前缀**：与现有 `status`/`errorType` 参数区分，避免 query 和 batch_resolve 参数混淆

## 涉及文件

- `src/usecases/healing/healing-event-repository.ts` — 接口新增
- `src/frameworks/db/healing/sqlite-healing-event-repository.ts` — SQLite 实现
- `src/interface-adapters/agent-runtime/tools/healing-tools.ts` — 工具层
- `tests/frameworks/db/healing/sqlite-healing-event-repository-batch.test.ts` — 新增测试
- `tests/interface-adapters/agent-invoker-self-restart.test.ts` — mock 补齐新接口方法

## 测试覆盖

| 场景 | 断言 |
|---|---|
| dryRun 返回匹配数不修改数据库 | matched=2, resolved=0, DB 未变 |
| 批量 resolve 所有 open 事件 | matched=2, resolved=2 |
| 按 errorType 过滤 | 仅 tool_failure 类型被 resolve |
| 按 createdBefore 过滤 | 仅旧事件被 resolve |
| 按 createdAfter 过滤 | 仅新事件被 resolve |
| 组合 filter (errorType + createdBefore) | 精确匹配 1 条 |
| 空结果 | matched=0, resolved=0 |
| limit 上限生效 + truncated 标志 | 创建 5 条，limit=3，resolve 3 条，truncated=true，totalMatched=5 |
| 未截断时 truncated=false | 2 条未超限，truncated=false |
| resolution 数据正确写入 | action/notes/resolvedAt 均正确 |
| 已 resolved 事件不被重复处理 | 仅 open 事件被处理 |
| 非法 ISO 日期被拒绝 | filterCreatedBefore="garbage" 返回 isError |
| 工具层 dryRun 参数映射 | dryRun=true 时不落库 |
| 工具层 150 条 truncated | matched=100, totalMatched=150, truncated=true |
| 工具层 filterErrorType 映射 | 仅匹配类型被 resolve |

Refs #424
