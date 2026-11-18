---
id: F20261118grcal
title: 记忆检索排序优化 Phase 1 段 3：合成集网格标定记录（候选矩阵 + 过拟合警示）
doc_type: feature
summary: |
  「记忆检索排序优化」Phase 1（F20261112rnkph 设计、F20261112arlxv 实施规格）
  第三段的标定执行记录。段 1 已合入加法融合路径（PR #1910），段 2 已合入 debug
  贡献分量通道（PR #1912）；本段新增标定台架（tests/usecases/memory/golden-grid.eval.ts
  + vitest.eval.config.ts + npm run eval:grid），在 44 查询合成 golden 集上跑通逐信号
  反事实表（8 组）与系数网格搜索（352 个合法组合），产出候选矩阵并兑现 arlxv 校订 2
  的过拟合警示：网格顶格推「关时间衰减」系构造分布反向激励，不据以切默认。
  生产默认仍 multiply，本文与前段一致的零行为变更口径。
change_type: feature
intent:
  problem: "段 3 网格标定缺可复跑的独立载体：设计文档给了网格步骤与选择准则，但标定脚本、反事实表口径、候选矩阵与结论留痕无处安放；且 arlxv 校订 2 预警的合成集过拟合风险需要一个把「网格推什么、为什么不照单切默认」讲清楚的记录，否则段 4 切默认会拿着一组拟合了构造分布的系数去动生产"
  expected_effect: "产出段 3 标定记录：标定台架可一条命令复跑（npm run eval:grid，自检断言锁定锚点/网格结构/候选矩阵），反事实 8 组与网格 352 组合候选矩阵落表，过拟合警示与段 4 前置（真实数据抽查）写死；生产默认保持 multiply 零行为变更"
  verify_by:
    type: static_only
    note: "本文是标定记录，零行为变更；表中数字由 npm run eval:grid 的自检断言机器锁定（multiply 地板 0.6732/0.7079/0.8114、全中性 0.7998/0.8029/0.9364、网格 352 组合唯一/权重和≈1、候选矩阵 0.8019/0.8050/0.9364），检视獭异体复跑 diff 一致"
capability_test: "n/a: 本文零行为变更；行为门禁为 tests/usecases/memory/golden-eval.test.ts（三项地板）+ npm run eval:grid 标定自检"
created_at: 2026-11-18
causal_links:
  from: [F20261112rnkph, F20261112arlxv, F20261008mrrk]
  supersedes: []
tags: [memory, retrieval, ranking, rerank, grid-search, calibration, synthetic-golden, overfit-warning]
modules:
  - tests/usecases/memory/golden-grid.eval.ts
  - vitest.eval.config.ts
  - package.json
  - tests/usecases/memory/golden-corpus.ts
---

# 记忆检索排序优化 Phase 1 段 3：合成集网格标定记录

> **定位**：这是「记忆检索排序优化」的第四份文档，不是新设计。顺序是
> F20261008mrrk（现状核实 + Phase 0）→ F20261112rnkph（Phase 1 设计）→
> F20261112arlxv（实施规格，四段拆分）→ **本文 = 段 3 标定执行记录**。
> 历史文档不可改（铁律），段 3 的结论落新载体，`causal_links.from` 关联前三份。

## 1. 标定台架与口径

- **入口**：`npm run eval:grid`（`vitest run --config vitest.eval.config.ts`
  `--disable-console-intercept --testTimeout=300000`）。
- **台架文件**：`tests/usecases/memory/golden-grid.eval.ts`（不在 `npm test` 默认
  include——默认 include 只收 `.test.ts`，eval config 只收 `.eval.ts`）。
- **口径**：复用 golden-corpus 44 查询 / 50 语料 + ranking-metrics，与
  `golden-eval.test.ts` 同源；Vec 路径 mock unavailable，FTS+RRF+rerank 的
  FTS-only 口径（与 golden-eval 头部声明一致）。
- **自检断言**（防止数字静默漂移）：锁定 multiply 地板（0.6732/0.7079/0.8114）与
  全中性锚点（0.7998/0.8029/0.9364）；网格精确 352 组合、行唯一、每行 `wRrf+wTime+wFreq≈1`、
  指标有限；候选矩阵参数与指标锁定（见 §3）。

