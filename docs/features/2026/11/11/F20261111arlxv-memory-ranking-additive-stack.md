---
id: F20261111arlxv
title: 记忆检索排序优化 Phase 1：rerank 加法栈实施规格与子问题台账
doc_type: feature
summary: |
  「记忆检索排序优化」Phase 1 的实施规格（承接 F20261008mrrk，落实 F20261105rnkph）。
  父文档已交付 Phase 0（golden 套件 44 查询/50 语料，地板 0.673/0.707/0.811 进 CI）；
  F20261105rnkph（PR #1784）已把 Phase 1 设计写到可开工粒度，但停在未合入状态至今。
  本文不重写设计，只补设计文档缺的三件：① F20261105rnkph 之后 main 的交付状态核实
  （PR #1784 仍 OPEN，e2e 红）；② 两处定量订正——全中性化配置在加法域不可达
  （w_time=0 挡不住 timeDecay 的量纲），以及 44 条合成集上的选择准则存在过拟合
  （全中性化比生产默认高 0.13 nDCG@5）；③ 把归一化融合、标定、切默认拆成四段
  可独立交付的实施规格，每段带验收证据与回滚口径。
change_type: feature
intent:
  problem: "记忆检索排序优化 Phase 1 缺实施载体：设计在 F20261105rnkph / PR #1784 里已到可开工粒度，但该 PR 自 2026-11-05 起停在 OPEN（e2e FAILURE）未合入，pipeline 无执行方；且设计中的选择准则在 44 条合成 golden 集上做网格搜索存在过拟合风险（该集上全中性化比生产默认高 0.13 nDCG@5），直接按设计施工可能把一个只是拟合了构造分布的系数矩阵切为生产默认"
  expected_effect: "产出可逐段施工的 Phase 1 实施规格：四段 PR 拆分（归一化函数与加法规路径 / 网格标定 / debug 贡献分量 / 切默认），每段给定输入、输出、验收证据与回滚口径；默认行为在第三段之前零变化；标定环节强制要求真实数据抽查作为切默认的前置，否则只交付 additive 路径不切默认"
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
> F20261105rnkph（PR #1784，未合入）= Phase 1 设计（归一化口径、融合公式、配置键、网格步骤）；
> **本文 = 实施规格**——把那份设计的施工顺序、每段验收证据、以及它没覆盖的两个定量问题补齐。
> 若与设计文档冲突，设计口径以 F20261105rnkph 为准，本文只做增量与订正，订正处逐条标注理由。

## 一、为什么还要多一份文档（交付状态核实）

2026-11-11 对仓库实查，Phase 1 的真实状态比"设计已完成"要糟一点：

| 事实 | 核实方式 |
|---|---|
| F20261105rnkph 的设计已提交到分支 `docs/F20261105rnkph-memory-ranking-phase1`（commit `d2d56045`），worktree 干净 | `git worktree list` + `git status --porcelain` |
| 该分支的 PR **#1784 仍是 OPEN**，`check` / `guard-macos` / `golden-selftest` 绿，**`e2e` FAILURE** | `gh pr list --head ... --state all`、`gh pr view 1784 --json statusCheckRollup` |
| 该文档**不在 main** | `ls docs/features/2026/11/05/` 无 `rnkph` 文件 |
| main 上 rerank 五信号连乘**原样未动** | `search-engine.ts:168-196` `rerank()` |

所以「Phase 1 未实施」不是执行者怠工，是**载体的最后一跳没走完**：设计卡在一个 e2e 红的 PR 上，
而 e2e 失败与一份纯文档改动无关。这件事本身列为本节第一个子问题（S0）。

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

## 三、两处定量订正（本文的实质增量）

### 订正 1：全中性化配置在加法域不可达

F20261008mrrk 的反事实表把「五信号全中性化」当作基线对照（0.7998/0.8029/0.9364），
实施规格必须能复现这一组对照，否则第 5 节的逐信号对比表无法生成。但照搬设计的约束
`s w_rrf + w_time + w_freq = 1，w_* ≥ 0` 会发现：**`w_time = 0` 并不能让 timeDecay 消失**——
只要 `w_rrf + w_freq = 1`，连续段仍在 [0,1] 上被 timeDecay 常数量纲携带。也就是说加法规下
「关掉时间衰减」不再是 `w_time=0`，而是要么 `w_rrf = w_freq = 0`（只剩偏置，退化），
要么对 timeDecay 单独做「中性化」处理。

