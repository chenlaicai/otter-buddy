---
id: F20260902rcp1
title: 记忆召回 Phase 1：分词双写 + 层配额 + 半衰期分层——doc summary 召回修复
change_type: feature
status: implemented
created: 2026-09-02
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
modules:
  - src/frameworks/db/jieba-tokenizer.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/migration.ts
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - src/frameworks/config-service.ts
  - scripts/phase1-recall-check.mjs
summary: Phase 0 基线实测零召回 76.3%（306 条真实查询）。三根因修复：jieba cut(x,false) 在 @node-rs/jieba 2.x 无词典致中文全单字化（词典词「健康」索引命中 0 行）→ 双写索引+词典词查询；message 层 11.6 倍量差稀释 doc summary → 层配额保底（limit≥6 保 2 席，去重豁免）；半衰期 7 天压制老文档（30 天文档权重仅 5%）→ document 层 90 天。验收 recall@10 0.046→0.336，零召回 76.3%→26%，doc 层 0.444（目标 ≥0.25 超额达成）。
tags: [memory, retrieval, fts, jieba, rrf, phase1, recall]
capability_test: tests/usecases/memory/phase1-recall-fix.test.ts
from: [R20260826rcmm]
---

# 记忆召回 Phase 1：doc summary 层召回修复

## 变更说明

R20260826rcmm Phase 1 首个 PR。Phase 0 基线（issue #493，306 条真实查询）实测三个叠加根因，本 PR 一并修复：

### Fix 1：分词双写（根因 1，最严重）

**问题**：`@node-rs/jieba` 2.x 的 `cut(text, false)` 第二参数是 `useHmm`——false 时词典不参与，中文全部退化为单字。索引与查询双侧单字化后，词典词「健康」在整个 FTS 索引命中 0 行、「架构」6 行；单字「面」命中 1359 行，BM25 区分度坍塌。文档 ID（F20260829hviz）与英文词不受影响——这解释了 Phase 0 中「文档 ID 直查是唯一干净路径」。

**修复**：
- `tokenizeWithJieba(text, {doubleWrite: true})`：索引侧写「词典词序列 + 全单字序列」两份
- `tokenizeQuery`：查询侧改 `cut(query, true)` 产出词典词
- `migration.ts` 新增一次性补丁 `rebuildMemoryFtsJiebaDoubleWrite`：settings 表幂等键 `fts_jieba_double_write=done`，事务内全量重建（沿用 rebuildMessagesFtsStripped 模式）
- 已知局限：HMM 切词错误（「小龙虾」→「小龙」「虾」）双写不能纠正——后续自定义词典演进（审视发现 6）

### Fix 2：检索层配额（根因 2）

**问题**：message 层 5058 条 vs feature summary 433 条（11.6:1），自然语言查询 FTS top60 中 doc summary 仅 7 席，RRF 后基本绝迹；且 `dedupAndBoostBySource` 的 chunk-priority（PR审视 M5）会把同源 doc summary 丢掉。

**修复**：`applyLayerQuota(sorted, limit)`——dedup 排序后、slice 前：
- 触发：top-N 中 doc summary（feature/research doc-level）< 配额且命中集中存在
- 配额：limit ≥ 6 保 2 席，limit < 6 保 1 席（防小 limit 挤占）
- 替换：从尾部向前替换非 doc-summary 条目
- 去重豁免：doc summary 即使同源 chunk 已在结果中也插入（概览与正文并列是预期行为）

### Fix 3：半衰期分层（根因 3）

**问题**：`weightHalfLifeDays: 7` 下 30 天文档权重 5%、90 天文档 0.1%——「找历史特性」类查询永久出局。

**修复**：`computeTimeDecay(createdAt, halfLifeDays?)` 可选参数；`rerank` 按 `contentType ∈ {feature, research, feature_chunk, research_chunk}` 分流 90 天（`weightHalfLifeDaysDocument` 可配），其余层维持 7 天。time_decay 动态计算不落数据库，纯算法变更无迁移。
- 僵尸文档防护（TTL guard maxAge=365 权重归零）记为演进方向，当前库内最老文档 30 天未触发（审视发现 5）

## 验证

- **单测**：`tests/usecases/memory/phase1-recall-fix.test.ts` 8 用例（双写格式/词典词查询/停用词/英文与文档ID 兼容/90 天与 7 天衰减数值/rerank 分层混排/feature_chunk 分层）
- **全量**：224 文件 2823/2823 绿，tsc + lint 通过
- **验收脚本**（`scripts/phase1-recall-check.mjs`，副本库模拟双写重建后跑 Phase 0 全量 306 条）：
  | 指标 | 修复前 | 修复后 |
  |---|---|---|
  | recall@5 | 0.046 | **0.209** |
  | recall@10 | 0.046 | **0.336**（验收线 ≥0.25 超额） |
  | 零召回 | 76.3% | **26.0%** |
  | doc 层 recall@10 | 0.043 | **0.444** |
  注：脚本复现 FTS 单路（vec 路径行为不变），指标为下界
- **最简实现检查**：已过——无新依赖（sqlite-vec/jieba 均已有）；双写是 tokenizeWithJieba 内部选项非新函数；层配额单方法不动 RRF 算法层；半衰期是参数扩展非新管线。备选的「权重加成+保底检测」混合方案因硬配额一次达标（0.444 > 0.25）无需启用
- **索引体积**：重建后 14,747 行（原 14,690），原文长度比 ×3.25，FTS5 字典去重后磁盘膨胀需生产 migration 后实测（dbstat 前后对比待部署时回填）

## 设计方案与审视链

- 设计文档：对话工作区 `F20260902rcp1-plan.md`（含 v2 修订与审视记录）
- 对抗审视：检视獭-rcp1（mimo 异模型）一轮 3 严重 + 4 建议，全部采纳处置；delta 复核通过
  - 严重 1 迁移幂等 → settings 键模式（本 PR migration.ts:292）
  - 严重 2 半衰期路径 → computeTimeDecay 可选参数（search-engine.ts:176）
  - 严重 3 层配额去重冲突 → 去重豁免（search-memory.ts applyLayerQuota）

## 对旧特性的影响

- `dedupAndBoostBySource`（F20260803chunk）行为不变——配额在其后叠加
- `preAggregateFtsBySource`（F20260803chunk M6）不变——B6 的 contentType 分组键与双写正交
- 8/26 上线的检索埋点（search_query_logs，PR #482）不受影响——埋点在 usecase 层