## 2. 逐信号反事实表（n=44，三项指标均值）

| 配置 | nDCG@5 | nDCG@10 | MRR |
|---|---:|---:|---:|
| multiply 生产默认（全开） | 0.6732 | 0.7079 | 0.8114 |
| additive 全开（设计回填 0.6/0.3/0.1/0.05/0.05） | 0.7769 | 0.7906 | 0.9085 |
| additive 全中性（w_rrf=1 其余 0） | 0.7998 | 0.8029 | 0.9364 |
| additive 关 rrf | 0.6677 | 0.7026 | 0.7962 |
| additive 关 time | 0.7998 | 0.8029 | 0.9364 |
| additive 关 freq | 0.7783 | 0.7920 | 0.9048 |
| additive 关 flag | 0.7777 | 0.7914 | 0.9085 |
| additive 关 conv | 0.7760 | 0.7897 | 0.9048 |

四个读数：①additive 全开三项全面优于 multiply 生产默认（+0.10/+0.08/+0.10），加法路径
本身在合成集上成立；②关 rrf 掉到地板以下（0.6677），rrf 是主信号；③关 time 与全中性
完全同值——时间新近度在本集上零贡献甚至负贡献；④freq/flag/conv 三信号贡献微弱（关掉只动
小数点后第三、四位）。

## 3. 网格搜索结果（352 个合法组合全达标）

网格空间：`w_rrf ∈ {0.4,0.5,0.6,0.7,0.8}`、`w_time ∈ {0,0.1,0.2,0.3,0.4}`
（`w_freq = 1−w_rrf−w_time`，负值丢弃）、`b_flag,b_conv ∈ {0,0.02,0.05,0.1}`；
`freqCap=10` 固定。选择准则（F20261112rnkph 第 5 节）：三项均 ≥ 地板
（0.673/0.707/0.811）→ nDCG@5 最高 → 并列取参数更少偏离默认。结果全集落
`data/metrics/golden-grid-results.jsonl`（gitignored 运行时产物，脚本每次重跑覆写）。

候选矩阵（前三）：

| w_rrf | w_time | w_freq | b_flag | b_conv | nDCG@5 | nDCG@10 | MRR |
|---|---:|---:|---:|---:|---:|---:|---:|
| **0.8** | **0** | **0.2** | **0.1** | **0.05** | **0.8019** | **0.8050** | **0.9364** |
| 0.8 | 0 | 0.2 | 0.05 | 0.05 | 0.7998 | 0.8029 | 0.9364 |
| 0.8 | 0 | 0.2 | 0.02 | 0.05 | 0.7998 | 0.8029 | 0.9364 |

全部 352 组合三项均不劣于地板——合成集对本系数空间不敏感，任何 `w_rrf≥0.4` 都优于
multiply 地板。候选矩阵仅是段 4 的起点参考，不是生产推荐。

## 4. 结论与过拟合警示（arlxv 校订 2 的兑现）

1. 加法融合路径本身成立：additive 全开（设计回填系数）全面优于 multiply 生产默认。
2. **网格顶格推「关时间衰减」（w_time=0）**：合成集上 `w_time` 系统性负贡献（关 time
   不劣于全中性），顶格候选 `w_rrf=0.8, w_time=0, w_freq=0.2, b_flag=0.1, b_conv=0.05`
   比全中性只多 +0.002 nDCG@5。这正是 arlxv 校订 2 预警的「构造分布反向激励」——
   合成集语料的时间分布无法代表真实记忆，**不据以切默认**。
3. 网格全达标说明合成集对系数不敏感，候选矩阵的区分度本身有限，段 4 任何切换都必须
   以真实数据抽查为准。

## 5. 段 4 前置与回滚口径

- **段 4（切默认）前置**：真实数据抽查排期，或搭档明示接受合成集风险。在此之前
  `memory.rerankMode` 缺省保持 `multiply`，生产排序路径零变化。
- **回滚**：段 3 只新增台架（eval config / eval 脚本 / npm script），不触碰
  `config-service.ts` 默认；`git revert <段 3 merge-commit>` 即回滚，`.eval.ts` 不在
  默认测试套件，删除不伤回归。