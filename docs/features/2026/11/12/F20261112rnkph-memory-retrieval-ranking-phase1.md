---
id: F20261112rnkph
title: 记忆检索排序优化 Phase 1 实施设计：五信号归一化加法融合
doc_type: feature
summary: |
  记忆检索排序优化的 Phase 1 实施设计，承接 F20261008mrrk（10/8 已交付 Phase 0
  golden 评测套件，只留了 6 行 Phase 1 骨架）。现状：rerank 五信号乘法堆叠
  final = rrf × time_decay × frequency × user_flag × conversation_boost
  （search-engine.ts:183-190），无量纲归一化。本文把骨架落成可开工设计：逐信号
  归一化口径（rrf 池内 min-max、frequency 饱和截断、类别信号转加法偏置）、权重和
  为 1 的融合公式、新配置键与旧系数兼容期、debug 分量扩展、网格搜索标定步骤与
  选择准则，以及验收约束（逐信号前后对比表 + 反事实数字 + 三项地板不许变差）。
  查重：2026-11-05 实查 docs/features|research 仅命中父文档一份，历史文档不可改
  故新建并以 from 关联，不复用其 ID。本文零行为变更。
change_type: feature
intent:
  problem: "rerank 五信号乘法堆叠无量纲归一化（search-engine.ts:183-190），信号量级耦合使排序对单个系数高度敏感；Phase 0 评测基线已进 CI，但 Phase 1 至今没有独立载体——归一化口径、系数配置、网格搜索方法、验收约束散在父文档的骨架与风险条目里，实施者要开工只能即兴发挥，且历史文档不可改导致后续记录无处追加"
  expected_effect: "产出一份可直接开工的 Phase 1 设计：逐信号归一化口径与融合公式给定、系数配置键与兼容期定义、网格搜索步骤与选择准则写死、四条验收约束落成可勾条目；本文本身零行为变更，实施 PR 可逐条对照验收"
  verify_by:
    type: static_only
    note: "设计文档零行为变更：lint:docs / lint:intent / commit 链全绿，文中代码锚点由检视獭锚点重放核对；行为验收发生在 Phase 1 实施 PR（npm run eval:golden 三项地板 + 逐信号前后对比表）"
capability_test: "n/a: 设计文档零行为变更；Phase 1 实施 PR 的行为门禁为 tests/usecases/memory/golden-eval.test.ts（nDCG@5/@10、MRR 三项地板断言）"
created_at: 2026-11-12
created_in_conversation: d6fbfe61-8310-46f7-bb1c-76f5e401a0ec
causal_links:
  from: [F20261008mrrk, R20260826rcmm, F20260902rcp1, F20260917cvid]
tags: [memory, retrieval, ranking, rerank, normalization, golden-eval]
modules:
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - config/config.yaml.example
  - tests/usecases/memory/golden-eval.test.ts
---

# 记忆检索排序优化 Phase 1 实施设计（F20261112rnkph）

> **定位与查重记录**：本文是「记忆检索排序优化」的 **Phase 1 实施设计**。同主题父文档
> 已存在且不重复——`docs/features/2026/10/08/F20261008mrrk-memory-retrieval-ranking-optimization.md`
> （10/8 建档，PR #1133 已合入）承载现状链路核实、问题定性、Phase 0 实现记录与
> Phase 1 六行骨架。2026-11-05 建档前实查：`grep -rl '记忆检索排序\|信号归一化\|乘法改加法'`
> 在 `docs/features/` + `docs/research/` 只命中该父文档一份；父文档已在 main 属历史文档
> 不可改（铁律），Phase 1 需要新的独立载体，故新建并以 `causal_links.from` 关联，
> **不复用父 ID**（复用会让同 ID 双文件在 sync 入库时互相覆盖）。父文档「关联在途文档」
> 节披露的两份旧草稿 `F20260922mrro` / `F20260922mmro` 承载载体已消失——2026-11-05
> 实查 `git worktree list` 无 `memory-retrieval-ranking` 工作副本、`git branch -a` 无
> 对应分支、`docs/features/2026/09/22/` 无这两个文件，撞车风险不存在。

## 背景与承接

`search_memory` 的排序决定召回内容能否被用上——top-k 截断下该在前面的没排到前面，
等效没召回。父文档按 R20260826rcmm 的优先级结论 **度量 > 召回 > 提炼** 拆了两个 Phase：

