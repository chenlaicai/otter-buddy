---
id: F20260917sdpl
title: SDLC Playbook 落地三件套：软代码 PR 事前断言收口 + 需求结晶前置 + 修复验证闭环
summary: 对标 Anthropic AI-Native SDLC Playbook（14 课全文已入库工作区）三轮吸收：①软代码 PR 的 verify_by 声明从「存量宽容 warning」收口为「新 PR 必须声明且 golden_replay 必须跑」——补上 lint-intent 已铺好路但从未关上的门；②requirement-analysis 前置「需求结晶五问」防呆门（tutu-vessel 补充研究 R20260821supp 判定为 otter 最缺的门，课程 intent.md play 证实同构价值）——非正式讨论直奔方案时跳过，进方案必有结晶段；③troubleshooting→code-implementation 之间补「根因确认后先固化失败用例」纪律——修复不允许「无失败证据链」地交付，agent 自证通过的最短路径（改断言）由纪律封死。三项均为流程/prompt 层改动，无系统机制新增。
change_type: feature
created_in_conversation: 15c94835-fe92-4bfc-9bd0-49d56f9dbb10
tags: [sdlc-playbook, verify-by, requirement-analysis, troubleshooting, golden, intent, skill]
intent:
  problem: "海獭系统的软代码改动（SYSTEM.md/skills/prompts）PR 依赖事后 healing 暴露回归——verify_by 声明是 warning 不强制、golden 场景集存在但 PR 不必然触发；需求进入方案流程缺防呆门（方向错在方案后期才暴露）；bug 修复交付时无失败用例固化纪律（修没修对靠人肉对照）"
  expected_effect: "新软代码 PR 100% 携带 verify_by 声明且声明 golden_replay 时 results.jsonl 有对应记录；进 requirement-analysis 的模糊需求 100% 先过结晶五问（省事声明豁免需搭档明示）；bugfix 类 PR 的 Verification 节附失败用例证据（或记录豁免理由）"
  verify_by:
    type: behavior_check
    detail: "落地后下一个软代码 PR：lint-intent 拦截无 verify_by 的 docs/features 新文档（error 非 warning）；下一个走 requirement-analysis 的模糊需求文档含结晶五问段；下一个 bugfix PR 的 Verification 节附失败用例。lint 通过（lint:intent 0 error，存量文档不受影响）"
modules: [scripts/lint-intent.mjs, .pi/skills/requirement-analysis/SKILL.md, .pi/skills/troubleshooting/SKILL.md, .pi/skills/worktree-isolation/SKILL.md]
capability_test: tests/lint/lint-intent.test.ts
created_at: 2026-09-17
---

# SDLC Playbook 落地三件套

## 背景（意图锚）

搭档原话（本轮对话）：

> 「你来洞察下 https://academy.claude.com/zh-CN/courses/ai-native-sdlc-playbook」

洞察报告产出后（14 课全文转 markdown 已存对话工作区 `ai-native-sdlc-course-md/`），我提出四条可吸收点，搭档逐条裁决：

> 「1.不行的，因为有时候你写了特性文档，我还需要审视的，所以这个节点我坚持保留 人工卡点」
> 「2.这点很重要但不是没做过，我以前也提过多次……今天的rsi也是啊，golden test，都是这个。语义级无法靠测试代码来看护，只能由咱们系统真实的案发现场来验证」
> 「3.这点也非常好！我记得以前提过grill with doc这个开源skill，也是类似于这种效果，我认为非常需求」
> 「4.这点也很好！」

> 「你先出方案，拉上kimi一起审视方案。分析设计要有全局思维，好好干！」

裁决结果：#1 撤回（人工卡点是课程原设计——「human attention concentrates at the gates」，自动化只接管 gate 通过之后的续链准备；本项目 F 文档终审已是该形态）；#2/#3/#4 立案成案。本方案是 #2/#3/#4 的设计。

## 现状盘点（全局摸底，2026-09-17 实测）

