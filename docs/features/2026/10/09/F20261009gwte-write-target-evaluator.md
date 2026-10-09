---
id: F20261009gwte
title: bash 守卫 main_write 判定替换——写落点静态求值器（cwd 跟踪 + 路径解析，落点集合判主仓交集）
summary: 机制审视建议 5 立项：main_write 判定从「命令词黑名单猜意图」换轨「写落点静态求值看事实」——基于既有 parseOnce 模型（Segment.redirects 已带 evaluated target）求值写落点集合，判「落点 ∩ 主仓树」；求值不出 fail-closed 回落既有判定链，shadow 对比先行（#1368 replay 语料当验证集）不盲切。kill 族/进程保护防线不动；不过度设计 exotic 攻击场景（搭档定调）
type: Design
date: 2026-10-09
capability_test: "n/a: 设计方案文档，实现验证走 shadow 对比（replay 语料）+ 双链一致性测试 + 全量单测"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
---

# bash 守卫 main_write 判定替换——写落点静态求值器

## 背景

**搭档原话（意图锚）**：「那我觉得2这个才是第一性原理，黑白名单都不对，本质还是要确认命令落到哪。当然，这个度也要把握好，不要过度设计非常复杂的攻击场景」。

**问题现状**（guard-mechanism-review.md，10/8）：main_write 判定靠命令词黑名单（REDIRECT_PATTERN / python heredoc / one-liner 通道 / git 写族正则），本质是「猜意图」——

- **S3**：one-liner 只读白名单按 fs API 枚举，bcrypt.hashSync 纯计算不在名单即拦；白名单跟进速度永远落后 LLM 库面（近 7 天 main_write 误拦 96 条，其中 hasWorktreePath=true 的合法 worktree 写占大头）
- **#1363 灰区**：`cd WT && 写主仓绝对路径` ——cd 说 worktree、写落主仓，显式意图信号与实际落点背离
- **S1 家族**（#1207→#1304、#1170→#1360）：每类新写形态都要等误拦发生 → 加 pattern → 双链同步 → 复发，打地鼠循环两次实证
- 审视报告结论：枚举黑名单边际收益趋零，「cwd 在主仓但落点在外」整族误拦只有落点求值能归零

**第一性原理（搭档拍板）**：黑名单猜意图 → 落点求值看事实。写命令危险与否取决于**文件落到哪**，不取决于命令长得像哪类写。

## 目标

- T1：main_write 判定链（checkMainCheckoutWrite 体系）换轨为「写落点集合求值 ∩ 主仓树」判定；「cwd 在主仓但落点在外」整族误拦归零
- T2：#1363 灰区（cd WT 后写主仓）自然消解——落点在主仓就拦，与 cd 无关；本方案落地后 #1363 就地关闭
- T3：安全底线不回退——现拦的形态（真写主仓）换轨后仍拦，以 replay 语料 + 既有单测全量回归为验收线
- T4：shadow 对比先行——新判定 vs 旧判定 vs replay 人工裁决期望，量化对比产出切换依据，不盲切
- T5：求值不出 → fail-closed 回落既有判定链（保守侧与现状一致，绝不因「看不懂」放行）

## 非目标

- **kill 族/进程保护/data_destructive/sleep 等其他防线不动**——只换 main_write 判定链（大獭定调替换边界）
- **不做完整 shell 语义解释器**——不做变量全量数据流分析、不做 exotic 攻击场景覆盖（搭档明示「不要过度设计非常复杂的攻击场景」）；求值不出就回落，不硬算
- **不替换 kill 判定、不扩到 data 破坏判定**（rm/mv 落点求值可作后续独立增量，本期不动）
- **不新增配置开关/运行时开关**——shadow 阶段用代码内常量切换，切换后删除旧链（不留双轨长期共存）
- **V1 兜底链去留不在本期定论**——方案给出建议（见「双链关系」节），实际退役等 shadow 数据支撑后另行决策

## 未决问题

