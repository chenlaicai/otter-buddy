---
id: F20261009gwte
title: bash 守卫 main_write 判定替换——写落点静态求值器（cwd 跟踪 + 路径解析，落点集合判主仓交集）
summary: 机制审视建议 5 立项 v2：main_write 判定从「命令词黑名单猜意图」换轨「写落点静态求值看事实」——Phase 1 只做 shell 形态族（重定向/cd/cp/mv/git/tee，覆盖误拦 ~60%），Python/JS 载荷族显式 unevaluated 回落（Phase 2 候选：窄字面量提取，不做完整 AST）；求值不出 fail-closed 回落旧链，shadow 语料库 ≥100 例三跑对比预注册判据不盲切。kill 族/进程保护防线不动；不过度设计 exotic 攻击场景（搭档定调）
type: Design
date: 2026-10-09
capability_test: "n/a: 设计方案文档，实现验证走 shadow 对比（语料库 ≥100 例三跑）+ 双链一致性测试 + 全量单测"
intent:
  problem: "main_write 判定靠命令词黑名单猜意图——白名单枚举面跟不上实际负载（S3 打地鼠）、cd WT 后写主仓灰区（#1363）、新写形态等误拦发生才加 pattern（S1 家族两次复发），近 7 天 main_write 误拦 96 条"
  expected_effect: "Phase 1 影子态：求值器（shell 族落点求值）+ 语料库 ≥100 例 + shadow 三跑达标（红线 0/误放 0/回落率 ≤50%），零生产行为变更；切换决策等全量数据 + BC-1/BC-3 频次呈搭档拍板"
  verify_by:
    type: behavior_check
change_type: feature
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

- T1：main_write 判定链换轨「写落点集合求值 ∩ 主仓树」，**Phase 1 覆盖 shell 形态族**（重定向/cd 跟踪/tee/cp/mv/touch/git 写族——机制审视估算覆盖近 7 天误拦 ~60%）；「cwd 在主仓但落点在外」shell 族误拦归零
- T1b（Phase 2 候选，不绑 Phase 1 切换）：Python/JS 载荷窄字面量提取（只识别 `open(...,'w')`/`writeFileSync`/`fs.write` 前几个**字面量**参数，识别不出即 unevaluated 回落——**不做完整 AST**，搭档定调「不过度设计」；大獭裁决：攻击场景是防逃逸（安全侧），载荷求值是放行侧覆盖，窄提取是合适的度）
- T2：#1363 灰区（cd WT 后写主仓）自然消解——落点在主仓就拦，与 cd 无关；本方案落地后 #1363 就地关闭
- T3：安全底线不回退——现拦的形态（真写主仓）换轨后仍拦，以 shadow 语料库（≥100 例）+ 既有单测全量回归为验收线
- T4：shadow 对比先行——新判定 vs 旧判定 vs 人工裁决期望，量化对比产出切换依据，不盲切
- T5：求值不出 → fail-closed 回落既有判定链（保守侧与现状一致，绝不因「看不懂」放行）

## 非目标

- **kill 族/进程保护/data_destructive/sleep 等其他防线不动**——只换 main_write 判定链（大獭定调替换边界）
- **不做完整 shell 语义解释器**——不做变量全量数据流分析、不做 exotic 攻击场景覆盖（搭档明示）；求值不出就回落，不硬算
- **Phase 1 不做 Python/JS 载荷求值**（审视 S1 实测：Payload.model 是 shell 模型非 Python AST——`python3 -c "open('/repo/data/x','w')..."` 的载荷 kind=cmdsub，parseOnce 递归产出的是 shell 模型，command-model.ts:315/339）。载荷族 Phase 1 全部 unevaluated 回落旧链（行为不变），Phase 2 以窄字面量提取独立立项。同此：**cmdsub 内路径变形（`cd $(dirname x)/../main`）求值不出，回落旧链**（审视 S6，留存的「一步变形」逃逸属合理度）
- **不替换 kill 判定、不扩到 data 破坏判定**（rm/mv 落点求值可作后续独立增量，本期不动）
- **不新增配置开关/运行时开关**——shadow 阶段用代码内常量切换，切换后删除旧链（不留双轨长期共存）
- **V1 兜底链去留不在本期定论**——方案给出建议（见「双链关系」节），实际退役等 shadow 数据支撑后另行决策

