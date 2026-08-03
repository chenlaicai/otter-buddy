---
id: F20260803embd
title: embedding-offline
doc_type: feature

summary: |
  Task C（Issue #124）：embedding 模型离线加载。当前 bge-m3 从 HuggingFace 下载 fetch failed，vec 路永远空，语义检索失效。F20260803mval 已修复 worker error 重置 ready（健康端点不再误报），但模型加载本身仍失败。本 F 为 stub，待展开设计。

causal_links:
  from:
    - F20260803mval

status: proposed
change_type: feature
tags: [memory, embedding, offline, bge-m3]
modules:
  - src/frameworks/embedding/bge-m3-worker.ts
  - src/frameworks/embedding/embedding-service.ts
  - config/config.yaml

created_at: 2026-08-03
---

# F20260803embd embedding 模型离线加载（Task C stub）

## 背景

F20260803mval 修复了 embedding worker error 重置 readyState.ready（健康端点不再误报 embedding 可用），但 embedding 模型本身加载失败（bge-m3 从 HuggingFace `fetch failed`）未修。`memory_vec` 表 0 行，vec 搜索路永远空，语义检索完全不可用，RRF 融合实际只有 FTS 单路。

## 待设计

- 预下载 bge-m3 到本地路径，config 指向本地
- 或配置 HuggingFace 镜像/代理（HF_ENDPOINT）
- 或换用可离线的更轻量模型
- 健康端点的 embeddingAvailable 已配合 worker error 重置（F20260803mval），待模型加载修复后即可生效

## 关联

- Issue #124 Task C
- F20260803mval（本 F 的前置，修复 worker error ready 重置 + 健康端点可见性）
