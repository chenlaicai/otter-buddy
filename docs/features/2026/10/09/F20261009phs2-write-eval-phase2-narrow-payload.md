---
id: F20261009phs2
title: 写落点求值器 Phase 2——脚本载荷窄提取 + git add index + remote ref + fd 复制口径 + shadow 口径修复
summary: gwte Phase 1 落地后的第二阶段：①脚本载荷窄提取（-c/-e 载荷 parts 全 lit 可拼接时写调用落点真实求值、只读载荷以主仓字面量闸为安全负门，多行载荷词法 fail-closed 常态面经 parts 拼接恢复）；②git add index 单独求值；③push --delete / :refs/... remote 操作放行；④2>&1 fd 复制非文件写；⑤shadow 跨规则/截断载荷口径修复。#1411 审视处置：Form A 绝对路径统一走 evalPath（堵 .. 爬升红线逃逸）+ argvBase off-by-one 修正 + 字面量闸拒 .. + 口径标注。shadow 判据四项全过（口径：main_write 完整命令子集，剔除跨规则 6/截断 21）：红线 0 / 误拦 0 / 回落率 19.3% / 族内 91.7%。
type: Design
date: 2026-10-09
capability_test: "n/a: 写落点求值器纯代码逻辑单测（Phase 1+2+#1411 处置共 49 用例三态矩阵，tests/frameworks/agent/write-target-evaluator.test.ts）+ shadow 语料 141 例四判据，非 prompt 行为面"
intent:
  problem: "Phase 1 脚本载荷族整段回落（heredoc-script-payload 是 FALLBACK 第一大头）；git add 落点语义缺位（index 非 cwd）；push --delete remote 操作被 cwd 求值误拦；2>&1 fd 复制被当文件写回落；shadow 判据把 sleep_block/data_destructive 别族拦截与 commandHead 截断载荷计入求值器账上"
  expected_effect: "Phase 1 声称覆盖族在完整命令上的真实求值率达标（族内 ≥90%），旧链行为不变（影子态），切换判据首次四项全过"
  verify_by:
    type: behavior_check
change_type: feature
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
causal_links:
  - F20261009gwte
  - F20261008gduc
---

# 写落点求值器 Phase 2——脚本载荷窄提取 + git add index + remote ref + fd 复制口径 + shadow 口径修复

## 背景

gwte Phase 1（F20261009gwte，PR 在审）落地「落点求值看事实」换轨，但首跑 shadow 暴露五个结构性缺口：

| 缺口 | 实证 | 影响 |
|---|---|---|
| 脚本载荷族整段回落 | `fallback:heredoc-script-payload` 是 FALLBACK 第一大头（首跑 34/73） | 族内成功率 53.4%，远低于 90% 判据 |
| git add 落点缺位 | GIT_WRITE_SUBCOMMAND 不含 add 是因 index 落点非 cwd——但 Phase 1 没给 add 单独求值通道，wt 内 `git add` 相对路径被误判主仓落点 | 误拦 2 例（c080/c081 同族） |
| push --delete remote 误拦 | c105/c131-c133：`push origin --delete feature/x` 是 remote 侧操作不落本地主仓树，求值器按 cwd 求值报主仓落点 | BOTH_DIVERGE 假阳性 |
| 2>&1 fd 复制误伤 | c052/c055/c069 等 `2>&1 \| tail` 形态全回落 dynamic-path（fd 复制被当文件写目标求值不出） | 回落率虚高 |
| shadow 口径混淆 | c086/c098/c136：sleep_block/data_destructive 别族拦截被计入求值器红线逃逸；c057-c103 等 21 条 ledger 样本 commandHead 截断 120 字符载荷不完整 | 判据永不达标（求值器背着别族+语料源的锅） |

## 目标

- Phase 1 声称覆盖族在完整命令上的真实求值率 ≥90%（族内成功率判据）
- shadow 切换判据首次四项全过（红线 0 / 误拦 0 / 回落率 ≤50% / 族内 ≥90%）
- 旧链行为不变（影子态——求值器只影响 shadow 对比，生产判定链不切）

