---
id: F20260916q965
title: 层配额候选修复：dedup chunk-priority 吃掉候选池致配额从未生效（#965）
change_type: fix
status: implemented
created: 2026-09-16
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
modules:
  - src/usecases/memory/search-memory.ts
summary: #723 的层配额自 9/2 合入以来从未触发——管线顺序 scored → dedup（chunk-priority）→ applyLayerQuota(deduped)，dedup 把同源 doc summary 丢掉后配额候选池从 deduped 取永远为空。修复：候选改从 dedup 前 scored 取（含被 chunk 吃掉的 summary），排除已在 top-N 的条目；候选按 finalScore 降序排序（rerank 不保证顺序）。验收：20 条 9/3-9/15 真实查询修复前配额触发 0 → 修复后 13 次，doc summary 进 top 14/20。
tags: [memory, retrieval, layer-quota, bug, phase1]
capability_test: tests/usecases/memory/search-memory.test.ts
from: [F20260902rcp1]
---

# 层配额候选修复（#965）

## 变更说明

#723（F20260902rcp1）的层配额自 9/2 合入以来**从未真正触发**。9/16 线上复测（搭档连环质疑驱动）实锤根因：

- 管线顺序：`scored → dedupAndBoostBySource（chunk-priority）→ applyLayerQuota(deduped)`
- dedup 同源组优先选 chunk 做代表，doc summary 被直接丢弃
- `applyLayerQuota` 候选从 `sorted.slice(limit)`（deduped 结果）取——**summary 已被 chunk 吃掉，候选池为空**
- 实测：10 条 9/3-9/15 查询 6 条 scored 有 summary 但 dedup 后消失；配额候选为空 5/10

**修复**：
1. 候选改从 **dedup 前的 scored** 取（`preDedupScored` 参数），含被 chunk 吃掉的 summary；排除已在 top-N 的条目（`inTopIds` 按 entryId）防重复
2. **审视修复**：候选按 `finalScore` 降序排序——`rerank` 不保证返回顺序（Map 迭代序），`candidates.shift()` 原会取到任意首个而非最优

9/15 18:19 后 doc summary 39% 命中的真实来源是**半衰期分层**（文档层 90 天权重提升），配额贡献为 0。本 PR 后配额真正上线。

## 验证

- 全量 256 文件 3089/3089 绿，tsc + lint 0 error
- **验收实测**：20 条 9/3-9/15 真实查询重跑——修复前配额可触发 0 次（候选为空），修复后 **13 次可触发**，doc summary 进 top 查询 14/20
- 对抗审视（检视獭-965，mimo）：1 严重（特性文档缺失，本文件补齐）+ 2 建议（候选排序 ✅ 已修 / 独立单测转 #729）
- **最简实现检查**：已过——单方法签名扩展（可选参数），无新依赖无新配置；候选排序一行

## 对旧特性的影响

- `dedupAndBoostBySource`（F20260803chunk）行为不变——配额在其后叠加，候选池来源修正不影响 dedup 本身
- #729 follow-up（层配额独立单测/searchSimilar 配额开关/migration guard）仍 OPEN，本 PR 不覆盖