### 已有基建（本方案站在其上，不重复建设）

| 设施 | 锚点 | 状态 |
|------|------|------|
| verify_by 五枚举（metric_probe/behavior_check/human_judge/capability_test/golden_replay/static_only） | `scripts/lint-intent.mjs:39-45` | 已落地 |
| 软代码判定（modules 含 `prompts/` 或 `.pi/`） | `scripts/lint-intent.mjs:51-55` | 已落地 |
| golden 场景集 + runner + selftest | `tests/capability/golden/`（8 场景 + anchors） | 已落地，CI 跑 selftest（零 LLM）；runner 实际写入 `data/metrics/golden-results.jsonl`，记录字段为 `ts/golden_id/model/n/successes/pr/manual/passed`（无 featureId 字段；`tests/capability/golden/results.jsonl` 为 gitignore 的早期残留，非真相源） |
| 软代码改动 verify_by 缺失 → warning | `scripts/lint-intent.mjs:204-209` | **warning 不阻断**（存量宽容策略，F20260824ax376） |
| 采样断言门禁（capability_test/golden_replay 时 expected_effect 禁模糊词） | `scripts/lint-intent.mjs:193-200` | 已是 error |
| PR 模板 Golden Gate 复选框 | `.github/pull_request_template.md` | 声明性，无机制核对 |
| 需求分析意图锚引用（搭档原话） | `requirement-analysis` SKILL.md 步骤 1 | 已有，但无结构化拷问环节 |
| 修法排序 + 机制识别检查点 | `troubleshooting` SKILL.md 步骤 3 | 已有，但无「先固化失败」环节 |

### 关键判断：门铺好了，没关上

F20260825evgl 设计的完整链是「软代码 PR 声明 intent.verify_by → 检视獭按声明跑场景 → results.jsonl 留痕」。实际执行中链条在三处松动：

1. **声明不强制**：lint 对缺 verify_by 的软代码文档只 warning（存量宽容），新 PR 也会漏声明——PR 模板复选框靠自觉
2. **golden 不必然跑**：声明了 golden_replay 也没有机制核对「这个 PR 的路径真的在 results.jsonl 里出现」
3. **来源无纪律**：golden 场景从案发现场沉淀的原则（搭档原话「只能由咱们系统真实的案发现场来验证」）散落在 F20260825evgl/F20260828gssf 的叙事里，没有成为新场景入库的准入口径

## 目标

- T1: 新软代码 PR 的 verify_by 声明从「建议」收口为「必须」（存量文档不追诉）
- T2: 声明 golden_replay 的新文档，`data/metrics/golden-results.jsonl` 必须存在 created_at 之后的执行记录（fail-closed 对齐 #1002 金标准锚点集的既有门禁语义；CI 无记录环境降级 warning，见改动 2 分环境语义）
- T3: 模糊需求进入 requirement-analysis 前，先过「需求结晶五问」防呆门；搭档明示「省事」可豁免（豁免必须留痕）
- T4: bugfix 类修复交付前，失败用例（测试/诊断脚本/最小复现）先固化——「无失败证据链的修复」不允许交付；不可行时豁免理由写入特性文档
- T5: golden 新场景入库的唯一来源口径 = 真实案发现场（healing events / 事故复盘 / 搭档实锤反馈），禁止合成场景入库

## 非目标

- **不做产物链自动触发**（原 #1）：搭档裁决保留人工卡点；F 文档终审维持现状
- **不做意图捕获新入口**（大白话→intent.md 通道）：课程 intent.md play 的完整形态依赖独立的 intent home + 非工程师 connector，本项目搭档与獭的直接协作密度下不划算；其精神由 T3 结晶门承接
- **不改 golden runner/CI 架构**：场景执行设施已完备（F20260917asgv 刚接入金标准锚点集 + fail-closed），本方案只收口「何时必须跑」
- **不追诉存量**：存量软代码特性文档不补声明（沿用 F20260824ax376 存量宽容原则，避免一次性大 diff）
- **不做 eval 覆盖率指标看板**：度量挂 RHI 已有通道（eval_regression 信号已设计），不新增机制