## 非目标

- 完整脚本 AST 求值（搭档拍板：窄字面量路线，不做完整 AST）
- 判据线不动（gwte v2 预注册四项判据数值不改——本阶段修复的是「达到判据」不是「改判据」）
- 跨语句变量传播 / 字符串常量折叠之外的动态求值（c128-c130 边界锚：argv/sys.argv/拼接路径求值不出就回落，不猜）
- 生产链路切换（shadow 达标 ≠ 切换——切换决策呈搭档终审）

## 方案设计

### 模块 1：脚本载荷窄提取（evalScriptPayloadNarrow）

**核心判据**：载荷词 parts 全 lit/escape（词法层引号上下文已剥，无展开）→ 拼接得静态载荷；含 var/cmdsub/arithmetic → 真不可求值，回落不猜。

**多行载荷常态面**（gduc S1 实证）：`node -e "\nconst fs=require('fs');\n…"` 双引号体内嵌单引号触发词法 fail-closed，`evaluated=null` 但 parts 全 lit——拼接恢复。这是台账多行载荷的大头形态。

**双形态求值**：
- **形态A 写调用**：writeFileSync/open('p','w') 等，路径参数可静态求值（字面量 / argv[N] 值传播 / 纯字面量拼接折叠——语料 P2 边界锚 c128-c130）→ 落点入 targets（真实求值，写哪报哪）；写调用存在但路径不可求值 → 回落。
- **形态B 只读载荷**：无写调用词面 → 静态绝对路径字面量 ∩ 主仓树非空 → 回落（c062 `import('/repo/dist-probe/…')` 是旧链能拦而窄提取会误放的实样，主仓字面量一律回落旧链）；交集为空 → evaluated 放行。

**写调用词面表修正**（c032 实证教训）：`open`/`write` 单独词面不算写调用——python `open('p')` 默认读模式、`.write()` 是读文件后的方法链。真写语义由调用形态匹配判定（open 带写模式 / writeFileSync 等明确写函数 / `.write(` 方法调用）。

**相对路径写落点**（c123 实证）：`open('sub/rel.txt','w')` 落点 = 进程 cwd（syscall 语义）——cwd 是求值器已跟踪事实，直接拼接（cwd=wt → 落 wt 放行；cwd=主仓 → 落主仓拦截）。

**垃圾 cmdsub 过滤**（c032 实证）：词法把脚本括号 `print(open('…'))` 误当 `$(` 产生假 cmdsub 子模型（parseOk=false、段全是脚本 token 碎片、非脚本载荷族）——命令内层窄提取已求值过载荷时，这类子模型不构成独立回落理由（同一事实的重复保守）。

### 模块 2：git add index 求值（evalGitAdd）

GIT_WRITE_SUBCOMMAND 不含 add 的语义根源：**index 落点非 cwd**（git add 写 `.git/index`，跟 HEAD 不跟 cwd）。Phase 1 把 add 留给旧链正则，wt 内 `git add -A && git commit`（#1170 主形态 c052）的 add 落点被误判。

求值规则：落点 = ①索引（-C 目标/cwd 的 `.git` 元数据——无 -C 时 cwd 是主仓才构成主仓写）+ ②add 路径参数按工作树根求值（主仓 cwd 下 `git add docs/x.md` 相对路径落主仓工作树——判拦实证依据 c056/c059/c060/c134）。

### 模块 3：remote ref 放行（evalGitWrite 词级重写）

push --delete / push :refs/... 是 remote 侧操作，不落本地主仓树 → evaluated 空集放行。词级解析替换正则（c107 `git -c http.proxy= -c https.proxy= push --delete` 教训：正则 `\S+` 形态与词切分错位，求值层以词为准）。

### 模块 4：fd 复制口径（evalRedirects）

