---
id: F20261111arlxv
title: 记忆检索排序优化 Phase 1：rerank 加法栈实施规格与子问题台账
doc_type: feature
summary: |
  「记忆检索排序优化」Phase 1 的实施规格（承接 F20261008mrrk，落实 F20261105rnkph）。
  父文档已交付 Phase 0（golden 套件 44 查询/50 语料，地板 0.673/0.707/0.811 进 CI）；
  F20261105rnkph 已把 Phase 1 设计写到可开工粒度；原 PR #1784 关闭后，rebase 版本由本 PR 携带。
  本文不重写设计，只补设计文档缺的三件：① F20261105rnkph 的交付状态核实
  （原 PR #1784 已关闭，rebase 后设计由本 PR 携带）；② 两处定量校订——用权重/偏置
  矩阵精确定义加法域的全中性化与逐单关，以及收紧 44 条合成集上的默认切换门槛
  （全中性化比生产默认高 0.13 nDCG@5，存在过拟合风险）；③ 把归一化融合、标定、
  切默认拆成四段可独立交付的实施规格，每段带验收证据与回滚口径。
change_type: feature
intent:
  problem: "记忆检索排序优化 Phase 1 缺实施载体：F20261105rnkph 已到可开工粒度，原 PR #1784 已关闭，rebase 后设计由本 PR 携带，但施工顺序与验收仍需具体化；且设计中的选择准则在 44 条合成 golden 集上做网格搜索存在过拟合风险（该集上全中性化比生产默认高 0.13 nDCG@5），直接按设计施工可能把一个只是拟合了构造分布的系数矩阵切为生产默认"
  expected_effect: "产出可逐段施工的 Phase 1 实施规格：四段 PR 拆分（归一化函数与加法规路径 / debug 贡献分量 / 网格标定 / 切默认），每段给定输入、输出、验收证据与回滚口径；默认行为在第三段之前零变化；标定环节强制要求真实数据抽查作为切默认的前置，否则只交付 additive 路径不切默认"
  verify_by:
    type: static_only
    note: "本文是实施规格，零行为变更；行为验收在四段实施 PR（各段验收证据见「实施规格」节，均落到 tests/usecases/memory/golden-eval.test.ts 与 npm run eval:golden）"
capability_test: "n/a: 实施规格文档零行为变更；实施 PR 的门禁为 tests/usecases/memory/golden-eval.test.ts 三项地板 + 逐信号对比表"
created_at: 2026-11-11
created_in_conversation: 1af0abaa-63e9-4f84-bf3a-ce32c48ce461
causal_links:
  from: [F20261105rnkph, F20261008mrrk, F20260917cvid, F20260902rcp1]
  supersedes: []
tags: [memory, retrieval, ranking, rerank, normalization, golden-eval, implementation-spec]
modules:
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - config/config.yaml.example
  - tests/usecases/memory/golden-eval.test.ts
---

# 记忆检索排序优化 Phase 1：实施规格与子问题台账

> **定位**：这是「记忆检索排序优化」的第三份文档，不是新设计。分工是：
> F20261008mrrk（10/08，已合入）= 现状核实 + 问题定性 + Phase 0 交付；
> F20261105rnkph（原 PR #1784；rebase 后由本 PR 携带）= Phase 1 设计（归一化口径、融合公式、配置键、网格步骤）；
> **本文 = 实施规格**——把那份设计的施工顺序、每段验收证据、以及它没覆盖的两个定量问题补齐。
> 若与设计文档冲突，设计口径以 F20261105rnkph 为准，本文只做增量与订正，订正处逐条标注理由。

## 一、为什么还要多一份文档（交付状态核实）

2026-11-11 对仓库实查、11-12 rebase 后复核，Phase 1 的交付路径如下：

| 事实 | 核实方式 |
|---|---|
| 原设计 PR **#1784 已 CLOSED**；其历史检查中 e2e 失败，不再是当前交付路径 | `gh pr view 1784 --json state,statusCheckRollup` |
| rebase 后的 F20261105rnkph 设计 commit `8e1d609f` **由本 PR #1856 携带**，本 PR 四绿 | `gh pr view 1856 --json commits,statusCheckRollup` |
| 该文档**尚不在 main**，将随本 PR 合入 | `ls docs/features/2026/11/05/` 无 `rnkph` 文件 |
| main 上 rerank 五信号连乘**原样未动** | `search-engine.ts:168-196` `rerank()` |