## 方案设计

### D2（T1+T2+T5）：软代码 PR 断言收口

**改动 1：lint-intent 软代码 verify_by 缺失 warning → error（增量收口）**

`scripts/lint-intent.mjs` 现逻辑（L204-209）：`isSoftCodeChange(fm) && !intent.verify_by` → warnings.push。改为按时间增量判定：

```
created_at >= 2026-09-17（本 F 文档日期为界）且 isSoftCodeChange 且缺 verify_by → errors.push
created_at < 界且缺 → 维持 warning（存量宽容不变）
```

判定依据：frontmatter 已有 `created_at` 字段（存量文档均已携带），无新字段。错误文案给出四选一指引（capability_test/golden_replay/human_judge/static_only，对齐既有 L209 warning 文案口径）——四选一是**引导性推荐集**而非强制集：metric_probe 仍为合法枚举（指标探测验证软代码效果在 RHI 信号场景下成立，如 eval_regression），lint 不拦「软代码 + metric_probe」组合，检视獭遇到时按实际验证方式判断合理性。

**改动 2：golden_replay 声明的执行核对（弱机械核对 + 检视因果核对）**

> 检视纠错（检视獭-sdpl 严重发现 1）：初稿误将核对路径写为 `tests/capability/golden/results.jsonl` 且假设记录含 featureId 字段——实测 runner 写入主仓 `data/metrics/golden-results.jsonl`（`golden.runner.ts` resolveResultsPath 经 git rev-parse 推导 repoRoot），字段无 featureId。初稿的核对逻辑建立在对现状的错误假设上，本段已重写。

声明 `verify_by.type: golden_replay` 的新特性文档（created_at ≥ 界），lint 追加**弱机械核对**：`data/metrics/golden-results.jsonl` 中存在 `ts >= 文档 created_at` 的记录行——语义是「该文档创建时点之后系统里真实跑过 golden」，堵住「声明了但压根没跑」这个最粗的漏网。因果核对（记录里的 golden_id 是否覆盖 verify_by.detail 声明的场景）是语义判断，交检视獭对照。

为何不用更强的核对键（两案均否决，理由留痕）：
- **pr 字段**：runner 的 pr 来自 PR_NUMBER env（CI 注入）或 manual 标记——lint 在 pre-commit/PR 创建前运行，时序上 PR 号尚不存在，无法作为核对键
- **runner 增写 featureId 字段**：需改 runner 写入结构（新增字段 = 新增机制承诺，违背本方案零机制新增定位）；且场景与 F 文档是多对多关系（一个场景服务多个 F 文档），featureId 归属语义不成立

错误文案：「声明了 golden_replay 但 data/metrics/golden-results.jsonl 无 created_at 之后的执行记录——先跑 `npm run test:capability:only`，fail 行按 PR 模板 Golden Gate 条款处置」。

**lint 行为分环境**（检视獭-sdpl delta 严重发现 1 采纳）：`data/metrics/golden-results.jsonl` 是本地非 git 追踪文件（runner 定位「本地数据沉淀」，gitignore）——CI 干净 checkout 后不存在。行为定义：文件存在（本地）→ error 核对；文件不存在（CI 干净环境）→ warning 提示不阻断（「CI 环境无本地 golden 记录——本核对的真实闸门在本地 lint 时机（文档创建后、PR 前），CI 层只兜底提醒」）。避免 fail-closed 在 CI 变假红（恒 error 阻断一切 golden_replay 声明）——与 R2 否决 CI 强制关门的理由同源：无真实数据的强制门禁是伪门禁，无论假绿还是假红。CI 无 LLM key 的环境下 golden 采样用例 skip，故 CI 不强制跑全量 capability，本地跑 + results.jsonl 留痕即为证据链。

**改动 3：T5 来源口径写入 golden README**

