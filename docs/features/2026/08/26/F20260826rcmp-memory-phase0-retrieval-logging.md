---
id: F20260826rcmp
title: memory-phase0-retrieval-logging
summary: 记忆系统 Phase 0 评估基线的埋点基建：search_query_logs 表 + RecordSearchQuery use case + tool 层接线。记录 search_memory 真实调用（查询 + top-5 命中 + 对话上下文快照最近 5 条），fire-and-forget 不阻断检索。落地 R20260826rcmm Phase 0 的前置依赖。
change_type: feature
status: development
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
capability_test: "n/a: 纯代码逻辑改动（埋点写入 + 接线），无 LLM 参与行为"
tags: [memory, evaluation, logging, retrieval, phase0]
modules: [entities/memory, usecases/memory, frameworks/db, interface-adapters/agent-runtime]
from: [R20260826rcmm]
---

# F20260826rcmp：记忆系统 Phase 0 检索埋点

## 背景

R20260826rcmm（三獭对抗讨论终版方案）确立「评估基线 → 召回加固 → 精益提炼」路线。Phase 0 需要真实检索数据做 recall@k 基线，但系统无任何查询日志基建（memory_weights 仅三列权重数据，无查询文本）。本特性落地埋点，是 Phase 0 的必经前置（方案原文：「埋点是必经路径而非可选」）。

搭档意图锚：
> 「既然你们方案定了，不然直接本PR按照方式实施？而不是只有一个文档」

## 目标

- T1: search_memory 每次 agent 真实调用后落一条埋点记录
- T2: 记录含查询意图还原所需上下文（对话最近 5 条消息预览快照）——标注者还原意图用，防「测标注者记忆」的选择偏差
- T3: fire-and-forget——埋点任何失败不影响检索可用性

## 非目标

- 不做 HTTP 路径埋点（MemoryController）——agent 工具路径是评估对象主路径；HTTP 留待有需求再补
- 不做读取接口——标注/统计阶段直接 SQL 查表（一次性评估流程）
- 不做埋点开关配置——INSERT 成本极低，评估期常开；评估结束可整表 DROP

## 方案设计

### 数据流

```
agent 调 search_memory 工具
  → tool-factory.ts execute（有 ctx.conversationId / ctx.otterId）
  → 检索主流程（原逻辑不动）
  → ctx.client.memory.logSearch(...)  ← 埋点（fire-and-forget）
  → bootstrap/clients.ts → RecordSearchQuery.record()
  → 取对话最近 5 条消息预览（QueryMessage.getMessages DESC → reverse 正序）
  → SqliteSearchQueryLogRepository.insert → search_query_logs 表
```

### 表结构（schema.ts，CREATE IF NOT EXISTS）

```sql
search_query_logs (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  caller_id TEXT,              -- 发起 Otter（agent 路径）；HTTP 为 null
  detail_level / library / limit_count TEXT|INTEGER,  -- 检索参数快照
  top_entry_ids TEXT NOT NULL, -- JSON 数组，截前 5（recall@5 标注够用）
  total INTEGER NOT NULL,
  context_messages TEXT NOT NULL, -- JSON：[{id, senderId, role, preview≤160}]
  created_at TEXT NOT NULL
)
```

### 关键设计决策

| 决策 | 理由 |
|---|---|
| 挂 tool 层而非 client 层 | OtterToolClient 是单例，拿不到 per-request 上下文；tool 的 ToolContext 才有 conversationId/otterId |
| fire-and-forget（usecase 内 catch + warn） | 埋点失败只丢评估数据，不可影响检索可用性 |
| 上下文 5 条 × 160 字符预览 | 意图还原够用 + 控制行体积；不存全文（messages 表有） |
| topEntryIds 截前 5 | recall@5 是核心基线指标；@10 可后续重放（查询可复现） |
| JSON 存 TEXT 不拆表 | 一次性评估流程，避免过度设计 |

## 影响范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/db/schema.ts | 修改 | +search_query_logs 表 |
| src/entities/memory/search-query-log.ts | 新增 | 实体 + 上下文消息快照类型 |
| src/usecases/memory/search-query-log-repository.ts | 新增 | 写入 port |
| src/usecases/memory/record-search-query.ts | 新增 | use case（上下文构建 + fire-and-forget） |
| src/frameworks/db/memory/sqlite-search-query-log-repository.ts | 新增 | SQLite 实现 |
| src/usecases/ports/otter-tool-client.ts | 修改 | memory 域 +logSearch 方法 |
| src/bootstrap/{repositories,types,usecases,clients}.ts | 修改 | 接线 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | search_memory execute 挂埋点 |
| tests/frameworks/db/memory/search-query-log.test.ts | 新增 | 集成测试 4 例 |
| tests/interface-adapters/search-memory-tool.test.ts | 修改 | mock 补 logSearch |

## 验证

- 集成测试：落表 + JSON 序列化、上下文快照（最近 5 条正序 + 截断 160）、topEntryIds 截前 5、fire-and-forget 不抛、空上下文
- 全量回归：138 files / 1640 tests 通过
- tsc --noEmit 通过

## 验收（Phase 0 数据侧）

埋点上线后积累 7-14 天 → 去重查询 50-100 条 → 双人标注（Kappa ≥ 0.6）→ recall@5/10 + MRR + 失败分类。标注脚本不在本 PR 范围（数据积累完成后按需开发）。