所以载体的最后一跳由本 PR 一次完成，无需重开或继续等待 #1784。S0 只保留这段
关闭与携带关系，避免实施后仍沿旧 PR 空等。

## 二、设计基线摘要（一句话版，细节见 F20261105rnkph）

现状（`search-engine.ts:183-190`）：

```
final = rrf × timeDecay × frequencyBoost × userFlagMultiplier? × conversationBoost?
```

Phase 1 目标形态：

```
score = w_rrf·norm(rrf) + w_time·timeDecay + w_freq·norm(freq) + b_flag·[flagged] + b_conv·[同对话]
约束：w_rrf + w_time + w_freq = 1
```

逐信号归一化口径（rrf 池内 min-max / freq 饱和截断 CAP=log(11) / 两个类别信号转加法偏置）已在
F20261105rnkph 表 1 定死，本文不重复。

## 三、两处定量校订（本文的实质增量）

### 校订 1：用权重/偏置矩阵定义全中性化与逐单关

F20261008mrrk 的反事实表把「五信号全中性化」当作基线对照（0.7998/0.8029/0.9364），
实施规格必须能复现这一组对照，否则逐信号对比表无法生成。加法域的全中性化配置直接定义为：

```
w_rrf=1，w_time=w_freq=b_flag=b_conv=0
⇒ score = norm(rrf)
```

RRF min-max 是单调变换（单候选/全并列按设计取常量），所以排序与 raw RRF 相同，应复现
Phase 0 的全中性化指标。逐单关则把目标信号对应的 `w_*` 或 `b_*` 置 0；其余参数保持，
若触发连续权重和归一化，被关闭项仍为 0 并记录归一化后的矩阵。加法域不需要也不要新增
`neutralTimeDecay` 之类的信号改写开关：`w_time=0` 已让时间项严格为 `0 × timeDecay = 0`。

### 校订 2：合成集上的网格搜索有过拟合倾向，切默认前必须换集

Phase 0 的对照数字（v2 扩充后重录，n=44，FTS-only 口径）：

| 配置 | nDCG@5 | nDCG@10 | MRR |
|---|---|---|---|
| 生产默认（五信号全开） | 0.6732 | 0.7079 | 0.8114 |
| 五信号全中性化 | 0.7998 | 0.8029 | 0.9364 |
| 仅关时间衰减 | 0.7669 | 0.7810 | 0.8845 |
| 仅关本对话加成 | 0.6611 | 0.7026 | 0.7981 |

「全关比生产默认高 0.13 nDCG@5」与「仅关时间也更高」共同揭示：这张集存在把
`w_time` 系统性压低的反向激励风险，网格选型可能拟合构造分布，而非真实的新近度语义。
这两个反事实点**不能推出**所有削弱时间衰减的矩阵都更好，也不能预设网格一定把
`w_time` 推到 0；实际方向必须由网格结果与灵敏度曲线验证。

**订正**：把标定拆成两个阶段，切默认的门槛加一级：

- **阶段 A（合成集标定）**：在 golden 集上跑网格，输出候选系数矩阵与灵敏度曲线。
  允许在合成集上选系数，但**只用于生成候选，不授权切默认**。
- **阶段 B（真实数据抽查）**：从真实检索日志抽 20-30 条查询人工标注 top-5 相关性
  （这是 F20261008mrrk R2 的活儿，一直没排期）。候选矩阵在标注集上重跑，仍是三项不劣于
  生产默认才允许切默认。
- **未排期 B 时的兜底**：只合入 additive 路径（`rerankMode` 默认 `multiply`），候选系数
  写进 config 注释，不切默认。这样 Phase 1 的工程价值（可解释、可标定）先落地，
  风险留到数据齐了再付。

这条改变了 F20261105rnkph「标定后系数使默认排序与今天不同——这是本特性的目的本身」的节奏：
目的不变，但**默认切换从实施 PR 的必然后果变成一个独立的、有前置条件的第四段**。

## 四、实施规格：四段 PR

每段独立可合、独立可回滚。前一段不合，后一段不动。

### 段 1：加法规路径（零默认变更）

- **输入**：F20261105rnkph 的归一化口径表。
- **产出**：`search-engine.ts` 新增 `rerankAdditive()`（与现有 `rerank()` 并存），
  归一化纯函数独立导出（`normalizeRrfPool` / `normalizeFrequency`）；配置新增
  `memory.rerankMode: multiply | additive`，**缺省 `multiply`**；不新增信号中性化开关。
