---
id: F20260819m2m4
title: 记忆召回质量 minor fixes
summary: 修复 F20260812mrcq 遗留的4个 minor issue：anchor 去重、dead-letter 诊断字段、正则边界、表数量硬编码
change_type: bugfix
status: active
created_at: 2026-08-19
created_in_conversation: bbcfaa33-f036-4493-94de-3faf1c6df6cf
tags:
  - memory
  - retrieval
  - anchor
  - embedding
  - schema
modules:
  - src/usecases/memory/search-memory.ts
  - src/frameworks/db/memory/embedding-task-queue.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/usecases/memory/memory-repository.ts
  - src/frameworks/db/schema.ts
from:
  - F20260812mrcq
supersedes: []
---

# 记忆召回质量 minor fixes

## 背景

F20260812mrcq（PR #244）合并后的遗留 follow-up 项中的 4 个 minor fix。

## 改动范围

### m1: anchor 命中与 dedupAndBoostBySource 的去重

**问题**：anchor entry prepend 到 RRF 结果前，不经过 `dedupAndBoostBySource`。RRF 中若有同 sourceId 的 chunk 命中，出现 anchor summary + 同源 chunk 并列。

**修复**：anchor 组装时过滤 RRF 结果中同 sourceId 的条目。

### m2: claimPendingTasks RETURNING 加诊断字段

**问题**：dead-letter 排查缺少时间线。

**修复**：dead-letter 查询 JOIN embedding_tasks 返回 `last_attempt_at` / `created_at`。

### m3: anchor 正则 `\b` 边界

**问题**：`\b` 依赖 ASCII `\w` 定义。当前行为正确，但未来 JS 引擎若改 Unicode `\b` 可能 break。

**修复**：用 `(?<![\w])` 替代显式表达意图，或加注释说明意图。

### m4: schema.ts tables 数量硬编码

**问题**：`schema.ts:37` 日志 `tables: 12` 是硬编码，加 `embedding_tasks` 后实际已超 12。

**修复**：更新硬编码为正确数量（32 = 27 regular tables + 5 virtual tables）。

## 验证

- 所有 92 个 memory 测试通过
- TypeScript 编译通过
- ESLint 检查通过

## 关联

- 设计文档：docs/features/2026/08/12/F20260812mrcq-memory-recall-quality.md
- 实施 PR：#317
