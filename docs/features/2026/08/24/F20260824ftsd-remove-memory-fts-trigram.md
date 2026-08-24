---
id: F20260824ftsd
title: 删除 memory_fts trigram 表的无用写入路径
summary: |
  memory_fts（trigram 分词表）自 F20260805hybrid 引入 jieba 分词后只写不查，
  每条记忆白写一份 FTS 索引。移除 schema 定义 + INSERT/DELETE 路径 + 测试引用。
change_type: refactor
status: implemented
capability_test: "n/a: 纯死代码清理，无新增功能行为，搜索行为由现有 search-memory 测试覆盖"
created_in_conversation: d88f66dc-07f0-457a-a9f9-341a9e13fdd9
tags:
  - memory
  - fts
  - trigram
  - tech-debt
modules:
  - src/frameworks/db/schema.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/migration.ts
  - tests/frameworks/db/memory/created-after-filter.test.ts
  - tests/usecases/memory/search-memory.test.ts
  - tests/usecases/memory/embedding-retry-worker.test.ts
---

# 删除 memory_fts trigram 表的无用写入路径

## 背景与需求

### 问题描述

`src/frameworks/db/schema.ts` 定义了 `memory_fts`（trigram 分词 FTS5 虚拟表），`insertEntryRow` 每条记忆 entry 同时写 `memory_fts` 和 `memory_fts_jieba` 两张表；但检索路径（`sqlite-memory-repository.ts` 的 `searchFtsJiebaRows`）**只查 jieba 表**，trigram 表零读取。

现场数据：
- 生产库 `memory_fts` 与 `memory_fts_jieba` 行数一致（4244/4244）
- `memory_fts` 从未被查询，零消费方

### 根因分析

F20260805hybrid 引入 jieba 分词表后，trigram 表被 jieba 完全替代，但写入和删除路径未同步清理，导致：
- 每条 entry 白写一份 FTS 索引（写入放大 + 磁盘占用）
- 级联删除中包含无用的 trigram DELETE 操作

## 设计方案

### 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 处置方向 | 删除 trigram 写入 + schema | trigram 表零查询，jieba 完全替代，保留无意义 |
| 旧库残留表 | 不主动 DROP | 残留表零读零写，自然废弃，DROP 有迁移成本且无收益 |
| schema 注释 | 标注 F370 移除原因 | 留审计线索，避免后人疑惑为何只有 jieba |

### 改动范围

| 文件 | 改动 |
|------|------|
| `schema.ts` | 移除 `memory_fts` CREATE TABLE 语句，添加移除原因注释 |
| `sqlite-memory-repository.ts` | 移除 `store()` 中 INSERT、`cascadeDeleteSatellites()` 中 DELETE，更新 JSDoc |
| `migration.ts` | 移除 `migrateFeatureBodyToChunks()` 中 DELETE |
| `created-after-filter.test.ts` | 移除 FTS 重建中的 memory_fts 操作 |
| `search-memory.test.ts` | 移除 seed 函数中 memory_fts INSERT |
| `embedding-retry-worker.test.ts` | 移除 beforeEach 和 helper 中 memory_fts 引用 |

## 已知边界

1. **旧库残留表**：已存在的 `memory_fts` 表不会被 DROP，零读零写自然废弃，不影响功能
2. **迁移路径一致性**：`cascadeDeleteSatellites` 与 `migrateFeatureBodyToChunks` 两处级联删除列表已同步移除 memory_fts

## 关联

- Issue: [#370](https://github.com/chenlaicai/otter-buddy/issues/370)
- PR: [#408](https://github.com/chenlaicai/otter-buddy/pull/408)
- 引入历史: F20260805hybrid（jieba 分词表上线时 trigram 表被替代）