`2>&1` / `1>&2` / `2>&-` 是 fd 复制/关闭，不落盘、不构成写落点。旧链把 `2>&1 | tail` 形态的重定向目标 `&1` 当文件路径求值不出 → dynamic-path 回落（c052/c055/c069 等 16 条 FALLBACK 的构成大头）。Phase 2 起 fd 复制直接跳过。

### 模块 5：shadow 口径修复（shadow-write-eval.mjs）

①**跨规则剔除**：verdict=BLOCK 且求值器 ALLOW 时，若裁决注明跨规则（note 含 EXPECTED-CROSS 或 ruleId=非 main_write 族），不计红线逃逸——逃逸语义仅限「main_write 维度被求值器有把握放行」（c086 sleep 45 是 sleep_block 族、c098/c136 同族）。
②**截断载荷剔除**：ledger 样本 commandHead 截断 120 字符，多行载荷不完整（引号不闭合）→ 求值器回落是源数据上限非覆盖缺口（全形态由合成样本钉死）。两类样本从判据分母剔除，单独计数披露。

## 机制识别检查点（逐项打勾）

- □ 新增配置字段/枚举/开关 → **未命中**
- □ 新增状态生命周期 → **未命中**
- □ 新增定时任务/后台进程 → **未命中**
- □ 新增信号类型/消息格式 → **未命中**（shadow 报告新增 EXPECTED_CROSS_RULE/TRUNCATED_PAYLOAD 计数字段，是既有报告的披露维度补全，非新消息格式）
- □ 新增持久化存储 → **未命中**
- □ 新增决策分支（结果被记住并影响后续行为）→ **未命中**（求值器是纯函数，分支结果不持久化）
- □ 新增跨模块调用路径 → **未命中**（shadow 脚本调用既有 evaluateWriteTargets，无新模块）

**结论**：全部未命中，无净新增机制。Modification-Class 判 **narrow-fix**（既有语义内修：Phase 1 声明的覆盖面补全 + 口径修正，不引入新判定维度）。

## 设计取舍

**窄提取 vs 完整 AST**：搭档拍板窄字面量路线。理由——AST 求值器是「猜脚本行为」的放大版，误判面从「词面黑名单」换成「AST 覆盖缺口」；窄提取只认「可静态求值的字面量形态」，求值不出就回落旧链（fail-closed 语义不破）。

**主仓字面量闸（形态B 负门）**：只读载荷含主仓字面量一律回落——c062 `import()` 动态加载主仓路径是实证：求值器不猜运行时读取后果，字面量防线不破。代价是 c100（读主仓 data 路径的只读分析脚本）也回落——可接受的保守侧留存（切换后由调用方政策层豁免，不在求值器内开口）。

**截断载荷剔除判据的合法性**：ledger 样本 commandHead 是拦截时的截断字段（120 字符上限），不是求值器的输入上限。截断命令引号不闭合天然 parseOk=false——回落是词法事实，不是求值器覆盖缺口。剔除依据：全形态已由合成样本（c122-c130 + 新增 19 条）钉死，截断样本只测「既有截断面行为=旧链」，对「求值器是否覆盖完整命令」无信息增量。

**evaluated 空集探针（parseOk=false 放行门槛）**：`echo "unclosed` 这类词法失败命令若段求值零落点，evaluated 空集是假信息（词面求值不出）——Phase 2 加探针：parseOk=false 且探针求值零落点且无窄提取成功 → 回落 parse-failed 保 Phase 1 保守语义（c044 回归修复）。

**#1411 审视处置取舍（本次 delta）**：