`tests/capability/golden/README.md` 增补「新场景准入」一节：新场景必须携带案发锚点（healing event ID / issue 号 / F 文档号 + 案发现场描述），selftest 断言判别力（F20260828gssf 既有纪律）。禁止三类来源：纯想象场景、未发生过的假设场景、从其他项目移植未本地验真的场景。理由（搭档原话锚定）：「语义级无法靠测试代码来看护，只能由咱们系统真实的案发现场来验证」。

### D3（T3）：需求结晶五问前置

`requirement-analysis/SKILL.md` 工作流步骤 1（解析需求）与步骤 2（意图确认）之间插入「结晶门」：

```
1.5 需求结晶（模糊需求必过；搭档原话含「直接出方案/省事」等明示豁免时跳过，豁免留痕一句话写入特性文档背景节）
  对模糊（必须问）类需求逐项作答：
  C1 这为谁解决什么问题（具体到角色，不接「应该有」）
  C2 现状怎么应付的、代价是什么
  C3 成功长什么样（可观察，不强求数字）
  C4 明确不做什么（至少一项）
  C5 最小可交付是什么（第一刀切在哪）
  逐项同步搭档确认后进入步骤 3；搭档对任一项答不出 → 问题定义未成熟，
  停在结晶门不上方案（防呆：宁可停在门口，不带病进方案）
```

设计说明：
- 五问与 tutu-vessel「需求结晶五问」（R20260821supp 判定「otter 最缺的防呆门」）、课程 intent.md 模板（Problem/Proposed outcome/Affected users/Constraints/Open questions）三方同构，取交集后本地化为五问
- 「模糊/明确」判定复用步骤 1 既有的三类判定（明确/模糊/隐含），不新增判定机制——结晶门只作用于模糊类
- **与步骤 2「意图确认」的边界**（检视建议 2 采纳）：结晶门通过（五问逐项经搭档确认）后，步骤 2 的复述确认**省略**——五问逐项确认已覆盖复述确认的语义（都是「进方案前经搭档确认的理解」），保留两轮会让搭档重复确认；非模糊类需求（结晶门未触发）仍走步骤 2 复述确认
- 搭档豁免语义与 requirement-analysis 既有约束对齐（「行了/就这样」提前终止条款同源）；豁免是搭档显式决策，不是獭自行省略

### D4（T4）：修复验证闭环

两处 skill 文本各增一段：

**troubleshooting SKILL.md 步骤 5（需要修复时）**，转入 worktree 前插入：

```
5a. 固化失败（动手修之前）：
  根因确认后、写修复代码之前，先把「失败证据」固化成可重跑的形态：
  - 可测：失败测试（先跑一遍确认因预期原因失败，再修）
  - 难测（时序/环境/外部依赖）：最小复现脚本或诊断命令 + 预期输出（修复前 vs 修复后对照）
  - 均不可行：豁免理由一句话（为何两者都不可行）写入特性文档，检视獭核对豁免合理性
  修复过程不得改动已固化的失败用例本体（断言变了 = 验证变了）——需调整用例时，
  在特性文档记录调整理由，与修复分属不同 commit
```

**worktree-isolation SKILL.md 特性文档约定段**（bugfix 类 Verification 节）增补：bugfix PR 的 Verification 必须附失败用例证据（修复前失败输出 + 修复后通过输出）或豁免记录。

设计依据：课程 L08「A test that existed before the fix, and that the agent couldn't rewrite, is proof the bug is gone」；agent 的「自证通过」动机比人强（改断言是最短路径），纪律 + 检视核对双保险。本地不做 hook 硬拦截（等价课程 hook 的做法）——理由见取舍表 R3。

## 影响范围