- **Phase 0（已完成，10/8）**：golden 评测套件——50 条确定性语料 + 44 条五层查询，
  nDCG@5/nDCG@10/MRR 三项指标随 `npm test` 进 CI，回归地板
  `tests/usecases/memory/golden-eval.test.ts:54-56`（0.673 / 0.707 / 0.811），
  本地复跑入口 `package.json:27`（`npm run eval:golden`）。
- **Phase 1（待实施，本文设计）**：rerank 五信号由乘法堆叠改为同量纲归一化的加法融合，
  系数用 Phase 0 基线网格搜索标定。

父文档的 Phase 1 只有方向性骨架（归一化方式、融合公式、debug 注入三句）+ 三条验收
约束 + R3 备选路径，没有到「可直接开工」的粒度；本文补足这一层，并把父文档散在
「取舍与风险」「已知边界」里的约束收成一张验收清单。父文档原文一律以它为准，本文
不重复其论证，只做承接与具体化。

## 现状核实（2026-11-05 代码实查，锚点为本轮工具返回）

| 项 | 事实 | 锚点 |
|---|---|---|
| 融合公式 | `finalScore = rrfScore × timeDecay × frequencyBoost × userFlagMultiplier × conversationBoost` 五者直接连乘 | `src/usecases/memory/search-engine.ts:183-190`；公式注释 `:50-54` |
| 时间衰减 | `exp(-ln2 × age / halfLife)`，通用层半衰期 7 天、document 层 90 天 | `search-engine.ts:204-216`（`computeTimeDecay`，`:205` 缺省取 `weightHalfLifeDays`）；`config/config.yaml.example:72` |
| 频率信号 | `log(1 + retrieval_count) × factor + 1`，输出域 ≥1 | `search-engine.ts:217-219` |
| 类别信号 | `userFlagMultiplier: 2.0`（乘数）；`currentConversationBoost: 1.5`（配置项在示例中仍为注释态，运行时由默认值提供） | `config/config.yaml.example:75,77` |
| 融合上游 | 加权 RRF（alpha 0.4、双路 `bothBoost`）在 rerank 之前，`rrfScore` 量纲与五个乘数完全不同 | `search-engine.ts:131-137`（`applyBothBoost`） |
| debug 通道 | `debug=true` 注入 `rrfScore / finalScore / timeDecay / frequencyBoost / conversationBoost / multiHitCount` 六字段 | `search-memory.ts:68`（开关）、`:82-88`（字段）、`:596-611`（注入点） |
| rerank 近期变更 | 该文件最后一次改动是 9/17 的 F20260917cvid（本对话加成），此后无排序信号改动 | `git log --oneline -- src/usecases/memory/search-engine.ts`：最新 `da994d3a` |
| 评测基线 | 三项地板 0.673 / 0.707 / 0.811（n=44，FTS-only 口径） | `tests/usecases/memory/golden-eval.test.ts:54-56` |

**反事实前提（父文档实测，实施时必须继承）**：v2 种子集上五信号 rerank 是净负贡献——
全中性化 0.7998/0.8029/0.9364 高于基线 0.6732/0.7079/0.8114，仅关时间衰减 0.7669/0.7810/0.8845
同样反升，而仅关本对话加成 0.6611/0.7026/0.7981 略降。含义：地板只能拦「变差」，
**证明变好要靠逐信号对比表**；合成集局限已在父文档声明，不在此重复收口。

## 目标与非目标

**目标（承父文档 G2/G3，仅 Phase 1 范围）**
- P-1：五个信号统一到 [0,1] 量纲后加法融合，消除连乘的量级耦合与方差放大。
- P-2：系数可配置、可标定、可回滚——网格搜索在同一份基线上跑，选型有数字依据。
- P-3：排序可解释——debug 通道输出各信号贡献分量，逐信号对比表能直接从通道采集。

**非目标（承父文档，不扩范围）**
- 不换检索骨架：FTS5/Vec 双路召回与加权 RRF 融合不动。
- 不引入 LLM rerank / query 意图分类路由：父文档已列为非目标，本文不翻案。
- 不做 golden 集真实数据校准：那是 R2 的后续独立工作（见「待拍板」）。

## 方案设计

### 1. 逐信号归一化口径