- **验收**：additive 路径按第 3 节矩阵配置全中性化，复现 0.7998/0.8029/0.9364（容差 ±0.001），
  这一条是段 1 的核心证据——证明新路径不是另一个黑盒；`rerankMode=multiply` 下
  `npm run eval:golden` 三项数字与地板完全一致（零行为变更证明）；归一化纯函数单测
  （单候选池、全并列、空池三类边界）。
- **回滚**：删除开关即回落，无 DB 变更。

### 段 2：debug 贡献分量

- **产出**：`search-memory.ts` 的 debug 通道追加 `contrib_rrf / contrib_time / contrib_freq /
  bias_flag / bias_conv`。字段只增不改，旧字段语义不动。
- **验收**：debug 输出能手工复算 finalScore（单测断言）；multiply 模式下旧字段逐字节不变。
- **为什么单独一段**：段 3 的逐信号对比表要从这个通道采集，它必须先上。

### 段 3：合成集标定（不改默认）

- **产出**：网格脚本（`scripts/` 或 `npm run eval:grid`）+ 候选系数矩阵；
  逐信号反事实表（全开 / 全中性 / 逐单关 × 三项指标）。
- **验收**：候选矩阵三项不劣于地板；完整对比表进 PR 描述；`rerankMode` 缺省仍是
  `multiply`——**本段结束时生产行为仍零变化**。
- **取舍**：搜索空间与选择准则沿用 F20261105rnkph 第 5 节；唯一的加项是
  `w_time=0` 的候选必须同时报告「关时间衰减」的语义后果（时间新近度不再影响排序），
  让读者知道自己在选什么。

### 段 4：切默认（需前置条件 + 搭档拍板）

- **前置条件**：阶段 B 真实标注集就位，或搭档明确接受「在合成集上切默认」的风险。
- **产出**：`memory.rerankMode` 缺省改为 `additive`，候选系数写进 `config.yaml.example`；
  旧键（`userFlagMultiplier` / `currentConversationBoost`）进兼容期。
- **验收**：正常路径要求真实标注集三项不劣于生产默认，PR 附合成集 + 真实集双表；
  若走搭档风险豁免路径，PR 必须引用该项明确裁决、附合成集结果与风险说明，且不得宣称
  真实分布上不劣。两条路径均按结果判定 `[Incompatible]` 标记。
- **归属**：默认行为变更影响所有检索结果，属产品行为取舍 → **搭档拍板**，大獭只提供数字。

## 五、子问题台账

| 编号 | 问题 | 归属 | 阻塞谁 |
|---|---|---|---|
| S0 | 原 PR #1784 已 CLOSED；rebase 后设计由本 PR 携带且四绿，旧 e2e 不再是交付 blocker | 已解除 | 无 |
| S1 | 全中性化与逐单关需用明确矩阵复现（校订 1） | 本文已给配置 | 段 1 验收 |
| S2 | 合成集上网格搜索过拟合（校订 2） | 本文已给拆分 | 段 4 前置 |
| S3 | 真实数据标注 20-30 条谁标、何时排（父文档 R2 存量欠账） | **资源投入 → 搭档** | 段 4 |
| S4 | 三份同主题文档的去留（F20261008mrrk 已合入保留；F20261105rnkph 合入后本文与其关系） | 技术域 | 无需动作，见下 |

S4 解释：F20261105rnkph 合入后即为历史文档（不可改），本文与它是「设计 → 实施规格」的
`from` 关系，不 supersede——两份都要，分工明确。不做三合一，因为合并意味着改一份已合入
文档的正文，违反历史文档不可变铁律。

## 六、验证（本文档）

- `npm run lint:docs` / `npm run lint:intent` / `node scripts/lint-capability-docs.mjs` 全绿。
- 文中代码锚点为 2026-11-11 实查结果，PR 状态于 11-12 rebase 后复核；锚点由检视獭重放核对。
- 零行为变更：本文不触碰 `src/`、`config/`，`npm run eval:golden` 数字不受影响。

## 七、下一步

1. 本文过对抗审视 → 搭档终审合入；设计与实施规格由本 PR 一并交付。
2. 段 1 开工：加法规路径 + 按明确矩阵复现全中性化证据。
3. S3 若搭档愿排期，段 4 才有真实集直路；不排则 Phase 1 交付到段 3 为止，除非搭档显式接受合成集切默认的风险。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
