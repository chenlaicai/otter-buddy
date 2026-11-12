---
id: F20261112cbmsg
title: 记忆检索排序优化：golden 语料跨层正例缺口与填充规格（撞车审计后待认领）
doc_type: feature
summary: >
  「记忆检索排序优化」第六份文档，只补一个具体缺口、不重写任何设计：现有 50 条 golden 语料
  的正例（相关度 ≥2）里，19 条带 conversationId 的条目 100% 是 message 层，feature/research/
  fact/*_chunk 层的 conversationId 全为 null——于是 conversation_boost、文档层 90 天半衰期、
  层感知这三类改动在合成集上**没有任何正例观测面**，地板数字对它们结构性不敏感。本文给出
  缺口核算（分母/命中集/数字）、四类补语料的行级规格、地板漂移处置协议与三条验收断言，
  并附同日撞车审计（11/12 与 11/11 四个未开 PR 的载体、两处口径漂移）。零代码变更。
change_type: refactor
status: design
created_at: 2026-11-12
created_in_conversation: 276c08db-a82f-4e42-a78d-610d7f413baa
tags: [memory, retrieval, ranking, golden-eval, corpus, conversation-boost, layer-aware, conflict-audit]
modules: []
capability_test: "n/a: 纯设计文档，零代码与零语料改动（modules 为空）；文中数字全部由 golden-corpus.ts 静态核算复现，落地在语料填充 PR 的 golden-eval.test.ts 用例中"
tests_planned:
  - tests/usecases/memory/golden-eval.test.ts
  - tests/usecases/memory/search-engine.test.ts
capability_gate:
  change_type: refactor
  value: "n/a: 纯文档，未触碰提示词/skill/协议层"
causal_links:
  from: [F20261008mrrk]
  related_inflight: [F20261112rnkph, F20261112arlxv, F202611121wv8, F20261112lmcba]
intent:
  problem: >
    排序优化的整条工作线都在用 golden 地板（0.673/0.707/0.811）当保护闸，但语料本身有一个未被
    记录的结构缺口：50 条语料中 19 条带 conversationId 的条目全部是 message 层，其余五类
    content_type（fact/feature/feature_chunk/research/research_chunk）的 conversationId 一律为 null。
    后果有三：① conversation_boost 的任何层感知/取值改动在合成集上只可能被 message 层观测；
    ② 文档层 90 天半衰期的取值改动缺少同龄对照正例，改错了地板照样绿；③「地板不许变差」
    的语义在这三类改动上是空转的保护，而 F20261111arlxv 已实测「44 条合成集上全中性化比
    生产默认高 0.13 nDCG@5」——地板保护的反而可能是比反事实更差的配置。
  expected_effect: >
    交付一份可机械执行、不需要重新设计的语料填充规格：① 缺口核算（分母、命中集、六层
    conversationId 归属表、年龄分位数、两档半衰期的 decay 区间、winner 领先对照）；② 四类补
    条目（同对话 fact、同对话跨层同龄成对、旧文档正例对照、异构簇）的行级规格与查询标注；
    ③ 地板漂移处置协议（新语料上线即重锁地板，不许边补语料边调系数）；④ 三条可 PASS/FAIL
    的验收断言，以及「不做什么」的负面清单。本文零代码变更，填充 PR 落规格后可由
    npm run eval:golden 与新断言直接判读。
  verify_by:
    type: metric_probe
    note: "判据为静态核算表（六层归属/年龄分位数/decay 区间）+ 落地 PR 的 golden 指标前后对照；数字可一条 node 脚本从 golden-corpus.ts 复算，无模糊词"
---

# F20261112cbmsg：golden 语料跨层正例缺口与填充规格

> **文档定位**：这是「记忆检索排序优化」序列的第六份文档，**不是又一份设计**，也不与在途载体争口径。
> 它只做一件在途文档都没做的事情：把 golden 语料的**正例覆盖缺口**用数字核算清楚，并给出填法规格。
> 分工与口径以在途载体为准：设计口径 → `F20261112rnkph`（Phase 1 实施设计）；
> 施工顺序与子问题台账 → `F20261112arlxv`（实施规格）；量级实测 → `F202611121wv8`；
> 层感知诉求的唯一记录点 → `F20261112lmcba`。**本文只补语料层，不改任何设计决策。**
>
> 撞车审计结论一句话：本序列 11/12 与 11/11 已有四份未提交/未开 PR 的文档（见第五节），
> 其中两份存在**同一主题两份载体**与**一处口径漂移**——本文写这份审计时同步给搭档，但不在本文内裁决。

## 一、为什么需要这一份

排序优化线上每一次行为改动都被同一个闸门保护：`tests/usecases/memory/golden-eval.test.ts`
的三项回归地板（`nDCG@5 ≥ 0.673 / nDCG@10 ≥ 0.707 / MRR ≥ 0.811`，锚点
`golden-eval.test.ts:54-56`）。这个闸门的语义是「指标不许变差」，它能拦住一种失败：
**改动把原本排对的排坏了**。

但它有一个从未被记录的前提：**语料里得有「排对这个配置」的正例**。如果某类信号或某类
条目在语料里根本没有正例，那么依赖它的改动无论改对改错，指标都不动——闸门对这个改动
是空的。这不是地板灵敏度问题（那个 F20261008mrrk 已声明过：五信号在本种子集上是净负
贡献），而是**覆盖缺失**问题，成因更底层，修法也不同（不是调容差，是补语料）。

## 二、缺口核算（2026-11-12 对 main `cd3961de` 静态核算）

核算对象：`tests/usecases/memory/golden-corpus.ts`（`CORPUS` 50 条、`GOLDEN_QUERIES` 44 条）。
复算方式：一条 node 脚本对 `entry(...)` 调用与 `expected` 字面量做正则提取（规格见 §4.3 AT-3），
不跑检索、不依赖 DB。

### 2.1 六层 conversationId 归属（缺口本体）

| contentType | 条目数 | 带 conversationId | 备注 |
|---|---:|---:|---|
| message | 19 | **19** | 全部 CONV_ALPHA / BETA / GAMMA |
| fact | 15 | **0** | golden 里的 fact 一条都没有会话归属 |
| feature | 7 | **0** | 文档层，跨对话资产 |
| feature_chunk | 4 | **0** | 同上 |
| research | 3 | **0** | 同上 |
| research_chunk | 2 | **0** | 同上 |
| **合计** | 50 | 19 | **正例 conversationId 覆盖面 = 1/6 层** |

带会话归属的 7 条 CONV_ALPHA 条目全部是 message：
`g-msg-07`(5d) / `g-msg-08`(4d) / `g-msg-09`(2d) / `g-msg-10`(1d) / `g-clu-01b`(4d) /
`g-clu-02b`(2d) / `g-clu-05b`(3d)。

> ⚠️ 与在途文档的一处口径漂移：`F20261112lmcba` §2.3 写道「多数 fact 由当前对话产生，**也携带
> conversationId**（golden 语料 `g-fact-09` 即 CONV_ALPHA）」。**实核不成立**——
> `golden-corpus.ts` 中 `g-fact-09` 的 conversationId 实为 `null`，全部 15 条 fact 无一携带。
> 该论断的生产侧直觉（fact 由对话产生故带归属）可能为真，但「golden 里已有」这半句是假的，
> 而它正是那份文档判定「层感知样本量只有个位数」的分母来源。本文不改那份文档（历史文档
> 不改、在途文档归其线程），记入第五节撞车审计。

### 2.2 年龄分布与 time_decay 取值区间

年龄分位数（50 条）：**P0=1d / P25=7d / P50=45d / P75=100d / P100=365d**。

| 半衰期 | decay min | P25 | P50 | P75 | max | P75/P25 |
|---|---:|---:|---:|---:|---:|---:|
| 7 天（working） | 2.0e-16 | 5.0e-5 | 1.2e-2 | 0.50 | 0.906 | **1.0e4** |
| 90 天（document） | 0.060 | 0.463 | 0.707 | 0.947 | 0.992 | **2.05** |

这张表坐实了 `F202611121wv8` 提出的支配性前提：working 层的 decay 跨 15 个数量级，
任何在同层内竞争的名次差异几乎都被年龄抹平。同时也暴露缺口——**document 层的 decay
P75/P25 只有 2.05**，即文档层内部的年龄差异很小，改文档半衰期（90→60/180）在合成集上
本来就只有 2 倍量级的扰动，再没有「同龄跨层成对正例」的话，观测面接近零。

### 2.3 winner 领先对照（正例里有多少查询在跟年龄对抗）

对每条查询取两个最高分级正例，统计「最高分级条目年龄 ≥ 次高分级条目年龄 2 倍」的查询数：

**44 条查询中有 6 条**满足（A5、B1、B3、C10、E2、E4），例如：

| 查询 | 最高分级正例 | 次高分级正例 | 年龄比 |
|---|---|---|---|
| A5 | `g-fact-05` 3 分 @180d | `g-feat-01-c2` 2 分 @40d | 4.5× |
| B3 | `g-msg-03` 3 分 @120d | `g-fact-03` 2 分 @1d | 120× |
| C10 | `g-feat-05` 3 分 @260d | `g-fact-04` 2 分 @90d | 2.9× |
| E4 | `g-clu-02c` 3 分 @45d | `g-clu-02b` 2 分 @2d | 22.5× |

这 6 条是语料里**唯一能让「排序信号压过年龄」被观测到**的查询，占 13.6%。它们全部靠
「分级差 1 级」而不是「信号强到逆转年龄」取胜——换句话说，语料里**没有一个**「分级相同时
排序信号应当翻盘」的判别式（E1 是唯一例外，但它靠的是本对话加成 + 同簇干扰，观测面窄）。

### 2.4 缺口一句话

> **凡是不经过 message 层 × 本对话加成的排序信号，在 50 条语料、44 条查询上没有正例观测面。**
> 具体地：`conversation_boost` 的取值与层感知、文档层半衰期的取值、frequency/user_flag 跨层
> 的相互作用——三者的地板保护全是空转。

## 三、目标与非目标

**目标**

- **G1**：把六层 conversationId 归属、年龄分位数、decay 区间、winner 领先对照写成可复算的表，作为后续一切「地板灵敏度」讨论的基线事实（本文第二节已完成）。
- **G2**：给出四类补语料的行级规格（条目字段 + 查询 + 期望标注），使填充 PR 不需要重新设计、只需照抄与跑断言。
- **G3**：写出地板漂移处置协议——补语料必然改变指标，不写清处置顺序就会变成「边改语料边调系数」的双变量混改。
- **G4**：给出一条负面清单，明确哪些「看起来相关」的补法**不要做**（见 §4.4）。

**非目标**

- **不重写 Phase 1 设计**（归一化口径、融合公式、权重标定）：那是 `F20261112rnkph` / `F20261112arlxv` 的管辖面。
- **不裁决层感知方向是否实施**：`F20261112lmcba` 已把它定为「暂缓 + 四条重启条件」，本文只补它的分母缺口，不改它的结论。
- **不引入真实数据**：本规格仍只用合成语料，真实数据校准是独立课题（记忆：golden 查询集是合成种子集，待真实使用数据校准，搭档需抽查标注质量 `g-fact-09`）。
- **不动生产代码、不动配置**：零行为变更。
- **不扩大语料规模**：补条目控制在 +12 条以内（50 → ≤62），避免把 golden 跑慢、避免把合成集做得更像真实数据而导致过拟合到更窄的口径。

## 四、方案设计

### 4.1 四类补条目（规格，非实现）

所有新条目沿用现有 `entry(id, layer, contentType, ageDays, content, conversationId)` 构造器，
`daysAgo(N)` 动态相对时间（#1126 日期炸弹规矩不变），`metadata.corpus` 升级为 `golden-seed-v3`，
便于新旧语料分开统计。

**C1 同对话 fact（补 fact 层的 conversationId 缺口）——2 条**

| id | layer | contentType | age | conversationId | content 要点 |
|---|---|---|---:|---|---|
| `g-fact-cv01` | working | fact | 6 | CONV_ALPHA | 「本对话：检索排序评测口径定为 nDCG@5 与 MRR 双指标」——与 `g-clu-02b`（message，2d）同义不同粒度 |
| `g-fact-cv02` | working | fact | 30 | CONV_BETA | 「对话记录：排序指标讨论结论是 nDCG 优先」——跨对话对照项，谓词恒假 |

配 1 条查询：

- `D7`（layer=conversation，注入 CONV_ALPHA）：`expected: { "g-fact-cv01": 3, "g-clu-02b": 2 }`
  ——同对话内 fact 提炼 vs message 原话的粒度偏好判别式（`F20261112lmcba` 指出的「正确形态」）。

**C2 同对话跨层同龄成对（补文档层谓词恒假的观测缺口）——4 条（2 对）**

| 对 | 条目 | contentType | age | conversationId | 说明 |
|---|---|---|---:|---|---|
| P1 | `g-pair1-a` | message | 20 | CONV_ALPHA | 「本对话：个人云端中枢方案初稿」 |
| P1 | `g-pair1-b` | feature | 20 | null | 「F2029xxxxxxx 个人云端中枢方案（成文）」——同龄、同主题、无会话归属 |
| P2 | `g-pair2-a` | message | 60 | CONV_ALPHA | 「本对话：守卫实录整理需求」 |
| P2 | `g-pair2-b` | feature | 60 | null | 「守卫实录整理方案断言草案」——同龄，用来观测文档层半衰期 |

配 2 条查询，**期望分级刻意写成「同分级」**，让排序信号成为唯一区分力量：

- `E12`（probe，注入 CONV_ALPHA）：「方案 成文 哪一版」`expected: { "g-pair1-b": 3, "g-pair1-a": 2 }`
  ——文档层应当因为「成文」语义胜出，同时 conversation_boost 作用在 message 上（→ 若未来把
  加成放宽到文档层，这条查询的期望排序会变，成为负向约束的判别式）。
- `E13`（probe，不注入）：「守卫实录 整理 方案」`expected: { "g-pair2-b": 3, "g-pair2-a": 2 }`
  ——无会话归属时的纯文档层对照，改 `weightHalfLifeDaysDocument` 应当在这里有数字响应。

**C3 旧文档正例对照（补「文档层非正例」的偏置）——4 条**

现有文档层 16 条里，`g-feat-03`(20d) / `g-feat-06`(10d) / `g-feat-07`(55d) 是新正例，其余
多为干扰项；文档层 decay 区间只有 2 倍差异，改半衰期的效应极弱。补两条**同主题、年龄差 3 倍**
的正例，让半衰期改动有可测的年龄差：

| id | contentType | age | expected 出现处 |
|---|---|---:|---|
| `g-doc-old01` | research | 270 | `C11`：research 层 270d 正例，对照 `g-res-01`(75d) |
| `g-doc-old02` | feature_chunk | 180 | `C12`：chunk 层 180d 正例，对照 `g-feat-01-c3`(40d) |

**C4 异构干扰簇（补跨层干扰，非本对话加成）——2 条**

| id | contentType | age | conversationId | 用途 |
|---|---|---|---:|---|
| `g-het-01` | message | 15 | CONV_BETA | 与 `g-het-02` 同簇，E14 查询里对抗本对话加成 |
| `g-het-02` | fact | 15 | null | 同簇、同龄、跨层——观测 content_type 差异而非年龄差异 |

配 `E14`（probe，注入 CONV_ALPHA）：「同对话 检索 排序 记录」`expected: { "g-het-01": 3, "g-het-02": 2 }`。

**总账**：+12 条条目（50 → 62），+5 条查询（44 → 49），新增/调整期望标注 5 处。
门槛：`golden-eval.test.ts:74` 的 `GOLDEN_QUERIES.length >= 30` 与探针层守卫
（`PROBE_CLUSTER_PREFIXES`，E 层必须引用近邻簇）继续满足。

### 4.2 地板漂移处置协议（G3）

补语料会改指标，这是**预期的**，但必须按序处置，否则双变量混改无法归因：

1. **先补语料、别动代码**：在语料 PR 内只改 `golden-corpus.ts` 与新断言，跑 `npm run eval:golden` 记录新数字 N1。
2. **重锁地板**：若 N1 ≥ 旧地板（0.673/0.707/0.811）→ 地板**不动**（语料变更不曾让管线变差）；
   若 N1 < 旧地板 → 地板按 N1 向下取整 3 位重锁，并把「旧地板 → 新地板」写进特性文档与本 PR 描述。
   ——这一步必须单独成 commit，且该 commit 的 message 要写明「地板重锁：语料填充 N 条，指标从 X → Y」。
3. **填完语料再谈系数**：任何 Phase 1 的系数改动，必须基于新语料重跑的反事实矩阵
   （`F20261111arlxv` 的加法反事实矩阵），不得用旧语料的数字。
4. **反事实方向复核**：新语料上线后重跑 F20261008mrrk 的「五信号全中性化」反事实——若中性化
   仍显著优于默认，这是**信号层问题而非语料层问题**，应当直接进 Phase 1 的取舍决策，不在本文处理。

### 4.3 验收标准（可机械判读）

| 编号 | 场景 | 操作 | 预期结果（PASS/FAIL） |
|---|---|---|---|
| AT-1 | 缺口已补 | `node -e` 提取 `golden-corpus.ts` 的 `entry(...)` 与 `expected`，按 contentType 统计 conversationId 非 null 的条数 | 输出表 PASS 当且仅当：fact / feature / message 三层的 conv≠null 条数均 ≥2；research/feature_chunk 层 conv≠null 条数 ≥1（或显式声明「文档层不做会话归属，见 §4.4 负面清单」） |
| AT-2 | 同龄成对正例存在 | 同上脚本，检查是否存在「两条同龄（age 相同）、不同 contentType、至少一条在 expected 里分级 ≥2」的成对组 | 至少 2 对；否则 FAIL（意味着文档层半衰期改动仍然观测不到） |
| AT-3 | 地板与新语料一致 | `npm run eval:golden` 打印的 `nDCG@5/@10/MRR` | 与 `golden-eval.test.ts:54-56` 三常数逐项一致（地板已按 §4.2 重锁时）；7 个用例全绿 |
| AT-4（人工判读） | 标注质量 | 新条目的 content 与 expected 分级是否语义一致、是否覆盖「分级相同 + 排序信号翻盘」的形态 | 每条新查询都能一句话说出「为什么这条该排第一」，且理由不依赖年龄 |

### 4.4 负面清单（不要做）

- **不要加「分级相同但希望排序翻盘」以外的干扰项**——成对正例的目的正是让「分级相同」，
  如果新条目被标成不同分级，年龄差被 absorption 掉，缺口其实没补。
- **不要把 fact 层一律标成 CONV_ALPHA**——`F20261112lmcba` 的结论是层感知只影响 message 与本对话 fact
  两类，如果 fact 全带会话归属，谓词命中集会被放大到不可归因；C1 只加 2 条、其中 1 条故意跨对话。
- **不要为了「让地板变绿」而放宽容差**——`golden-eval.test.ts:46` 的容差是 0（本地与 CI 同刻），
  改容差等于把闸门变软，归入「省事声明即触发论证」的论证义务（见 code-implementation 步骤 4）。
- **不要补进真实数据**——真实数据校准需搭档抽查标注质量（记忆条目 `g-fact-09` 的语义），
  本文规格仍是合成语料。
- **不要同时改语料与改代码**——§4.2 第 1 步是硬约束。

### 4.5 设计取舍

- **选「成对同龄」而不是「扩大年龄跨度」**：年龄跨度已被 50 条语料用满（1–365d），再加不会
  增加信息；成对同龄把变量压到 contentType 与 conversationId 两个维度，才能把「这一层信号
  有没有作用」孤立出来。代价：新语料更规整、更不像真实分布（正负两面都要认）。
- **选「+12 条」而不是「+50 条」**：合成集做得越大越容易过拟合到标注者的直觉；+12 条足够让
  缺口被观测，理论上限是「每类至少 2 条正例」。
- **不选「引入真实检索日志做 golden」**：那是另一个课题（需要埋点与人工标注），会拖慢本规格的
  可执行性。本规格只保证「设计假设可被语料验证」，不保证「语料即真相」。
- **不选「把层感知直接否掉」**：`F20261112lmcba` 已做（暂缓 + 四条重启条件），本文只补分母，
  不改结论——补完语料后该文档的 T2（真实数据 >100 条/查询）触发条件依然有效。

## 五、同日撞车审计（只陈述，不裁决）

盘点 2026-11-12 15:00–16:50 的现场（`git status`、`gh pr list`、`git worktree list` 实查）：

| 载体 | 位置 | 状态 | 与本文关系 |
|---|---|---|---|
| `F20261112rnkph`（Phase 1 实施设计） | `.otter/worktrees/memory-ranking-phase1` 分支内已提交（commit `3e9abb6d`） | **未开 PR**；分支 `docs/F20261105rnkph-memory-ranking-phase1` 仍挂在 origin 上（旧命名） | 设计口径权威；本文不改 |
| `F20261112arlxv`（实施规格与子问题台账） | 同 worktree 分支，最新 commit `05292278`「定稿改名：合入日 2026-11-12」 | **PR #1856 已 CLOSED（08:14 UTC）且未合入**，分支仍存在 | 施工顺序权威；本文不动 |
| `F202611121wv8`（time_decay 支配性实测） | 主仓未提交（`?? docs/features/2026/11/12/`） | 零代码变更的设计文档 | 量级前提；§2.2 的表是它的输入 |
| `F20261112lmcba`（层感知撞车审计） | 主仓未提交 | 同上 | §2.1 的漂移点属于它；本文不动 |
| `F2026111264ya`（层感知系数校准） | 主仓未提交（DS 线程，`created_in_conversation` 非本对话） | 未提交 | 与 lmcba 同一主题两份载体 |

**两处需要搭档拍板的口径**（本文只记录）：

1. **`F20261112rnkph` 与 `F20261112arlxv` 同一主题两份载体、PR #1856 已 CLOSED 未合入**——
   是继续在同一分支上重开 PR，还是拆成两份？两种都合规，但需要有人认领并说明。
2. **`lmcba` §2.3 的事实漂移（`g-fact-09` 实为 null）**——该文档已被 `F202611121wv8` 引为
   「层感知样本量只有个位数」的分母依据，事实错了但结论方向未必变（因为 fact 层确实零正例）；
   在途文档归其线程，本文只记不裁。

## 六、影响范围

- **改动面**：`tests/usecases/memory/golden-corpus.ts`（+12 条、+5 查询、`metadata.corpus` → `golden-seed-v3`）；
  `tests/usecases/memory/golden-eval.test.ts`（地板重锁 commit + 新断言 AT-1/AT-2）；
  `docs/features/`（本文）。
- **不动的面**：`src/usecases/memory/*`、`config/*`、任何 prompts / skill / 协议层。
- **对既有地板的影响**：§4.2 明确「先补语料、后重锁、再调系数」的时序；对 Phase 1 的反事实矩阵
  基线数字**会过期**，这是预期行为，不是回归。
- **对记忆库的影响**：本文 `sync_docs` 后即可检索；`golden-seed-v3` 标识使新旧语料在同一
  DB 内可分辨（评测仍在测试进程内构造，不进生产库）。

## 七、验证

- **本文自身**：零行为变更；通过 `npm run lint:docs`（新增文档 5 字母后缀 `cbmsg`）、
  `npm run lint:intent`（`intent.verify_by.type = metric_probe`）、`AS_SUBAGENT=true git commit`。
- **数字可复算**：§2.1–§2.3 的六层归属、年龄分位数、decay 区间、winner 领先对照，均可用一条
  node 脚本从 `golden-corpus.ts` 正则提取后重算；本文附复算口径（§2 节首）。
- **落地 PR 的验证**：AT-1/AT-2/AT-3 机械判读，AT-4 人工判读；落地时附复算脚本输出与
  `npm run eval:golden` 前后对照。

---

## 下一步

- **认领建议**：语料填充落地 PR 与 `F20261112arlxv` 的第三段（网格标定）**串行**，不并行——
  先补语料、再跑反事实矩阵、再定系数。理由见 §4.2。
- **待拍板（§5）**：`rnkph/arlxv` 双载体与 PR #1856 已 CLOSED 的处置；本文不代决。
- **不阻塞**：本文交付只提供规格与核算，不产生代码；落地由后续 PR 认领。

---

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
