---
id: F20261001ftsp
title: FTS5 两段式查询（AND 优先 OR 兜底）
summary: 检索读放大降级——多词 OR 宽查询全量 bm25 打分改 AND 交集优先，实测 13.7ms→2.9ms（#1115）
change_type: fix
capability_test: "n/a: SQL 查询形态改造（确定性逻辑），5 新用例锁行为语义 + 生产库实测性能数字入档"
intent:
  problem: "FTS5 检索在主线程同步执行（better-sqlite3 固有形态），检索高峰（sync_docs 大批量入库/高频 search_memory）时挤压 invoke/SSE/HTTP——#1107 采样显示 ≈90% 主线程时间在 sqlite3_step→fts5NextMethod。onnx 线程池钳制（PR #1114）后残留症状。"
  expected_effect: "多词查询走 AND 交集优先（命中集 11k→23 级收敛），单次检索主线程占用实测 13.7ms→2.9ms（宽词 5 词场景）；AND 空结果回落 OR 保召回；jieba 分词空格 token 修复（此前 AND 段被 '\" \"' 拖空导致两段式失效、永远回落 OR）。"
  verify_by:
    type: static_only
    reason: "SQL 查询形态改造为确定性逻辑：5 新用例锁行为语义（AND 交集/OR 兜底/单词条等价/filters 贯穿/高亮共享路径）+ 410 回归全绿；性能数字（13.7ms→2.9ms、命中 11228→23）属环境敏感不入单测，由本档实测记录承载；行为面由下轮检索高峰采样回查（主线程 fts5NextMethod 占比应显著下降）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [memory, fts5, search, performance, main-thread]
modules: [src/frameworks/db/]
from: ["F20260805hybrid", "F20260902rcp1"]
causal_links: ["#1115", "#1107"]
created_at: 2026-10-01
---

# FTS5 两段式查询（AND 优先 OR 兜底）

## 问题（#1115，派生自 #1107 排查）

FTS5 检索在主线程同步执行（better-sqlite3 同步 API 固有形态），检索高峰时挤压主事件循环。#1107 采样：main-thread ≈90% 时间在 `sqlite3_step → fts5NextMethod`。onnx 线程池钳制（PR #1114）修掉主因后这是残留症状。

## 根因分析（生产库实测，2026-10-01）

**读放大在 bm25 全量打分**：`searchFtsJiebaRows` 把 jieba 分词后的多词用 OR 连接——5 词宽查询命中 11,228 行（48k 库的 23%），FTS5 对每行算 bm25 再 ORDER BY rank LIMIT 50，**打分成本与命中集线性相关**：

| 查询形态 | 命中行数 | 单次耗时 |
|---|---|---|
| 5 词 OR（獭/记忆/系统/对话/修复） | 11,228 | 13.7ms |
| 同 5 词 AND | 23 | 2.9ms |
| 2 词 OR（方案/设计） | 4,861 | 5.4ms |
| 同 2 词 AND | 1,254 | 2.5ms |
| 单词「獭」 | 7,916 | 7.5ms |

排除项（实测）：mmap+64MB cache 无收益（12.9→12.1ms 噪声级）；`me.*` 列裁剪收益小（12.9 vs 11.3ms——LIMIT 50 后才取列，读放大大头在打分）。

## 方案设计

**两段式查询**（`searchFtsJiebaRows` 单点改造，searchFTS/searchFTSWithHighlight 双消费方共享）：

1. 多词（≥2）先跑 **AND 交集**——命中集收敛到「所有词都出现」的条目，打分成本随之收敛
2. AND 空结果回落 **OR 兜底**——保召回（宽泛查询/词间无交集时不至于零结果）
3. 单词条不回落（AND/OR 等价，无额外成本）

**附带修复（调试中发现的隐藏 bug）**：`tokenizeQuery` 对含空格查询产出空格 token（`"方案"," ","设计"`），AND 段含 `" "` 后恒空结果 → 两段式永远回落 OR（等于没修）。jieba-tokenizer 加 `trim` 过滤后 AND 段才真正生效。

## 设计取舍记录（机制判定）

Modification-Class: narrow-fix——单文件查询形态改造 + tokenizer 一行过滤，无新机制无 schema 变更。

### Why（未选替代方案）

- **worker 线程只读连接**（issue 方向 1）：技术验证通过（worker 跑 200 次宽词检索主线程 0ms 阻塞，bge-m3-worker 先例现成）——但当前单次检索 10-20ms 的阻塞不致命，worker 化引入连接生命周期/迁移复杂度不匹配收益。**留作升级路径**：单次检索 >50ms 或库 >20 万条时启用（记录在本档，届时另立 issue）
- **WAL/mmap/cache 配置**（issue 方向 3）：实测无收益，排除
- **SQL 列裁剪**（issue 方向 2 的一部分）：实测收益 <15%，不在打分热点上，不做

### 残留接受项

- AND 语义变化：多词查询从「任一词出现即命中」收紧为「全词出现优先」——语义上更接近用户意图（多词检索通常想找都提到的），但 OR 兜底保证零结果场景不丢召回。边界：AND 命中 <50 条时结果集比旧 OR 小——这是设计内行为（排名靠前的交集条目优先），非缺陷
- 单词宽查询（如「獭」命中 7.9k 行）仍是 7.5ms——单词无交集可收缩，属 FTS5 打分固有成本，worker 线程化时一并解决

## 验证

### 测试证据

- **新增 5 用例**（tests/frameworks/db/memory/fts-two-phase-query.test.ts）：AND 交集命中/OR 兜底保召回/单词条等价/filters 贯穿两段/高亮路径共享——全过
- **回归**：tests/frameworks/db/ + tests/usecases/memory/ 38 文件 410 用例全绿
- **tsc** 0 错

### 性能实测（生产库 48,234 条，2026-10-01）

宽词 5 词：13.7ms → 2.9ms（-79%）；宽词 2 词：5.4ms → 2.5ms。数字属环境敏感不入单测，回查方式：下轮检索高峰采样 main-thread fts5NextMethod 占比。

### Golden Gate

Golden Gate: n/a（verify_by=static_only——db 层 SQL 查询形态，无 prompt/skill/协议层软代码变更；jieba-tokenizer 的 trim 过滤是纯数据清洗不影响模型可见面）

## 后续动作

- issue #1115 随 PR closes（残留观察：单词宽查询 7.5ms 与 worker 线程升级路径的触发条件已记录）
- #1107 整单残留症状跟踪：合入后下一波检索高峰采样验证 fts5NextMethod 占比下降