## 未决问题

- U1（留槽）：`git -C <主仓> status` 等「git 只读子命令 + -C 指向主仓」形态，落点求值判定为「无写落点」放行——与现状一致（现状也放行，GIT_WRITE_SUBCOMMAND 只匹配写子命令）。无变化，无需决策，仅记录。
- U2（留槽）：`npm install` / `pip install` 类包管理器写 node_modules/site-packages（落点可能在主仓树内）——现状按「非命中形态」放行；求值器把 npm install 的落点判定为「主仓树内写」会**由放行变拦截**，属行为变更。处置见「已知行为变更清单」BC-3，需 shadow 数据 + 搭档确认。
- U3（v2 新增，Phase 2 范围槽）：Python/JS 窄字面量提取的字段面（open/writeFileSync/fs.write 之外是否含 appendFile/createWriteStream）待 Phase 2 立项时以 replay 语料频次定，不在本方案展开。

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

**基座声称（v2 修订，审视 S1/S4）**：复用 parseOnce 词法/分段层（command-lexer.ts + command-model.ts——原文误写 pi-bash-parser.ts 已订正），**新增求值层**（write-target-evaluator.ts）；**Phase 1 不新增任何语义解析层**——Python/JS 载荷（kind=cmdsub，其 model 是 shell 模型非 Python AST，command-model.ts:315/339 实测锚点）不做求值，显式 unevaluated 回落；Phase 2 如立项将新增窄字面量提取子模块（工作量单列）。

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

**求值规则（Phase 1 覆盖面 = shell 形态族，显式声明）**——基于 `parseOnce` 模型逐段求值，cwd 从主仓根起步沿语句序推进：

| 写通道 | Phase | 求值方式 |
|---|---|---|
| `> >>` 重定向 | 1 | `Segment.redirects`（op ∈ {>, >>, >|} 且 fd≠0/1 输入向）取 `target`（evaluated）；null target（`$VAR` 目标）→ 整体 unevaluated（回落） |
| `tee` / `cp` / `mv` / `touch` / `mkdir -p` | 1 | argv0 匹配词表 + 落点参数位（tee 全部非旗标参数；cp/mv 第二参数；touch/mkdir 全部非旗标参数） |
| `git` 写族 | 1 | `GIT_WRITE_SUBCOMMAND` 命中 → 落点 = `-C` 目标或 cwd（cwd 跟踪后）；`--git-dir/--work-tree` 显式给定 → 该路径 |
| heredoc 体（bash） | 1 | bash 体 parseOnce 递归模型可用 → 体内通道按本表重走；不可解析 → unevaluated |
| **python/node/ruby/perl 载荷**（-c/-e/heredoc 体） | **1 不做，unevaluated 回落** | 审视 S1 实测：载荷 kind=cmdsub 的 model 是 shell 模型非 Python/JS AST，「提取 open 第一参数」需新建语义层——Phase 1 显式回落旧链（白名单豁免在旧链里，行为不变）；Phase 2 候选：窄字面量提取（只认 `open(...,'w')`/`writeFileSync`/`fs.write` 前几个字面量参数，识别不出即回落，不做完整 AST） |
| cmdsub 路径变形 `cd $(dirname x)/../main` | 1 不做 | 求值不出 → 回落（审视 S6 留存的「一步变形」逃逸，属搭档定调的合理度） |

**cwd 跟踪**：沿 `segments` 语句序（joiner 非 `&`/`|` 的段更新 cwd；`&`/`|` 后段继承前 cwd——cd 子 shell 化语义与 modelCdExemption 同源）；`cd <target>` evaluated → realpath 拼接更新；`cd $VAR` 走既有赋值溯源（guard-model-judge 同源逻辑）；溯源不出 → 后续段全部 unevaluated（回落）。`pushd/popd` → unevaluated（V1 不覆盖，回落）。

**「落点 ∩ 主仓树」判定**：`normalize(target)` 以 `projectRoot + path.sep` 前缀判（含 `data/workspaces/` 豁免——沿用 F20260923hsyn 既有语义：主仓树下但属合法工作区放行，附 explicit 测试钉住）。相对路径落点按当前 cwd 解析为绝对路径再判。