| 对象 | 影响 |
|------|------|
| 新软代码 PR 流程 | 必须 frontmatter 带 verify_by（四选一）+ 声明 golden_replay 者先跑场景；漏声明 lint error，本地 hook 与 CI lint:intent 均拦 |
| 存量特性文档 | 零影响（时间界之前维持 warning） |
| requirement-analysis 流程 | 模糊需求多一轮结晶交互（搭档确认五问）；明示豁免不受阻 |
| troubleshooting→修复流程 | 修 bug 先固化失败证据；多一步但不增加机制 |
| 检视獭 | 新增核对点：①bugfix PR 的失败用例证据/豁免 ②golden_replay 声明与 results.jsonl 记录的因果（golden_id 覆盖 verify_by.detail 声明场景）③结晶门豁免留痕 ④PR 新增文档 created_at 与 git 首提交时间对照（防回填伪造） |
| CI | lint:intent job 行为不变，error 数可能增加（新文档漏声明时）——正是收口意图 |

**三项共用的防绕过分层**（检视建议 1 采纳）：D2 靠 modules/verify_by 自报、D3 靠豁免声明自报、D4 靠豁免理由自报——三项的最终防线同构，显式声明为三层：**自报字段是 lint 的入口（机械可查），检视獭语义核对是闸门（自报与实际改动语义是否相符），搭档终审是兜底**。同一绕过方式（表面合规的自报 + 实际语义不符）对三项同时有效，也因此被同一层闸门（检视獭语义核对）同时拦住——这是有意的分层设计而非偶然重合。

## 风险与约束

1. **收口误伤**：新文档若 modules 字段漏写 `.pi/` 前缀（如只写 `code-implementation`），软代码判定不触发 → 收口漏网。缓解：lint 文案提示 modules 规范写法；检视獭按 PR 实际改动核对 modules 完整性（既有职责）
2. **golden_replay 执行成本**：跑 capability 需要 LLM key + bge-m3，本地环境不可用时被卡。缓解：四选一里 human_judge/static_only 是合法出口（纯文字润色走 static_only）；错误文案给出替代指引
3. **结晶门摩擦**：搭档赶时间时五问是负担。缓解：豁免通道一句话即可（「直接出方案」即触发）；豁免留痕不豁免核对——检视獭仍看结晶段缺失时核对豁免记录
4. **失败用例固化对非代码修复的适配**：纯 prompt 修复（skill 文本改错字类）写测试不成比例。缓解：D4 的豁免通道 + static_only 声明
5. **时间界判定的边界**：created_at 为字符串日期，同日文档按「本 F 文档合入之后的 PR」语义执行，lint 以日期字符串比较（同日新建文档一律要求声明——本方案文档自身即首例）。**created_at 可伪造**（新文档回填旧日期即可把 error 降回 warning）——lint 不防，显式登记为「纪律+检视核对」口子：检视獭对 PR 新增文档按 git log 首提交时间与 created_at 对照，不一致视为伪造打回（与 modules 完整性核对同属检视职责）

## 设计取舍

机制识别检查点（全方案）：☑ 无新增配置字段/枚举语义（VALID_VERIFY_BY_TYPES 不动，只改缺失时的处置）；☑ 无新状态生命周期/定时任务/信号/持久化（results.jsonl 是既有产物）；☑ 无跨模块调用路径新增——**判定：不涉及净新增机制**。保守按四问作答（D2 是既有机制的处置收紧，答四问留痕）：

- ① 谁需要它：检视獭（核对依据从「复选框自觉」变成「lint error + 记录核对」）；搭档（软代码改动的回归暴露从事后 healing 前移到事前声明）
- ② 失败后果：漏网 PR 的软代码回归照旧走事后 healing 暴露（现状不变差）；误拦（环境跑不了 golden）有四选一合法出口，卡不死
- ③ 后续机制：时间界本身可能漂移（未来某天全量收口）——届时删除增量判定恢复一刀切即可，不产生新状态
- ④ 退役条件：软代码 PR 声明 verify_by 成为肌肉记忆（连续 N 个 PR 零漏声明）后，error 收口可降回 advisory——但按「门禁宁紧勿松」预期长期保留