**订正**：在归一化函数层显式定义中性化参数 `neutralTimeDecay`（缺省 `false`；标定与反事实
实验时为 `true`，令 `norm(timeDecay) ≡ 1`），而不是靠权重调零。这条必须写进实施契约，
否则验收清单里的「逐单关五个信号」在加法域物理上做不出来，检视时又是一轮往返。

### 订正 2：合成集上的网格搜索有过拟合倾向，切默认前必须换集

Phase 0 的对照数字（v2 扩充后重录，n=44，FTS-only 口径）：

| 配置 | nDCG@5 | nDCG@10 | MRR |
|---|---|---|---|
| 生产默认（五信号全开） | 0.6732 | 0.7079 | 0.8114 |
| 五信号全中性化 | 0.7998 | 0.8029 | 0.9364 |
| 仅关时间衰减 | 0.7669 | 0.7810 | 0.8845 |
| 仅关本对话加成 | 0.6611 | 0.7026 | 0.7981 |

「全关比生产默认高 0.13 nDCG@5」意味着：在这张集上，**任何**一个削弱时间衰减的系数矩阵都会
显得更好。网格搜索的选型准则（三项不低于基线 → 取 nDCG@5 最高）会稳定地把 `w_time` 推向 0，
这跟「时间衰减在真实使用里是该有的语义」冲突，但合成集看不出来。

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
  `memory.rerankMode: multiply | additive`，**缺省 `multiply`**；`neutralTimeDecay` 中性化参数。
- **验收**：additive 路径的全中性化配置复现 0.7998/0.8029/0.9364（容差 ±0.001），
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
- **验收**：真实标注集三项不劣于生产默认；`[Incompatible]` 标记按结果判定；
  PR 附合成集 + 真实集双表。
- **归属**：默认行为变更影响所有检索结果，属产品行为取舍 → **搭档拍板**，大獭只提供数字。

## 五、子问题台账

| 编号 | 问题 | 归属 | 阻塞谁 |
|---|---|---|---|
| S0 | PR #1784 的 e2e 失败与纯文档改动无关，需查明是真失败还是环境 flake；不绿则 Phase 1 设计永远不在 main | 技术域（大獭拍板） | 段 1 开工前 |
| S1 | 全中性化在加法域不可达（订正 1） | 本文已给方案 | 段 1 验收 |
| S2 | 合成集上网格搜索过拟合（订正 2） | 本文已给拆分 | 段 4 前置 |
| S3 | 真实数据标注 20-30 条谁标、何时排（父文档 R2 存量欠账） | **资源投入 → 搭档** | 段 4 |
| S4 | 三份同主题文档的去留（F20261008mrrk 已合入保留；F20261105rnkph 合入后本文与其关系） | 技术域 | 无需动作，见下 |

S4 解释：F20261105rnkph 合入后即为历史文档（不可改），本文与它是「设计 → 实施规格」的
`from` 关系，不 supersede——两份都要，分工明确。不做三合一，因为合并意味着改一份已合入
文档的正文，违反历史文档不可变铁律。

## 六、验证（本文档）

- `npm run lint:docs` / `npm run lint:intent` / `node scripts/lint-capability-docs.mjs` 全绿。
- 文中代码锚点与 PR 状态为 2026-11-11 实查结果；锚点由检视獭重放核对。
- 零行为变更：本文不触碰 `src/`、`config/`，`npm run eval:golden` 数字不受影响。

## 七、下一步

1. 本文过对抗审视 → 搭档终审合入（与 #1784 的关系一并在终审说明）。
2. S0 处置：#1784 e2e 排查，绿了就推进合入。
3. 段 1 开工：加法规路径 + 全中性化复现证据。
4. S3 若搭档愿排期，段 4 才有干净的直路；不排则 Phase 1 交付到段 3 为止。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