** UnevalReason 枚举（回落触发面，显式穷举）**：`parse-failed`（parseOk=false）/ `dynamic-path`（$/`` ` ``/未溯源变量）/ `uncovered-cmd`（词表外命令带写特征旗标）/ `heredoc-unparseable` / `cwd-unresolvable`（pushd 等）/ `depth-exceeded`。

**保留的既有负门**：`cdExemptionWithVeto`（#1240 heredoc 体绝对路径写主仓）语义被求值器天然涵盖（heredoc body 落点参与求值）——但 shadow 期双跑仍显式跑 veto 对照；「cd 主仓显式意图放行」（测试 :1190：`cd /repo && git commit` 放行）**语义变更**为：cd 主仓后写落点在主仓树内 → 求值器判拦。这是本方案唯一「收紧」面，显式列为行为变更 BC-1，见下。

### 模块 2：shadow 对比机制（含语料库构建子模块）

**语料库构建（v2 新增子模块，审视 S2）**：目标 **≥100 例**，三源合成——

1. **replay 存量**（guard-v2-real-replay 9 例 + #1368 固化候选）
2. **healing 台账批量回捞**：复用 #1368 replay 生成器（generate-guard-replay.mjs）从 healing_events 批量产候选（近 30 天 guard_intercept，含拦截结构化事件的 commandHead），人工裁决期望值（ALLOW/BLOCK）——一鱼两吃，固化与 shadow 语料同源
3. **形态补齐**（人工构造，按覆盖面表逐行 × 三态）：每条求值规则至少 1 放行 + 1 拦截 + 1 unevaluated 样本；BC-1~5 各族正反例；红线形态（真写主仓各通道）专项集 ≥20 例

语料库落 `tests/fixtures/guard-write-eval-corpus.json`（command/expect/pRuleId/verdict 字段），作为 shadow 脚本与求值器单测共同数据源（单一真相源，防语料漂移）。

**对比矩阵形态**：`scripts/shadow-write-eval.mjs` 对每条命令三跑：①求值器判定 ②现行判定链判定 ③人工裁决期望。输出：

- agree-block（双方拦且期望拦）/ agree-allow（双方放且期望放）/ **eval-blocks-old-allows**（求值器拦旧链放——预期增益：#1363 灰区族）/ **eval-allows-old-blocks**（求值器放旧链拦——**红线区：逐条人工审，任何一条是「真写主仓被放」即阻断切换**）/ unevaluated-rate（**Phase 1 范围内回落率**，见阈值推导）

**切换判据（v2 重推导，审视 S5）**：

- 红线区真逃逸 = 0（不变，零容忍）
- eval-allows-old-blocks 中误放（相对人工期望）= 0（不变）
- **回落率阈值 30%→50%**（Phase 1 口径）：推导——①基线参考：现状 V1 兜底链 parseOk=false 占比（机制审视数据：误拦命令流中 parseOk=false 形态 ~35-45%），Phase 1 刻意把 Python/JS 族（估算 ~40% 误拦样本）划入 unevaluated，全集回落率必然高位；②50% 阈值的含义：shell 族（重定向/tee/cp/mv/git）占语料 ≥50% 且其中回落率 <10%——即「Phase 1 声称覆盖的族内求值成功率高」，全集回落率高是范围声明而非缺陷；③若全集回落率 >50%，说明 shell 族占比不足或词表缺口大，扩大 Phase 1 词表或提前 Phase 2，再评估。**分母口径**：回落率 = unevaluated / 语料全集；族内成功率 = evaluated / 该族样本。两指标同时在切换报告中给出。

**切换后行为声明**：Phase 1 切换后 Python/JS 载荷族行为与现状完全一致（回落旧链白名单豁免）——S3 白名单打地鼠在该族的治理推迟到 Phase 2，方案目标 T1 措辞已同步限定为「shell 族误拦归零」。

### 模块 3：接入与切换（实现期，三步走）

1. **shadow 接入**：evaluateWriteTargets 进 src（导出独立函数，入口不接），shadow 脚本消费。CI 跑求值器单测（覆盖面表逐行 × 放行/拦截双侧）
2. **灰度接入**：checkMainCheckoutWrite 入口接求值器（evaluated 终局 / unevaluated 回落），全量既有测试必须绿（含 :1190 显式意图用例——按 BC-1 修订期望）；**#1368 双链一致性测试（guard-dual-chain-consistency.test.ts，9 例）扩展**：求值器判定纳入双跑对照（parseOk 双跑语义下求值器都应返回 evaluated 且一致——仅对 shell 族用例；Python/JS 载荷用例应一致地 unevaluated）
3. **清理**：shadow 数据达标后删旧链（MAIN_WRITE_PATTERNS/段首结构检测/one-liner 白名单体系），特性文档记录删除范围；V1 链（parseOk=false 回落路径）与 parseOk=false 时的 unevaluated 回流合并——**此时才具备回答「V1 兜底链退役」的数据**（回落率即 V1 存在价值量化）

### 已知行为变更清单（预注册，shadow 后逐条核对）

- **BC-1（收紧）**：`cd /主仓 && git commit` 现状放行（显式意图，测试 :1190）→ 求值器判拦（落点在主仓）。**这是语义级变更**：从「cd 声明意图」变「落点定事实」。缓解：拦截文案引导「写主仓请显式 --allow-main 或拆分」（文案随实现定）；影响面：獭在主仓 cwd 下 commit（现状高频形态！）——shadow 期统计该形态频次，若高频需搭档确认接受度。**此项需搭档在 shadow 报告后拍板确认**。
- **BC-2（放宽）**：one-liner 白名单外纯计算形态（bcrypt.hashSync 等 S3 族）——求值器判「无写落点」放行。这正是 S3 治本面，属预期收益。
- **BC-3（收紧，待 shadow 定量）**：`npm install` 等包管理器写主仓树内 node_modules——求值器判落点在主仓树。处置两案：A. 词表内建「包管理器豁免」（落点限于 node_modules/site-packages 子树放行）；B. 不豁免（install 本就改主仓依赖，拦+引导 worktree 是对的）。shadow 统计频次后呈搭档。
- **BC-4（放宽）**：`grep xxx /主仓/data/log.log`（读命令带主仓路径参数）——现状部分形态被 S4 进程名模式误伤、部分被 gitReadonly 前置豁免；求值器判「无写落点」一致放行，属对齐。
- **BC-5（不变更声明，v2 补，审视 S3）**：`cd $WT` 且 $WT 来自父 shell 环境变量（同命令内无赋值）→ 求值器 unevaluated → 回落旧链（含旧链 S1 `
` 正则行为）——与现状完全一致。边界声明：**赋值溯源仅同命令内**（`W=/wt; cd $W` 可溯源，export 继承的不可）；该族 Phase 1 行为零变化，非「已覆盖」。
- **BC-6（不变更声明，v2 补，审视 S6）**：cmdsub 内路径变形（`cd $(dirname x)/../main`）求值不出 → 回落旧链；「一步变形」逃逸留存属搭档定调的合理度，非求值器缺陷。

## 影响范围

- `src/frameworks/agent/write-target-evaluator.ts`（新增，求值核）
- `src/frameworks/agent/bash-safety-guard.ts`（入口接求值器；shadow 期旧链保留，清理期删）
- `scripts/shadow-write-eval.mjs`（新增，shadow 对比）
- `tests/frameworks/agent/write-target-evaluator.test.ts`（新增，覆盖面表驱动）
- 既有测试：bash-safety-guard.test.ts（:1190 用例期望按 BC-1 修订）、guard-dual-chain-consistency.test.ts（求值器纳入双跑）
- 不动：kill 族/进程保护/data_destructive/sleep 判定、checkBashCommandSafety 入口契约、healing 落账

## 风险与约束

- **R1 安全回退风险（最高优先）**：求值器「有把握地放行」了旧链会拦的真写 → 红线区。缓解：红线区零容忍判据 + unevaluated 默认回落 + shadow 全语料对比 + 既有拦截侧单测全量保留（清理期才评估精简）
- **R2 覆盖面不足 → 回落率过高**：求值器退化成「偶尔生效的旁路」。缓解：**Phase 1 口径**族内成功率 <90% 或全集回落率 >50% 不切换；覆盖面表驱动测试显式声明覆盖/不覆盖；Python/JS 族已显式划出 Phase 1（行为不变），不存在「声称覆盖但回落」的虚的
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

**③ 后续机制**：它创造的新状态——「落点词表」（tee/cp/mv/touch/git 等）会成为新的枚举维护面（类似 S3 白名单的「漏一个 API」问题：漏一个写命令形态 → 该形态 unevaluated 回落旧链，**失败方向是保守拦不是放**，与 S3 白名单漏 API 即误拦的方向相反——这是把枚举面从「安全侧」挪到「覆盖侧」的关键差异；审视 S7 打折注记：该反转在 Phase 1 已识别形态族成立，Python/JS 族 Phase 1 全回落不在此列，族内治理推迟到 Phase 2）；词表扩充走 shadow 语料驱动（≥100 例语料库 + #1368 固化机制自动供给），修法走 unevaluated 回落不会静默放行。新增问题类：「求值器 bug 导致误放」→ 由红线区零容忍判据 + 双链一致性扩展测试承接。

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

- **求值器单测（覆盖面表驱动）**：每条求值规则 × 放行/拦截/unevaluated 三态；cwd 跟踪（含 & | 子 shell 化、cd $VAR 同命令溯源、pushd 回落）；主仓树判定（data/workspaces 豁免钉住）；红线形态（真写主仓各通道）全拦；Python/JS 载荷族用例断言 unevaluated（Phase 1 边界钉住）
- **语料库**：tests/fixtures/guard-write-eval-corpus.json ≥100 例（replay 存量 + 台账回捞 + 形态补齐），作为 shadow 脚本与单测共同数据源
- **既有回归**：全量 bash-safety-guard.test.ts（:1190 按 BC-1 修订）+ #1368 双链一致性 9 例 + replay 9 例
- **shadow 对比报告**：语料全量三跑矩阵（切换判据预注册：红线区 0 / 误放 0 / Phase 1 族内成功率 ≥90% 且全集回落率 ≤50%）
  - **报告存放惯例**：原始报告落对话工作区（`data/workspaces/<conversation-id>/`），不进 git——`data/` 是运行时数据目录（先例：F20260911col2 误入库数据移除），且报告含本机绝对路径；特性文档只记统计结论，审计需要原始文件时从工作区取。`.gitignore` 已加 `data/guard-shadow-report-*` 防回归（2026-10-09 误提交移除）
- **BC 核对**：BC-1~6 逐条在 shadow 报告中给出实测频次与最终处置

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/write-target-evaluator.ts | 新增 | 落点求值核（纯函数；Phase 1 仅 shell 族） |
| scripts/shadow-write-eval.mjs | 新增 | shadow 三跑对比（消费语料库） |
| tests/fixtures/guard-write-eval-corpus.json | 新增 | 语料库 ≥100 例（三源合成，shadow/单测单一真相源） |
| tests/frameworks/agent/write-target-evaluator.test.ts | 新增 | 覆盖面表驱动 |
| src/frameworks/agent/bash-safety-guard.ts | 修改 | 入口接求值器（shadow 期保留旧链；清理期删） |
| tests/frameworks/agent/bash-safety-guard.test.ts | 修改 | :1190 期望按 BC-1 |
| tests/frameworks/agent/guard-dual-chain-consistency.test.ts | 修改 | 求值器纳入双跑对照（shell 族 evaluated 一致/载荷族一致 unevaluated） |
| docs/features/2026/10/09/F20261009gwte-*.md | 修改 | 本文档（v2） |

## 流程状态

- [x] 方案 v1 落盘（f6119ff2）
- [x] 机制预算四问（v1 内已答）
- [x] 重对抗门 + 方案对抗审视（合并轮，方案检视獭/kimi）：**条件通过**——S1 Payload.model 语义误判（严重）/ S2 验证集不充分（严重）/ S3 BC-5 缺失 / S4 声称矛盾 / S5 阈值无推导 / S6 逃逸未声明 / S7 四问打折；大獭裁决：分阶段不推倒（Phase 1 shell 族 / Phase 2 候选窄提取）
- [x] **v2 修订落盘（本文档）**：S1 分阶段（Phase 1 shell 族，Python/JS 显式回落）｜S2 语料库 ≥100 例子模块｜S3 BC-5 补入｜S4 声称订正｜S5 阈值 50% 重推导｜S6 BC-6 补入｜S7 打折注记；另订正 v1 基座文件名笔误（pi-bash-parser → command-lexer/command-model）
- [ ] delta 复审（同一检视獭，含 S2 事实反转点重核）
- [ ] 呈搭档终审定稿（附决策简报：BC-1 需搭档表态）
- [ ] （定稿后另行派工实现）