| # | 取舍 | 决策 | 替代方案 | 理由 |
|---|------|------|---------|------|
| R1 | 声明收口的粒度 | 时间界增量（created_at ≥ 2026-09-17） | 全量一刀切 error | 全量会炸出 ~数十个存量文档一次性 error，制造大 diff 噪音；增量收口零存量成本，语义清晰（新规则管新文档） |
| R2 | golden 执行核对放哪层 | lint 核对 results.jsonl 记录存在性 | CI 强制跑 capability（fail 关门） | CI 环境无 LLM key 时采样用例 skip，强制关门会变成 always-green 假门禁；本地跑+入库留痕是真实证据链，检视獭做语义核对补位 |
| R3 | 「不许改失败用例」用纪律还是 hook | skill 纪律 + 检视核对 | 课程式 hook 硬拦截（block 对测试文件编辑） | 本项目无「fix 任务期间 block 测试编辑」的 hook 粒度；且海獭流程里测试调整有正当场景（需求变更类）——一刀切 hook 误伤面大，先纪律后看复发（犯两次再升级，对齐「犯两次才入库」精神） |
| R4 | 结晶门五问 vs 课程 intent.md 完整模板 | 五问（C1-C5）嵌入 requirement-analysis 既有步骤 | 独立 intent 阶段 + intent home 产物链 | 完整形态的重基建（intent 目录/connector/触发）在本项目协作密度下 ROI 不足（搭档在环，不需要异步意图仓库）；五问以 0 机制成本取同构收益。原 #1 自动触发已按搭档裁决放弃 |
| R5 | 五问的判定入口 | 复用步骤 1 三类判定（模糊必过） | 新增「需求成熟度」独立判定字段 | 新字段=新机制+新判定歧义；三类判定已稳定运行，模糊类天然是结晶门的靶子 |
| R6 | golden 来源口径的落点 | golden README 准入节 + selftest 既有纪律 | lint 强制校验场景文件头带案发锚点 | 锚点校验可被伪造（写个假 ID 过检），口径的价值在共识不在机械；README 准入 + 检视核对即可，机械校验造伪合规 |

省事自检（按 requirement-analysis 省事声明触发论证）：本方案「零机制新增」的省事主张——省掉的是「hook 硬拦截 / CI 强制关门 / 独立 intent 阶段」三块基建，其主人分别是：hook 拦截的成本由未来误伤场景承担（已由 R3 论证纪律先行）、CI 关门由假绿门禁承担（R2）、intent 阶段由维护成本承担（R4）——三处省略均有决策记录，不是无主省略。

## 验证

- [ ] lint-intent 单测：created_at ≥ 界 + 软代码 + 缺 verify_by → error；< 界 → warning；带合法声明 → 通过
- [ ] lint-intent 单测：golden_replay 声明 + `data/metrics/golden-results.jsonl` 有/无 ts ≥ created_at 记录 → 通过/error
- [ ] 本 F 文档自身即首例：frontmatter 带 intent.verify_by（behavior_check），lint 通过
- [ ] skill lint（lint-skills）通过：requirement-analysis/troubleshooting/worktree-isolation 改动后 0 error
- [ ] 行为验证（verify_by.detail）：落地后首个软代码 PR / 首个模糊需求 / 首个 bugfix PR 三场景对照 expected_effect

## 对抗审视记录

**第一轮（检视獭-sdpl，kimi，异模型）**：结论「需要修改」——2 严重 + 3 建议。处置：

