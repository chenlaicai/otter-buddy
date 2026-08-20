---
id: F20260820e3rt
title: memory-repo-consumer-switch
doc_type: feature

summary: |
  MemoryRepository 三分 Phase 2：消费者切换 + 共享类型提取。
  将 9 个消费者文件从 MemoryRepository 切换到窄接口（MemoryReader/MemoryWriter/MemoryQueue），
  并提取共享类型到 memory-types.ts 消除反向依赖。

causal_links:
  from:
    - F20260817a3rt

status: development
change_type: refactor
tags: [memory, port, refactor, clean-architecture]
modules:
  - src/usecases/memory/
  - src/bootstrap/types.ts
capability_test: "n/a: 纯代码逻辑重构（A 类），行为等价"
---

# F20260820e3rt: MemoryRepository 三分 Phase 2——消费者切换 + 共享类型提取

## 背景

F20260817a3rt（PR #327）完成了 MemoryRepository 的接口拆分（Phase 1），定义了三个窄接口：
- **MemoryReader**：查询、检索、获取权重/详情
- **MemoryWriter**：存储、更新、删除、创建/删除边
- **MemoryQueue**：embedding 重试队列操作

Phase 2 的目标是将消费者从 MemoryRepository 切换到窄接口，并提取共享类型消除反向依赖。

## 实现内容

### 建议 3 — 消费者切换

9 个文件全部从 MemoryRepository 切换到窄接口：

| 文件 | 切换到 | 理由 |
|------|--------|------|
| get-doc-provenance.ts | Reader | 只读取记忆条目 |
| get-related.ts | Reader | 只读取边和邻居 |
| scan-dark-entries.ts | Reader | 只扫描暗化条目 |
| delete-edge.ts | Writer | 只删除边 |
| create-edge.ts | Reader + Writer | 读取边 + 创建边 |
| manage-memory.ts | Reader + Writer | 管理记忆生命周期 |
| search-memory.ts | Reader + Writer | 检索 + 更新权重 |
| store-memory.ts | Writer + Queue | 存储 + 入队重试 |
| embedding-retry-worker.ts | Reader + Writer + Queue | 读取 + 更新 + 出队 |

### 建议 4 — 共享类型提取

新增 `memory-types.ts`，提取以下类型：
- SearchFilters
- FTSHit
- SnippetHit
- VecHit
- DarkEntry
- RetrievalSource

消除 `memory-reader.ts` 对 `memory-repository.ts` 的反向依赖，`memory-repository.ts` 保留 re-export（向后兼容）。

### DI 层更新

`Repositories` 接口新增 `memoryReader`/`memoryWriter`/`memoryQueue`，同一实例暴露。

## 改动范围

| 文件 | 操作 |
|------|------|
| src/usecases/memory/memory-types.ts | 新建（共享类型） |
| src/usecases/memory/memory-reader.ts | 更新 import |
| src/usecases/memory/memory-writer.ts | 更新 import |
| src/usecases/memory/memory-queue.ts | 更新 import |
| src/usecases/memory/memory-repository.ts | 保留 re-export |
| src/usecases/memory/create-edge.ts | 切换到 Reader + Writer |
| src/usecases/memory/delete-edge.ts | 切换到 Writer |
| src/usecases/memory/embedding-retry-worker.ts | 切换到 Reader + Writer + Queue |
| src/usecases/memory/get-doc-provenance.ts | 切换到 Reader |
| src/usecases/memory/get-related.ts | 切换到 Reader |
| src/usecases/memory/manage-memory.ts | 切换到 Reader + Writer |
| src/usecases/memory/scan-dark-entries.ts | 切换到 Reader |
| src/usecases/memory/search-memory.ts | 切换到 Reader + Writer |
| src/usecases/memory/store-memory.ts | 切换到 Writer + Queue |
| src/bootstrap/types.ts | 新增窄接口字段 |
| src/bootstrap/repositories.ts | 同一实例暴露 |
| tests/usecases/memory/*.test.ts | 更新 mock 构造函数 |

## 验收结果

- `npx tsc --noEmit`：零错误
- `vitest run`：1260 tests, 107 files, 0 failures
- 行为等价（零运行时变更，纯机械重构）
- 共享类型提取消除反向依赖
- DI 层向后兼容（repos.memory 字段保留）

## 对抗审视记录

待审视。

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-20 | 初始版本 |