| 信号 | 现状量纲 | 归一化 | 输出域 | 取舍理由 |
|---|---|---|---|---|
| `rrfScore` | RRF 累加值（0, ~1/(61×2)]，随候选池规模漂移 | 候选池内 min-max：`(x − min) / (max − min)`；单候选池记 1.0 | [0,1] | 池内相对比较是唯一用途，min-max 不引入跨池参数；备选 log 压缩（`log(1+x)/log(1+max)`）在池内极值被离群项拉平时更稳，网格阶段若 min-max 出现平台化（大量并列 0/1）再切，切换须记录在实施 PR |
| `timeDecay` | 已在 (0,1] | 不变（本身同量纲） | (0,1] | 父文档口径：半衰期语义保留，分层半衰期（7d/90d）不动 |
| `frequencyBoost` | `log(1+n)×factor+1`，≥1 且随 factor 无上界 | 饱和截断：`min(log(1+n), CAP) / CAP`，`CAP = log(1 + 10)` | [0,1] | 截断版跨查询稳定、不依赖池内极值；父文档的「log 后归一」若用池内归一，会被单条高频条目整体压缩，故取 CAP 方案 |
| `userFlagged` | 类别，乘数 2.0 | 转加法偏置 `b_flag ∈ {0,1}` | {0,1} | 类别信号不参与连续量加权，避免「倍数」在加法域失去语义 |
| `conversationBoost` | 类别，乘数 1.5 | 转加法偏置 `b_conv ∈ {0,1}` | {0,1} | 同上；本对话加成的相对强度改由 `b_conv` 网格标定 |

### 2. 融合公式与系数

```
score = w_rrf · norm(rrf) + w_time · timeDecay + w_freq · norm(freq)
        + b_flag · [user_flagged] + b_conv · [同对话来源]

约束：w_rrf + w_time + w_freq = 1，w_* ≥ 0；b_flag、b_conv ≥ 0
```

- 权重和为 1 保证连续部分恒在 [0,1]，偏置项只做加法抬升——分数域可解释，
  系数变化对排序的影响可线性外推（乘法域做不到）。
- 施加约束的方式：网格阶段直接枚举满足约束的组合（不必上 softmax 参数化）；
  运行时对配置做归一化校验，权重和不为 1 时按比例归一并告警，不静默采用坏配置。

### 3. 配置与兼容期

新增键（`config/config.yaml.example` 的 weights 段）：

```yaml
rerank:
  w_rrf: 0.6        # 网格标定回填
  w_time: 0.3       # 网格标定回填
  w_freq: 0.1       # 网格标定回填
  b_user_flag: 0.05 # 网格标定回填
  b_conv: 0.05      # 网格标定回填
  freq_cap: 10      # frequency 饱和截断上限
```

兼容期处理：
- `userFlagMultiplier`、`currentConversationBoost` 被 `b_*` 取代——**保留一个兼容期**，
  旧键存在且新键缺失时回退旧行为（乘法路径）并告警，一个发布周期后移除。
- `weightHalfLifeDays` / `weightHalfLifeDaysDocument`、`frequencyBoostFactor` 中的
  半衰期语义继续有效（time_decay 不变）；`frequencyBoostFactor` 在新路径下废弃，
  同按兼容期处理。
- **默认行为会变**：标定后的系数使默认排序与今天不同——这是本特性的目的本身。
  实施 PR 需按 golden 前后数字判断是否标 `[Incompatible]`，判定写进实施 PR 描述。

### 4. debug 分量扩展

在 `search-memory.ts:68` 既有 debug 通道上增加贡献分量（不新增开关）：
`contrib_rrf / contrib_time / contrib_freq / bias_flag / bias_conv`（各自 =
归一值 × 权重或偏置），与既有 `rrfScore / finalScore / timeDecay / frequencyBoost /
conversationBoost / multiHitCount` 六字段并列（字段清单见 `search-memory.ts:82-88`
扩展后的同接口）。用途：逐信号对比表从通道直接采集，不靠外部重算。

### 5. 网格搜索标定步骤

1. 冻结基线：`npm run eval:golden` 在 main 当前状态跑一次，记录三项数字
   （与地板 0.673/0.707/0.811 对照，不一致先查环境再动参数）。
2. 搜索空间：`w_rrf ∈ {0.4,0.5,0.6,0.7,0.8}`、`w_time ∈ {0,0.1,0.2,0.3,0.4}`、
   `w_freq = 1 − w_rrf − w_time`（丢弃负值组合）、`b_flag, b_conv ∈ {0,0.02,0.05,0.1}`。