| 发现 | 级别 | 处置 | 决策树判断 |
|------|------|------|-----------|
| 1. results.jsonl 路径与字段双重失实（真实路径 `data/metrics/golden-results.jsonl`，无 featureId；tests 下为 gitignore 残留） | 严重 | 接受并修订：现状盘点表修正为实测事实；改动 2 重写为「ts ≥ created_at 弱核对 + 检视因果核对」；pr 字段/featureId 两强核对案附否决理由留痕 | 改了明显更好——初稿核对逻辑建立在错误现状上，落不了地 |
| 2. created_at 可伪造绕过时间界 | 严重 | 接受并修订：风险 5 显式登记口子 + 检视獭 git 首提交对照职责；不加机械防（伪造检测的机械实现复杂度与收益不成比，登记口子优于假装堵上） | 改了更好——诚实登记优于隐没 |
| 3. 三项改动同构的防绕过分层未显式化 | 建议 | 接受：影响范围节增「自报字段=lint 入口、检视獭语义核对=闸门、搭档终审=兜底」三层声明 | 更好——把有意的分层设计说破，消除「偶然重合」误读 |
| 4. 结晶门与步骤 2 职责边界不清 | 建议 | 接受：D3 设计说明明确「结晶门通过则步骤 2 复述省略」 | 更好——消除「确认几轮」执行歧义 |
| 5. 四选一文案暗示强制集但机制不拦 metric_probe | 建议 | 接受：文案改为「引导性推荐集」，说明 metric_probe 仍合法（RHI 指标验证场景成立），机制不改（零机制新增定位，等真实案例再收） | 更好——文案与机制口径对齐 |

**第二轮 delta 复核（检视獭-sdpl）**：结论「需要修改」——1 严重（新引入）+ 2 建议，五项原处置方向全部认可。检视獭授权简化路径：三处落实后由大獭对照确认即呈终审，无需第三轮。处置：

| 发现 | 级别 | 处置 | 决策树判断 |
|------|------|------|-----------|
| 1. results.jsonl 本地非追踪，CI 干净环境不存在 → lint 恒 error 假红阻断 | 严重（新引入） | 接受：改动 2 补分环境语义——文件存在（本地）error 核对，文件不存在（CI）降 warning 提示；闸门重心在本地 lint 时机，CI 只兜底提醒 | 改了更好——与 R2 否决伪门禁同源，假红与假绿同为伪门禁 |
| 2. T2 目标行残留旧失实路径 | 建议 | 接受：T2 重写为 ts ≥ created_at 弱核对语义 + 指向分环境定义 | 更好——验收锚点对齐真相 |
| 3. 影响范围表格被分层段落截断 | 建议 | 接受：分层段落移到表格完整之后，CI 行归表 | 更好——纯排版修复 |

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `scripts/lint-intent.mjs` | 修改 | 软代码缺 verify_by 按时间界 warning→error；golden_replay 声明的 results.jsonl 记录核对（~40 行） |
| `tests/scripts/lint-intent*.test.mjs`（或既有 lint 测试文件） | 修改 | 上述两规则的单测 |
| `.pi/skills/requirement-analysis/SKILL.md` | 修改 | 步骤 1.5 结晶门（五问 + 豁免留痕），description 不动 |
| `.pi/skills/troubleshooting/SKILL.md` | 修改 | 步骤 5a 固化失败（测试/脚本/豁免三通道） |
| `.pi/skills/worktree-isolation/SKILL.md` | 修改 | 特性文档约定：bugfix 类 Verification 附失败用例证据 |
| `tests/capability/golden/README.md` | 修改 | 新场景准入：案发锚点必带 + 三类禁止来源 |

## 与课程的对齐度说明（溯源）

本方案吸收课程三处 play 的精神但全部本地化：L09 continuous evals（配置改动跑回归 → D2 收口）、L02 capture intent（结构化意图入口 → D3 五问门）、L08 feedback loop（失败测试先行 → D4 固化失败）。课程产物链自动触发（L01 核心）经搭档裁决不吸收（人工卡点保留）。历史脉络：golden 体系源自 F20260825evgl（ponytail 研究 R20260828pntr「评测即产品」催生）→ F20260828gssf（selftest 层）→ F20260917asgv（金标准锚点集 + fail-closed）；结晶门源自 tutu-vessel 补充研究 R20260821supp「需求结晶五问是 otter 最缺的防呆门」。本方案是这些既有结论的收口，不是新开赛道。