- U1（留槽）：`git -C <主仓> status` 等「git 只读子命令 + -C 指向主仓」形态，落点求值判定为「无写落点」放行——与现状一致（现状也放行，GIT_WRITE_SUBCOMMAND 只匹配写子命令）。无变化，无需决策，仅记录。
- U2（留槽）：`npm install` / `pip install` 类包管理器写 node_modules/site-packages（落点可能在主仓树内）——现状按「非命中形态」放行；求值器把 npm install 的落点判定为「主仓树内写」会**由放行变拦截**，属行为变更。处置见「已知行为变更清单」BC-3，需 shadow 数据 + 搭档确认。

## 方案设计

### 总体架构：求值器为「新判定核」，既有链为「回落网」

```
checkMainCheckoutWrite（入口不变）
  ├─ [NEW] evaluateWriteTargets(command, projectRoot) → WriteEvalResult
  │    ├─ kind: "evaluated"  → 落点集合完整求出 → 判「落点 ∩ 主仓树」→ 拦/放（终局）
  │    └─ kind: "unevaluated"（求值不出：解析失败/动态构造/未覆盖形态）
  │         → 回落既有判定链（MAIN_WRITE_PATTERNS + 段首结构检测 + 白名单…原样保留）
  ├─ 既有链（回落网 + shadow 期对照物）
  └─ kill/data/sleep 等其他防线（上游/下游，不触碰）
```

关键决策：**求值器是判定前置而非平行新链**——evaluated 时求值器说了算（终局），unevaluated 时回落旧链。好处：①安全底线由「回落网」兜底，求值器只做「更有把握」的判定；②shadow 期同一入口双跑（求值器结果 vs 旧链结果）对比零成本；③切换完成后删除旧链不影响入口契约。

### 模块 1：落点求值核（src/frameworks/agent/write-target-evaluator.ts，新文件）

**输入**：`command: string, projectRoot: string`。**输出**：

```typescript
type WriteEvalResult =
  | { kind: "evaluated"; targets: WriteTarget[] }   // 落点集合完整求出（可能为空集=无写）
  | { kind: "unevaluated"; reason: UnevalReason };  // 回落旧链

interface WriteTarget {
  path: string;          // 求值后的绝对路径
  via: "redirect" | "cmd-arg" | "heredoc-body" | "tee-cp-mv" | "git";
  segmentIndex: number;  // 溯源段号（诊断/文案用）
}
```

**求值规则（V1 版覆盖面，显式声明）**——基于 `parseOnce` 模型逐段求值，cwd 从主仓根起步沿语句序推进：

| 写通道 | 求值方式 |
|---|---|
| `> >>` 重定向 | `Segment.redirects`（op ∈ {>, >>, >|} 且 fd≠0/1 输入向）取 `target`（evaluated）；null target（`$VAR` 目标）→ 整体 unevaluated（回落） |
| `tee` / `cp` / `mv` / `touch` / `mkdir -p` | argv0 匹配词表 + 落点参数位（tee 全部非旗标参数；cp/mv 第二参数；touch/mkdir 全部非旗标参数） |
| `git` 写族 | `GIT_WRITE_SUBCOMMAND` 命中 → 落点 = `-C` 目标或 cwd（cwd 跟踪后）；`--git-dir/--work-tree` 显式给定 → 该路径 |
| python/node 载荷内 `open(...,'w')`/`writeFileSync` | 载荷 `Payload.model` 可解析 → 提取调用第一参数（evaluated 字面量/拼接）；不可解析 → unevaluated |
| heredoc 体 | 解释器体（python/node/bash）：bash 体递归求值；python/node 体走上方载荷规则；**体不可解析 → unevaluated**（不沿用现状的「白名单判只读」——求值器语义是「算落点」，算不出就回落旧链，旧链有自己的白名单豁免） |

**cwd 跟踪**：沿 `segments` 语句序（joiner 非 `&`/`|` 的段更新 cwd；`&`/`|` 后段继承前 cwd——cd 子 shell 化语义与 modelCdExemption 同源）；`cd <target>` evaluated → realpath 拼接更新；`cd $VAR` 走既有赋值溯源（guard-model-judge 同源逻辑）；溯源不出 → 后续段全部 unevaluated（回落）。`pushd/popd` → unevaluated（V1 不覆盖，回落）。

**「落点 ∩ 主仓树」判定**：`normalize(target)` 以 `projectRoot + path.sep` 前缀判（含 `data/workspaces/` 豁免——沿用 F20260923hsyn 既有语义：主仓树下但属合法工作区放行，附 explicit 测试钉住）。相对路径落点按当前 cwd 解析为绝对路径再判。

