---
id: F20260803body
title: doc-body-index
doc_type: feature

summary: |
  Task B（Issue #124）：特性文档正文索引到 memory_fts。当前 indexFeature 只索引 summary，正文不进 FTS，导致"文档入库但搜不到正文内容"。本 F 为 stub，待 F20260803mval 合并后展开设计。

causal_links:
  from:
    - F20260803mval

status: proposed
change_type: feature
tags: [memory, document-sync, fts, body-index]
modules:
  - src/usecases/document/sync-documents.ts
  - src/main.ts

created_at: 2026-08-03
---

# F20260803body 特性文档正文索引（Task B stub）

## 背景

F20260803mval 修复了 validator/DB CHECK/内容漂移三层断裂，但断点2（正文不索引）未修。`indexFeature` 只传 summary，正文不进 memory_fts，导致搜正文关键词（如"提示词优化"出现在 F20260727b3ka 正文第 70 行）无果。

## 待设计

- indexFeature 签名扩展接收 summary + body
- 正文分段或截断策略（正文可能很长）
- metadata 保留 source 定位（文件路径 + 段落位置）
- 健康端点增加 FTS 覆盖率字段（F20260803mval 健康端点的延伸）

## 关联

- Issue #124 Task B
- F20260803mval（本 F 的前置，修复 validator/DB/对账链路）
