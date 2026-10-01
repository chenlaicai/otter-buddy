---
id: F20261001ftsp
title: FTS5 两段式查询（AND 优先 OR 兜底）
summary: 检索读放大降级——多词 OR 宽查询全量 bm25 打分改 AND 交集优先，实测 13.7ms→2.9ms（#1115）
change_type: fix
capability_test: "n/a: SQL 查询形态改造（确定性逻辑），8 用例锁行为语义（含标点过滤回归锚）+ 生产库实测性能数字入档"
intent:
  problem: "FTS5 检索在主线程同步执行（better-sqlite3 固有形态），检索高峰（sync_docs 大批量入库/高频 search_memory）时挤压 invoke/SSE/HTTP——#1107 采样显示 ≈90% 主线程时间在 sqlite3_step→fts5NextMethod。onnx 线程池钳制（PR #1114）后残留症状。"
  expected_effect: "多词查询走 AND 交集优先（命中集 11k→23 级收敛），单次检索主线程占用实测 13.7ms→2.9ms（宽词 5 词场景）；AND 空结果回落 OR 保召回；jieba 分词空格 token 修复（此前 AND 段被 '\" \"' 拖空导致两段式失效、永远回落 OR）。"
  verify_by:
    type: static_only
    reason: "SQL 查询形态改造为确定性逻辑：8 用例锁行为语义（AND 交集/OR 兜底/单词条等价/filters 贯穿/高亮共享路径/标点过滤回归锚三例）+ 413 回归全绿；性能数字（13.7ms→2.9ms、命中 11228→23）属环境敏感不入单测，由本档实测记录承载；行为面由下轮检索高峰采样回查（主线程 fts5NextMethod 占比应显著下降）"
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

**附带修复（调试中发现，检视处置扩大）**：`tokenizeQuery` 产出空 token 使 AND 段恒空——空格 token（`"方案"," ","设计"`）与**标点 token**（`cut("health-panel")` → `["health","-","panel"]`，`"-"` 零 posting）同病，trim 只覆盖空白子类（检视獭-1279 严重 1 实锤：含标点查询永远走双段旁路 75% 收益，生产库实测「獭 记忆 系统 对话 修复 ，」16.26ms vs 无标点 3.83ms）。修复改为 Unicode 判定 `/[\p{L}\p{N}]/u.test(w)`（至少含一个字母/数字，覆盖中文与 CJK），纯标点查询返回空不触发检索。

## 设计取舍记录（机制判定）

Modification-Class: narrow-fix——单文件查询形态改造 + tokenizer 一行过滤，无新机制无 schema 变更。

### Why（未选替代方案）

- **worker 线程只读连接**（issue 方向 1）：技术验证通过（worker 跑 200 次宽词检索主线程 0ms 阻塞，bge-m3-worker 先例现成）——但当前单次检索 10-20ms 的阻塞不致命，worker 化引入连接生命周期/迁移复杂度不匹配收益。**留作升级路径**：单次检索 >50ms 或库 >20 万条时启用（记录在本档，届时另立 issue）
- **WAL/mmap/cache 配置**（issue 方向 3）：实测无收益，排除
- **SQL 列裁剪**（issue 方向 2 的一部分）：实测收益 <15%，不在打分热点上，不做

### 残留接受项

- AND 语义变化：多词查询从「任一词出现即命中」收紧为「全词出现优先」——语义上更接近用户意图（多词检索通常想找都提到的），但 OR 兜底保证零结果场景不丢召回。边界：AND 命中 <50 条时结果集比旧 OR 小——这是设计内行为（排名靠前的交集条目优先），非缺陷。**检视量化补充**：AND 命中充足时 OR top50 实测丢 0 条（bm25 本就优先多词命中）；AND 命中 <50 才缩水（「检索 性能」5 vs 690 条）——**D22 FTS-only 降级窗口（vec0 不可用时）该缩水是纯召回损失**，混合检索正常路径有 vec 侧补足不受影响；接受理由：D22 是降级态非常态，且多数多词查询 AND 命中充足
- **worst path 量化（检视建议 2）**：AND 空判定 + OR 兜底 = 两次扫描，实测比旧单次 OR 慢 +4%~+33%（绝对值 +0.1~3.3ms）——触发条件是「多词 AND 零交集」（词组语义分散），频率低且绝对代价小；接受
- 单词宽查询（如「獭」命中 7.9k 行）仍是 7.5ms——单词无交集可收缩，属 FTS5 打分固有成本，worker 线程化时一并解决

## 验证

### 测试证据

- **新增 8 用例**（tests/frameworks/db/memory/fts-two-phase-query.test.ts）：AND 交集命中/OR 兜底保召回/单词条等价/filters 贯穿两段/高亮路径共享/**检视处置 3 用例：含连字符查询 AND 段不旁路（严重 1 回归锚）/纯标点查询返回空/点号井号形态字母数字保留**——全过
- **回归**：tests/frameworks/db/ + tests/usecases/memory/ 38 文件 413 用例全绿
- **tsc** 0 错

### 性能实测（生产库 48,234 条，2026-10-01）

宽词 5 词：13.7ms → 2.9ms（-79%）；宽词 2 词：5.4ms → 2.5ms。数字属环境敏感不入单测，回查方式：下轮检索高峰采样 main-thread fts5NextMethod 占比。

### Golden Gate

Golden Gate: n/a（verify_by=static_only——db 层 SQL 查询形态，无 prompt/skill/协议层软代码变更；jieba-tokenizer 的 Unicode 字母数字过滤是纯数据清洗不影响模型可见面）

## 检视处置记录（检视獭-1279 初轮：1 严重 + 4 建议）

- **严重 1（标点 token 与空格同病漏修）采纳**：过滤条件从 trim 扩大为 `/[\p{L}\p{N}]/u.test(w)`（Unicode 字母/数字判定）——含连字符/点号/井号/中文标点的查询 AND 段不再旁路；补 3 用例（连字符回归锚/纯标点空返回/点号井号字母数字保留）
- **建议 1（召回影响面）采纳为文档声明**：AND 命中充足丢 0 条、<50 才缩水、D22 降级窗口的纯召回损失——落残留接受项（见上）
- **建议 2（worst path 量化）采纳**：+4%~+33%（+0.1~3.3ms）实测数字入档残留接受项
- **建议 3（D22 召回损失）并入建议 1 声明**
- **建议 4（测试覆盖）采纳**：见测试证据 8 用例
- **建议 5（golden 集口径提醒）**：F20261001ftsp 无 golden_replay 场景（verify_by=static_only），golden 集不受本 PR 影响——记档

## 后续动作

- issue #1115 随 PR closes（残留观察：单词宽查询 7.5ms 与 worker 线程升级路径的触发条件已记录）
- #1107 整单残留症状跟踪：合入后下一波检索高峰采样验证 fts5NextMethod 占比下降