** UnevalReason 枚举（回落触发面，显式穷举）**：`parse-failed`（parseOk=false）/ `dynamic-path`（$/`` ` ``/未溯源变量）/ `uncovered-cmd`（词表外命令带写特征旗标）/ `heredoc-unparseable` / `cwd-unresolvable`（pushd 等）/ `depth-exceeded`。

**保留的既有负门**：`cdExemptionWithVeto`（#1240 heredoc 体绝对路径写主仓）语义被求值器天然涵盖（heredoc body 落点参与求值）——但 shadow 期双跑仍显式跑 veto 对照；「cd 主仓显式意图放行」（测试 :1190：`cd /repo && git commit` 放行）**语义变更**为：cd 主仓后写落点在主仓树内 → 求值器判拦。这是本方案唯一「收紧」面，显式列为行为变更 BC-1，见下。

### 模块 2：shadow 对比机制（方案期即可跑，不进运行时）

**形态**：`scripts/shadow-write-eval.mjs`——读 replay 语料（guard-v2-real-replay.test.ts 结构化提取 + #1368 固化候选 JSON + healing 台账近 30 天 guard_intercept 命令恢复），对每条命令三跑：①求值器判定 ②现行判定链判定 ③replay 人工裁决期望。输出对比矩阵：

- agree-block（双方拦且期望拦）/ agree-allow（双方放且期望放）/ **eval-blocks-old-allows**（求值器拦旧链放——预期增益：#1363 灰区族）/ **eval-allows-old-blocks**（求值器放旧链拦——**红线区：逐条人工审，任何一条是「真写主仓被放」即阻断切换**）/ unevaluated-rate（回落率，>30% 说明求值覆盖面不足，扩大词表后再评估）

**切换判据（量化，预注册）**：红线区真逃逸 = 0；eval-allows-old-blocks 中误放（相对人工期望）= 0；agree-block/allow 占比与回落率写入切换报告。**达不到不切，回落网继续兜底**（shadow 不通过不损失任何东西）。

### 模块 3：接入与切换（实现期，三步走）

1. **shadow 接入**：evaluateWriteTargets 进 src（导出独立函数，入口不接），shadow 脚本消费。CI 跑求值器单测（覆盖面表逐行 × 放行/拦截双侧）
2. **灰度接入**：checkMainCheckoutWrite 入口接求值器（evaluated 终局 / unevaluated 回落），全量既有测试必须绿（含 :1190 显式意图用例——按 BC-1 修订期望）；双链一致性测试（#1368）扩展：求值器判定也纳入双跑对照（parseOk 双跑语义下求值器都应返回 evaluated 且一致）
3. **清理**：shadow 数据达标后删旧链（MAIN_WRITE_PATTERNS/段首结构检测/one-liner 白名单体系），特性文档记录删除范围；V1 链（parseOk=false 回落路径）与 parseOk=false 时的 unevaluated 回流合并——**此时才具备回答「V1 兜底链退役」的数据**（回落率即 V1 存在价值量化）

### 已知行为变更清单（预注册，shadow 后逐条核对）

- **BC-1（收紧）**：`cd /主仓 && git commit` 现状放行（显式意图，测试 :1190）→ 求值器判拦（落点在主仓）。**这是语义级变更**：从「cd 声明意图」变「落点定事实」。缓解：拦截文案引导「写主仓请显式 --allow-main 或拆分」（文案随实现定）；影响面：獭在主仓 cwd 下 commit（现状高频形态！）——shadow 期统计该形态频次，若高频需搭档确认接受度。**此项需搭档在 shadow 报告后拍板确认**。
- **BC-2（放宽）**：one-liner 白名单外纯计算形态（bcrypt.hashSync 等 S3 族）——求值器判「无写落点」放行。这正是 S3 治本面，属预期收益。
- **BC-3（收紧，待 shadow 定量）**：`npm install` 等包管理器写主仓树内 node_modules——求值器判落点在主仓树。处置两案：A. 词表内建「包管理器豁免」（落点限于 node_modules/site-packages 子树放行）；B. 不豁免（install 本就改主仓依赖，拦+引导 worktree 是对的）。shadow 统计频次后呈搭档。
- **BC-4（放宽）**：`grep xxx /主仓/data/log.log`（读命令带主仓路径参数）——现状部分形态被 S4 进程名模式误伤、部分被 gitReadonly 前置豁免；求值器判「无写落点」一致放行，属对齐。

## 影响范围

- `src/frameworks/agent/write-target-evaluator.ts`（新增，求值核）
- `src/frameworks/agent/bash-safety-guard.ts`（入口接求值器；shadow 期旧链保留，清理期删）
- `scripts/shadow-write-eval.mjs`（新增，shadow 对比）
- `tests/frameworks/agent/write-target-evaluator.test.ts`（新增，覆盖面表驱动）
- 既有测试：bash-safety-guard.test.ts（:1190 用例期望按 BC-1 修订）、guard-dual-chain-consistency.test.ts（求值器纳入双跑）
- 不动：kill 族/进程保护/data_destructive/sleep 判定、checkBashCommandSafety 入口契约、healing 落账

## 风险与约束

- **R1 安全回退风险（最高优先）**：求值器「有把握地放行」了旧链会拦的真写 → 红线区。缓解：红线区零容忍判据 + unevaluated 默认回落 + shadow 全语料对比 + 既有拦截侧单测全量保留（清理期才评估精简）
- **R2 覆盖面不足 → 回落率过高**：求值器退化成「偶尔生效的旁路」。缓解：回落率 >30% 不切换；覆盖面表驱动测试显式声明覆盖/不覆盖
- **R3 BC-1 影响高频形态**：主仓 cwd 下 commit 是獭日常。缓解：shadow 统计频次 + 呈搭档拍板（可能产生「显式 --allow-main」出口或接受拦截+文案引导，搭档定）
- **R4 双源判定长期漂移**：shadow 期旧链与求值器并存，同 S1 家族「双链割裂」同型风险。缓解：shadow 是临时态（切换即删旧链）；#1368 双链一致性测试扩展覆盖「求值器 vs 回落链」同命令双跑

## 机制识别检查点（逐项打勾）

- □ 新增配置字段/枚举/开关：**否**——shadow 切换用代码常量，无运行时开关
- □ 新增状态生命周期：**否**
- □ 新增定时任务/后台进程：**否**——shadow 脚本手动/按需跑，非定时任务
- □ 新增信号类型/消息格式：**否**
- □ 新增持久化存储：**否**——shadow 报告落 worktree 文档，非 schema
- □ 新增决策分支（结果被记住）：**否**——求值器是纯函数判定，不写状态
- □ 新增跨模块调用路径：**是**——bash-safety-guard.ts → write-target-evaluator.ts（同层 frameworks 内新调用边）

命中「新增跨模块调用路径」→ 涉及净新增机制 → 机制预算四问必答（见下）+ 重对抗门必过。

### 机制预算四问（作者当场作答）

**① 谁需要它**：三类具体角色——(a) 开发獭：在 worktree 正道写文件时不再被 main_write 误拦（近 7 天 96 条误拦的当事人）；(b) 审视守卫的獭（S4 族）：写「关于守卫的证据」不再触发守卫；(c) 搭档：#1363 灰区关闭、S3 白名单打地鼠维护成本归零、误拦申诉/放行人工介入量下降。

**② 失败后果**：若求值器判定错误——误放（真写主仓没拦）→ 主仓被污染，搭档可感知（git status/config 变更），损害等级同 R1 红线被穿，**这是本机制最大的失败面**，故红线区零容忍 + 回落网双保险；误拦（求值器比旧链多拦）→ 獭回合被打断，与现状同级但方向变化（拦「cd 主仓后写」是新拦截面，BC-1 呈搭档确认后才切）。

**③ 后续机制**：它创造的新状态——「落点词表」（tee/cp/mv/touch/git 等）会成为新的枚举维护面（类似 S3 白名单的「漏一个 API」问题：漏一个写命令形态 → 该形态 unevaluated 回落旧链，**失败方向是保守拦不是放**，与 S3 白名单漏 API 即误拦的方向相反——这是把枚举面从「安全侧」挪到「覆盖侧」的关键差异）；词表扩充走 replay 语料驱动（#1368 固化机制自动供给），修法走 unevaluated 回落不会静默放行。新增问题类：「求值器 bug 导致误放」→ 由红线区零容忍判据 + 双链一致性扩展测试承接。

**④ 退役条件**：出现以下信号时撤下求值器回退旧链——(a) 生产出现一例「求值器 evaluated 放行 + 事后确认真写主仓」（红线破防，立即回退）；(b) 回落率持续 >50% 且词表扩充两周无收敛（说明形态空间不适合静态求值，方案前提不成立）。回退即 git revert 接入 commit，旧链在 shadow 期完整保留、清理期后需从 git 历史恢复（故清理动作放在 shadow 达标 + 稳定期 ≥2 周之后）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 求值器定位 | 判定前置（evaluated 终局/unevaluated 回落） | 平行新链直接替换 | 回落网兜安全底线；shadow 零成本双跑；红线破防时 revert 粒度清晰 |
| 解析基座 | 复用 parseOnce 模型（redirects/args/assignments 已求值） | 自建 shell 解析器 | 基座对齐铁律（#1285/#1315 教训：双基座必漂移）；parseOnce 是 V2 主链在用真相源 |
| 覆盖面策略 | 词表覆盖常见形态 + 显式 unevaluated 穷举 | 全量 shell 语义求值 | 搭档定调不过度设计；求值不出回落保守侧，安全方向正确 |
| 数据体 heredoc | 不可解析 → 回落旧链（白名单豁免在旧链里） | 求值器内重建只读白名单 | 白名单语义属「猜只读」，与求值器「算落点」语义不同层；回落网已兜 |
| BC-1 cd 主仓显式写 | 求值器判拦（落点定事实） | 保留 cd 显式意图豁免 | 第一性原理的一致执行（搭档原话「本质确认命令落到哪」）；影响面高频，shadow 统计后呈搭档拍板，不静默变更 |
| shadow 切换判据 | 预注册量化（红线区 0 / 回落率阈值） | 上线后观察 | 切换不可逆风险前置到数据关；预注册防「事后解释」 |
| V1 链去留 | 本期不定论，回落率数据给出后另行决策 | 本期同步退役 | 单变量切换：先验证求值器，再谈 V1 退役，两件事混着出问题难归因 |

**重对抗门**：方案净新增机制（跨模块调用路径），四问已答——门控待检视獭审查（治本/治标判断），通过后方可定稿。

## 验证

- **求值器单测（覆盖面表驱动）**：每条求值规则 × 放行/拦截/unevaluated 三态；cwd 跟踪（含 & | 子 shell 化、cd $VAR 溯源、pushd 回落）；主仓树判定（data/workspaces 豁免钉住）；红线形态（真写主仓各通道）全拦
- **既有回归**：全量 bash-safety-guard.test.ts（:1190 按 BC-1 修订）+ #1368 双链一致性 9 例 + replay 6 例
- **shadow 对比报告**：语料全量三跑矩阵（切换判据预注册：红线区 0 / 误放 0 / 回落率阈值 30%）
- **BC 核对**：BC-1~4 逐条在 shadow 报告中给出实测频次与最终处置

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/write-target-evaluator.ts | 新增 | 落点求值核（纯函数） |
| scripts/shadow-write-eval.mjs | 新增 | shadow 三跑对比 |
| tests/frameworks/agent/write-target-evaluator.test.ts | 新增 | 覆盖面表驱动 |
| src/frameworks/agent/bash-safety-guard.ts | 修改 | 入口接求值器（shadow 期保留旧链；清理期删） |
| tests/frameworks/agent/bash-safety-guard.test.ts | 修改 | :1190 期望按 BC-1 |
| tests/frameworks/agent/guard-dual-chain-consistency.test.ts | 修改 | 求值器纳入双跑对照 |
| docs/features/2026/10/09/F20261009gwte-*.md | 新增 | 本文档 |

## 流程状态

- [x] 方案 v1 落盘（本文档）
- [ ] 机制预算四问 → 已答（见上），重对抗门待检视獭（与对抗审视合并一轮）
- [ ] 对抗审视（新检视獭，异模型）
- [ ] 处置 + delta 复审
- [ ] 呈搭档终审定稿（附决策简报：BC-1 需搭档表态）
- [ ] （定稿后另行派工实现）