3. 选择准则（写死，不临场调整）：在 **三项指标均不低于基线** 的组合中取 nDCG@5 最高者；
   并列取参数更少偏离默认者（更保守）。主指标 nDCG@5、副指标 nDCG@10 与 MRR 只做不劣约束。
4. **无组合达标** → 触发父文档 R3 备选：保留乘法、只做信号归一化预处理（各信号先归一
   再连乘），把网格结果与该结论写入实施 PR 与新记录文档（本文合入 main 后即为历史文档，
   不回改——后续结论走新文档 `causal_links.from: [F20261112rnkph]`）。
5. 每个候选组合的三项数字进实施 PR 附表，检视獭可复跑（`npm run eval:golden`）。

## 验收约束（承父文档，收成清单）

实施 PR 必须逐条给出证据，缺一不通过对抗审视：

- [ ] **逐信号前后对比表**：全开 / 全中性 / 逐单关五个信号，各三项指标——绿灯只证明
      没变更差，不证明变更好（父文档明文约束 1）。
- [ ] **地板数字变动附反事实**：下降禁止；上升须附反事实数字佐证方向（约束 2）。
- [ ] **既有测试不回归**：`search-engine` / `search-memory` / `memory-recall` 单测全绿，
      新系数有单测锁定（含单候选池、权重和≠1 的归一化告警、旧键回退三类边界）。
- [ ] **归属声明**：实施 PR 新增配置字段，命中修法决策树「新增配置字段/开关」检查点——
      须按机制识别与四问作答后再声明 `Modification-Class`（本文不代填，避免无实现的空判定）。

## 影响范围（实施阶段）

- `src/usecases/memory/search-engine.ts`：rerank 融合公式、归一化函数、系数配置读取。
- `src/usecases/memory/search-memory.ts`：debug 贡献分量透传。
- `config/config.yaml.example`：新增 `rerank` 段；旧系数键标注兼容期。
- `tests/usecases/memory/golden-eval.test.ts`：地板数字按前后对比更新（须附反事实）。
- `tests/usecases/memory/search-engine.test.ts` / `search-memory.test.ts`：单测同步。

## 取舍与风险

- **R3 继承（加法可能不敌乘法）**：已知反对意见——加法模型削弱强信号连乘的指数放大。
  对策见网格步骤 4，不预设结论；备选路径（归一化预处理 + 保留乘法）等价有效。
- **min-max 池内归一的极值敏感**：单个离群 `rrfScore` 会压缩其余差异。缓解：网格阶段
  观察并列值占比，平台化则切 log 压缩（表 1 已记切换条件与记录要求）。
- **系数标定即默认行为变更**：这是目的而非副作用，但需在实施 PR 明示是否 `[Incompatible]`
  （见配置节），风险接受权归搭档。
- **合成种子集局限**：网格选择在合成集上做，可能过拟合构造分布——父文档 R2 已声明，
  真实数据校准列为后续独立工作，本文不宣称质量水位。
- **机制判定前移风险**：本文只做设计，不提前给出 `mechanism-addition` 判定——空判定
  比不判定更危险，故明确留给实施 PR（验收清单第 4 条）。

## 待拍板（L2，实施 PR 前，不阻塞本文合入）

1. **golden 集真实数据校准的抽查投入**（父文档 R2 / 下一步第 3 项）：44 条标注由谁复核、
   抽查比例——属资源投入，归搭档。
2. **nDCG 门禁口径是否加严**：现有口径是「地板 = 不许变差」；若要「新实现必须优于
   基线 N%」属额外门槛，影响后续所有排序 PR 的通过率——归搭档。
   本文默认沿用现有口径，不擅自加严。

## 验证（本文档）

- `npm run lint:docs` / `npm run lint:intent` / `node scripts/lint-capability-docs.mjs`
  在 commit 钩子链内全绿（pre-commit 随 `npm run check` 执行）。
- 文中代码锚点由检视獭锚点重放逐条核对（PR 时间线留痕）。
- 无行为变更：`npm run eval:golden` 数字不受本文影响（可复跑对照 0.673/0.707/0.811）。

## 下一步

1. 本文过对抗审视 → 搭档终审合入。
2. 实施 PR（Phase 1）：按本文网格步骤标定系数、落实施工、按验收清单逐条出证据。
3. 实施 PR 之后的结论（尤其触发 R3 备选时）新建文档记录，`from: [F20261112rnkph]`。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
