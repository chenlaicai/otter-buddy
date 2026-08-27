---
id: F20260827mpcg
title: memory-chunk-pollution-guard
doc_type: feature
summary: |
  修复 issue #509：memory 检索结果空 chunk 污染（43% 条目 content 空/单字符）+ 同文档重复 chunk 双份入库。
  三层防线：(1) StoreMemory 入库前空 content 拦截（execute/replaceBySource）；(2) chunk 批量路径超短 content 过滤 + char_count 与 cleaned content 一致性告警；(3) replaceEntriesBySource 幂等性回归测试锁定。
  附一次性存量清理脚本 scripts/cleanup-memory-pollution.mjs（dry-run 默认，--apply 才执行，自动备份）。

causal_links:
  from:
    - R20260826rcmm

status: development
change_type: fix
tags: [memory, chunking, data-quality, regression-guard]
modules:
  - src/usecases/memory/store-memory.ts
  - tests/usecases/memory/store-memory.test.ts
  - tests/frameworks/db/memory/replace-entries-idempotency.test.ts
  - scripts/cleanup-memory-pollution.mjs
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_at: 2026-08-27T11:32:00+08:00
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F20260827mpcg: memory chunk 污染防线（issue #509）

## 背景与需求

### 问题描述（issue #509 实证，2026-08-26）

daily-review 例行 memory 检索（created_after=8-26 过滤，30 条结果）中：

- **13/30 条（43%）content 为空或近空**：`.`、`A.`、`\n`、`2.`（单字符）
- **同文档同 chunk 双份入库**：otter-create-unify 的 chunk_4 两条（10:24 与 10:38，内容相同）、F20260826ybx6 的 chunk_0 两条（02:04 与 02:47，内容相同）
- 对照组：8-18 入库的 chunk content 完整——不是必然行为，像 8-26 前后新引入或暴露的缺陷

关键样本 `833391fa`：metadata.char_count=933 但 content=`2.`——**元数据与实际 content 严重不符**，指向提取/写入链路存在截断可能。

### 排查结论（2026-08-27，珊瑚）

**生产 DB 实测（data/otter-buddy.db，267MB）与 issue 现象有出入，需如实记录**：

1. 当前 DB 中 `833391fa` 的 content 实为完整 847 字符的「2.3 验收」表格内容（length=847），不是 issue 截图中的 `2.`；`962c4b80`/`707ac5c3` 实为 2021 字符的完整消息——issue 取数时的"空"现象在当前 DB 已不复现。怀疑 issue 取证时的查询路径（search_memory 服务层或当时尚未合入的中间版本）与存储层存在过不一致，当前存储层是干净的。
2. **重复 chunk 实证属实**：`2b4fe75f`(F20260826ocui)/`ddd5fe55`(F20260826ucrt) 同 chunk_4 同内容并存；`9351e24f`(F2026082650eb)/`da68a7d7`(F20260826ybx6) 同 chunk_0 同内容并存。根因是**文档文件改 ID 重入**（不同 worktree 并行工作流各自生成 ID 撞车，文件改名后旧 ID 条目未被清理）。`replaceEntriesBySource` 按 source_id 原子替换本身无 bug，但对"同内容不同 source_id"天然免疫不了。
3. 历史脏数据：181 条孤儿 chunk（源文档已 archived）残留。

**结论**：存储层原子替换逻辑本身正确，但**入库防线整体缺失**——任何空/近空 content 都能无感写入，重复/截断内容只能靠事后对账发现。修复方向从"修某个具体截断 bug"转为"建立入库质量防线 + 幂等性回归锁定 + 存量清理"。

## 方案设计

### 三层防线

**防线 1：StoreMemory 入口空 content 拦截**（`src/usecases/memory/store-memory.ts`）

- `execute` / `replaceBySource` 写入前校验 `content.trim().length === 0` → 抛 `PollutedContentError`
- 阈值只拦"空"：短消息（"继续"、"ok"）是合法内容，初版用 `<10 字符` 拦截误伤了存量测试（"用户询问了天气情况"=9 字符），已收窄
- `replaceChunksBySource`（chunk 批量路径）额外用 `<10 字符` 过滤：文档段落 <10 字符无检索价值；部分污染不拖累整批，被过滤的 chunk 记 warn 日志（`polluted_chunk_dropped`）

