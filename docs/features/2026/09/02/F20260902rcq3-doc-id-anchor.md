---
id: F20260902rcq3
title: 记忆召回 Phase 1·三：doc ID 锚点注入——文档编号直查可命中
change_type: feature
status: implemented
created: 2026-09-02
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
modules:
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/migration.ts
summary: PR #723 后复测残留 79 条零召回的归因发现新根因：文档类条目（feature/research）正文不含自身编号，查「F20260829raft」时确定性最强的目标反而 miss（12/79 条）。修复：FTS 索引写入时注入 sourceId 前缀（只进 FTS 不改 content 本体），migration 幂等键升级 v2 全量重建。验收：F20260829raft 命中 0→6 行。rcq2（查询改写）同轮归因后优先级下调为观察项（49/79 条 context 可桥接但 #723 已覆盖大半词汇鸿沟）。
tags: [memory, retrieval, fts, doc-id, anchor, phase1]
capability_test: tests/frameworks/db/memory/doc-id-anchor.test.ts
from: [R20260826rcmm, F20260902rcp1]
---

# 记忆召回 Phase 1·三：doc ID 锚点注入

## 变更说明

#723 合入后对 306 条 Phase 0 查询复测：零召回 76.3%→26.3%（79 条）。逐条归因发现三类残留：

| 残留类别 | 条数 | 处置 |
|---|---|---|
| **ID 锚点缺失** | 12 | **本 PR 修复** |
| context 可桥接（词汇鸿沟） | 49 | rcq2 查询改写的靶子——优先级下调为观察项（搭档质疑「渐进式检索已覆盖大部分」成立：120 条鸿沟在 #723 后仅剩 49 条） |
| 泛化查询/标注争议 | 18 | 修不动，接受 |

**ID 锚点缺失的机制**：文档类条目（feature/research）的正文通常不含自己的编号（F20260829raft 的正文只讲「海獭 raft 意象设计」）。检索「F20260829raft」时 FTS 只能命中对话里提到过这个编号的 message——确定性最强的目标（文档本身）反而 miss。实测 F20260829qsref：FTS 命中 3 行全是 message，理想 feature 行排名 0。

**修复**：`insertEntryRow` 的 FTS 写入分支——sourceTable ∈ {features, research} 且 sourceId 匹配 `^[FR]\d{8}[a-z0-9]{4}$` 时，FTS 文本注入 `${sourceId} ${content}` 前缀。**只改 FTS 索引内容，content 本体/metadata 不动**（渐进式披露的 content 投影不受影响）。

**存量迁移**：`rebuildMemoryFtsJiebaDoubleWrite` 幂等键从 `done` 升级 `v2`——已跑过 v1 的库重跑一次注入锚点（v1→v2 幂等判断，v2 后跳过）。

## 验证

- **单测**（3 用例全绿）：feature 注入命中 / research 注入命中 + message 不注入 / content 本体不变
- **回归**：tests/frameworks/db + tests/usecases/memory 共 372/372 绿，tsc 0 error
- **验收**（副本库模拟 v2 重建）：「F20260829raft」FTS 命中 0→6、「F20260829qsref」3（含理想 feature 行）、「R20260829hidx」19
- **最简实现检查**：已过——单点改动（insertEntryRow 一处 + migration 同逻辑），无新依赖无新配置；rcq2 的 LLM 改写方案（F20260902rcq2-plan.md）留档不删，等线上复测数据再决定

## 对旧特性的影响

- #723 的双写逻辑不变（锚点注入在双写之前拼接原文）
- 层配额/半衰期分层与本变更正交
- content 投影链（buildSnippet/渐进式披露）不受影响——FTS 行与 content 解耦