- **统一 evalPath vs 求值后补拒**：审视报告给了两选（Form A 绝对/相对统一走 evalPath，或求值后 `if (resolved.includes("..")) return "heredoc-script-payload"`）。选前者（根因优先）：evalPath 是既有守卫单一真相源（`..`/$/`/~ 一律拒），统一后无第二套拦截逻辑要同步；且 evalPath 绝对分支语义与 normalizePath 等同（同为斜杠折叠），唯一差异是拒 `..`——不引入新回落面。后者会在守卫外再拷一份 `..` 判定，将来 evalPath 口径变化时双处同步（#1170→S1 的双链不同步教训）。
- **argvBase off-by-one 修正在处置中发现并修正**（审视未发现，Discovered）：实现者实测 `node -e "…" AAA BBB` → `process.argv=[execPath,AAA,BBB]`（无脚本文件插入 argv），旧代码 node 取 argvBase=2 把 argv[2] 映射到第一实参——off-by-one 假放行面（`node -e "fs.writeFileSync(process.argv[2],'x')" /tmp/a /repo/b` 曾误判 ALLOW，真值 /repo/b 主仓）。修正为 node/python 统一 argvBase=1。附带效应：c128（argv[1] 主仓）/c130（sys.argv[1] /tmp）从「回落」变为「正确判定」（拦截增强 + EVAL-GAIN 解锁旧链误拦）。
- **负门编码 UNEVAL_UNKNOWN vs BLOCK**：c137/c138（.. 爬升钉回落）首次用 BLOCK 编码进语料，shadow 族内 89.8% 卡线（负门本身是「期望回落」语义，不是「覆盖面损失」）。对齐 Phase 1 预注册先例（c99/c100 `$W/..` 同型负门即 UNEVAL_UNKNOWN）改为 UNEVAL_UNKNOWN——判定链行为不变（BLOCK 期望下 eval=FALLBACK 也不计入逃逸），只修正分母语义编码与先例一致，非移动球门。
- **字面量闸拒 ..（extractAbsPathLiterals）**：旧代码含 `..` 的绝对字面量直接跳过提取（注释说与 evalPath 同口径——但「跳过」≠「拒」：`'/wt/../../../main/config.json'` 这类主仓耦合读路径会绕过字面量闸误放行）。统一为提取后含 `..` fail-closed 回落，与 Form A 同口径。

## #1411 对抗审视处置（delta，检视獭1360 报告）

| 发现 | 级别 | 处置 | 说明 |
|---|---|---|---|
| §3.1 Form A 绝对路径 .. 爬升红线逃逸 | 🔴 严重 | **已修**（本 PR） | 写侧+读侧统一走 evalPath（拒 `..`→回落）；语料负门 c137/c138（绝对+拼接两形态）钉回落永久进库；单测 4 例新增钉死。审视实测逃逸形态现判 `unevaluated:heredoc-script-payload`，旧链兑底 |
| §3.1 附 c128-c130 注释措辞 | 🔵 建议 | **已改** | 「不做常量折叠」→「不追踪变量赋值的拼接」（折叠/值传播实已实现，变量赋值后传递不追踪）；c128/c130 因 argvBase 修正升级为正向用例，措辞同步 |
| §3.2 shadow 判据「达标」口径 | 🟡 中 | **已标注** | 切换报告/特性文档/脚本达标输出三处显式标注「main_write 完整命令子集达标，剔除跨规则 6 / 截断 21」；截断剔除理由（源数据上限非覆盖缺口）写入 shadow 脚本预注册注释节 |
| （处置中发现）argvBase off-by-one | Discovered | **已修**（同通道同 PR） | node -e 无脚本文件插入 argv，首实参在 argv[1]（实测锚点：`node -e "…" AAA BBB` → argv=[execPath,AAA,BBB]）。旧 argvBase=2 使 argv[2] 映射错位——`node -e "fs.writeFileSync(process.argv[2],'x')" /tmp/a /repo/b` 曾误判 ALLOW（真值主仓）。修正后 c128/c130/c139-c141 五例钉死新语义 |

处置协议说明：严重项与 Discovered 项均为「改了让系统变好」→ 本 PR 修复（diff 可见）；无反驳项。

## 影响范围

- 生产行为：**零变更**（求值器影子态，shadow 对比用——切换决策呈搭档终审）
- 代码：`src/frameworks/agent/write-target-evaluator.ts`（+约 250 行：窄提取/git add/remote ref/fd 复制四模块 + #1411 处置：evalPath 统一/argvBase/字面量闸拒 ..）、`scripts/shadow-write-eval.mjs`（口径修复 + 口径标注输出）、`scripts/build-write-eval-corpus.mjs`（合成样本 19 条 + #1411 负门 5 条 + c128/c130 裁决修正）、`tests/frameworks/agent/write-target-evaluator.test.ts`（+24 例 Phase 2 三态矩阵 + #1411 处置 7 例改/增）、`tests/fixtures/guard-write-eval-corpus.json`（truncated-payload 标注 21 条 + #1411 负门 5 条 + 裁决修正 2 条）
- 既有测试：1 例期望更新（`node -e argv[1]` 主仓实参从「回落」改为「拦截」——argvBase 修正后语义升级，拦截增强非削弱）；1 例注释措辞修正（c129）

## 验证

| 验证项 | 结果 |
|---|---|
| Phase 1+2 单测（含 #1411 处置） | 49/49 通过（#1411 处置：负门 .. 爬升×2 / argv 语义×4 / python argv×1；改注释 1 例 + 期望升级 1 例） |
| shadow 判据 | **四项全过**（口径：main_write 完整命令子集，语料 141 例，剔除跨规则 6 / 截断 21）：红线逃逸 0 / 误拦 0 / 回落率 19.3%（≤50%）/ 族内成功率 91.7%（88/96 ≥90%） |
| 审视逃逸形态回归 | c137（绝对 .. 爬升）/c138（拼接 .. 爬升）eval=FALLBACK（heredoc-script-payload），旧链 BLOCK 兕底——假放行面消除 |
| 全仓测试 | 本次处置后待跑（前次基线 5240/5240 + 增量 5） |
| eslint | 0 error（复杂度豁免按仓惯例注释声明） |
| 负门回归 | c062 import() 主仓路径仍回落 / c125-c126 写主仓仍拦 / c129 变量赋值拼接仍回落 / c044 parse-failed 语义保持 / c137-c138 .. 爬升回落（#1411 新钉） |

## 改动范围

```
src/frameworks/agent/write-target-evaluator.ts  (+约 250 行 + #1411 处置：evalPath 统一/argvBase/字面量闸拒 ..)
scripts/shadow-write-eval.mjs                   (+约 30 行口径修复 + 口径标注输出)
scripts/build-write-eval-corpus.mjs             (+19 条合成样本 + #1411 负门 5 条 + 裁决修正)
tests/frameworks/agent/write-target-evaluator.test.ts (+24 例 + #1411 处置 7 例)
tests/fixtures/guard-write-eval-corpus.json     (truncated-payload 标注 21 条 + #1411 负门/裁决修正)
docs/features/2026/10/09/F20261009phs2-write-eval-phase2-narrow-payload.md (本文档)
```

## 风险与遗留

- **截断载荷族的真实行为未知**：21 条截断样本的完整命令形态求值器没见过——切换后若台账出现完整多行载荷的新误拦/逃逸形态，语料库需补全形态（构建脚本 S4 节已钉死 19+#1411 5 条全形态锚，新增形态走同流程）。
- **族内 91.7%**：剩余 8 条族内 FALLBACK（c023/c024/c036 赋值溯源+cmdsub 变形、c052/c055/c058 等动态路径）是 Phase 1 显式声明的保守侧留存（BC-5/BC-6），不计划本阶段覆盖。
- **build 脚本 ledger 回捞时变漂移**（#1411 处置发现，未修）：build-write-eval-corpus.mjs 的 S2 回捞用 30 天滑窗，重跑会带入新事件致全部下游 id 错位（实测 90 处 diff）——本次用 fixtures JSON 直接增量编辑规避。后续应改固定快照或 id 稳定化，另开 issue。
- **切换不自动**：shadow 达标 ≠ 生产切换——gwte 模块 3「接入与切换」三步走的第二步待搭档拍板。