**防线 2：char_count 一致性告警**

- `replaceChunksBySource` 内校验 `metadata.char_count`（raw markdown 字符数）与 cleaned content 长度：char_count > 10 且 cleaned < char_count × 20% 时记 warn（`chunk_char_count_mismatch`），不拦截
- 这是 `833391fa` 型缺陷（char_count=933 vs content=`2.`）的兜底感知——即使提取层未来再出截断 bug，写入时能立刻被日志抓到

**防线 3：幂等性回归测试**（`tests/frameworks/db/memory/replace-entries-idempotency.test.ts`，真 sqlite :memory:）

- 同 source_id 连续两次 replace → DB 中无重复 chunk，内容为第二版
- reindex 后 chunk 数变化（文档精简）→ 旧多余 chunk 被清理
- 单事务语义锁定（删旧+插新原子，不留空窗）
- M1 混合 source 校验不回归

### 存量清理（`scripts/cleanup-memory-pollution.mjs`）

一次性运维脚本，三类扫描：

| 类 | 内容 | 默认行为 |
|---|---|---|
| A | 空/纯空白 content 条目 | `--apply` 清理 |
| B | 同 (source, chunk_index) 重复副本，保留最新 | `--apply` 清理 |
| C | 孤儿 chunk（源文档 archived） | 仅报告，`--prune-orphans` 才清理（历史价值保守） |

安全设计：默认 dry-run；`--apply` 执行前自动备份 DB 文件（`.bak-<timestamp>`）；删除走单事务 + 联动清理（fts_jieba/vec/weights/edges/embedding_tasks），与 `cascadeDeleteSatellites` 语义一致；vec0 虚拟表在裸连接不可操作时降级跳过（残留向量随下次 reindex 自愈）。

**执行状态（诚实声明）**：脚本随 PR 附带，但**未在生产 DB 执行**——DB 数据变更需大獭/搭档确认后运维窗口执行。当前生产 DB 实测 A/B 类为 0（8-27 上午主库干净），C 类 181 条孤儿 chunk 待决策。

### 边界与遗留（Discovered Issues）

**文档 ID 撞车（重复 chunk 的真正根因）**：`F2026082650eb`→`F20260826ybx6`、`F20260826ocui`→`F20260826ucrt` 两组重复都是"同一文档文件在不同 worktree 被赋予不同 ID"导致。这是流程层缺陷（跨 worktree 的 LLM 自编号无协调机制），代码层无法根治。已在 issue #509 关联记录；建议后续在 requirement-analysis / code-implementation skill 中加"生成特性 ID 前先查 DB/磁盘是否已有同 title 文档"的引导步骤，或建 ID 分配登记机制。本 PR 不展开。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/memory/store-memory.ts | 修改 | PollutedContentError + assertValidContent + chunk 批量路径过滤/告警 |
| tests/usecases/memory/store-memory.test.ts | 修改 | +6 防线用例；改造 1 个旧用例（空字符串语义被防线取代） |
| tests/frameworks/db/memory/replace-entries-idempotency.test.ts | 新建 | 4 个幂等性集成用例（真 sqlite） |
| scripts/cleanup-memory-pollution.mjs | 新建 | 存量清理一次性脚本 |
| docs/features/2026/08/27/F20260827509f-memory-chunk-pollution-guard.md | 新建 | 本文档 |

## 验证

- 新增/改造测试 11 个全部通过；全量回归 149 文件 / 1757 用例通过（2026-08-27 11:29）
- 清理脚本 dry-run 实测生产 DB 副本：A=0、B=0、C=181（与 SQL 直查一致）
- 清理脚本 --apply 在注入 3 条模拟污染的 DB 副本上验证：正确保留最新副本、删除空条目、备份文件生成

## 关联

- Fixes #509
- 关联 #485（sync_docs UNIQUE constraint 报错）：排查结论——#485 是 feature 主档 upsert 的 UNIQUE 冲突，与本 issue 的 chunk 层不同表不同路径，非同根因；但两者共享"入库层缺少防御"的主题。本 PR 防线对 #485 场景无直接作用。
- R20260826rcmm / PR #482：召回加固评估基线受益（污染条目不再稀释信噪比）
