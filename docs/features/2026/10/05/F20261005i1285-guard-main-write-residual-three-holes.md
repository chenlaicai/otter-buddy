---
id: F20261005i1285
title: "bash 守卫主仓写检测残余三洞修复：bash -c 载荷递归 + 包装词表换结构 + 空赋值前缀"
summary: "#1275/#1278 合入后四轮对抗审视证明逐洞枚举式修复每轮都开新变体洞。本次三洞修复：洞1（bash -c wrapper 全绕）对 bash/sh/zsh -c 包装做载荷内层递归判定（复用 checkMainCheckoutWrite 同一基座）；洞2（包装词表封闭性）换结构不扩词表——段首 token 解析器（与 heredocInterpreter 同构「跳前缀词认解释器」式）替代正则锚集词表枚举，未知包装词 fail-closed 收窄拦；洞3（空赋值前缀）赋值项正则 \\S+ → \\S* 两处（one-liner 锚集 + git 写族锚）。13 个修复前实测复现载荷全部转 BLOCKED，9 个只读对称放行断言全过。"
change_type: fix
capability_test: "tests/frameworks/agent/bash-safety-guard.test.ts #1285 describe 块（33 用例：洞1 递归 8 + 洞2 包装 12 + 洞3 空赋值 4 + 自对抗变体 8 + 误拦面对照）；tests/repro-1285.test.ts 修复前复现探针（13 载荷修复前实测全 ALLOWED）"
created_in_conversation: dd453bf3-4035-4a1e-91e3-c3602dcdd473
intent:
  problem: "#1275/#1278 主仓写检测仍有三类残余绕过面：①bash -c/sh -c/sudo bash -c/echo|bash 包装 one-liner 载荷全放；②timeout/watch/setsid/stdbuf/arch 等词表外包装词全放（三轮枚举词表连爆教训）；③FOO= 空赋值前缀放行（one-liner 锚集与 git 写族锚同款）"
  expected_effect: "13 个修复前实测复现载荷全部转 BLOCKED；bash -c 只读载荷/包装词+只读 one-liner/纯未知命令（make build 类）不误拦；段首解析器换结构后未知包装词 fail-closed 收窄拦（未知词+one-liner 特征才拦）"
  verify_by:
    type: behavior_check
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
  - tests/repro-1285.test.ts
tags:
  - bash-guard
  - main-checkout-write
  - one-liner
  - bash-c-wrapper
  - wrapper-word-structural
  - empty-assignment
  - "#1285"
  - "#1275"
causal_links:
  from:
    - F20261005i1275
    - F20260922scwd
    - F20260930l573
---

# F20261005i1285：bash 守卫主仓写检测残余三洞修复

## 背景与教训

#1275/#1278 合入解释器直执行形态检测后，四轮对抗审视证明：**逐洞枚举式修复每轮都开新变体洞**。本 issue（#1285）三个残余洞里有两个（洞1/洞2）明确要求换结构，不再走枚举老路。全部最小复现载荷来自 PR #1278 review 链（pullrequestreview-5410814790 及勘误评论）。

## 三洞与修法

### 洞1：bash -c wrapper 全绕（对齐终止侧检测）

**现象**：`bash -c 'node -e "<写载荷>"'` / `sh -c` / `sudo bash -c` / `echo … | bash` 全部放行。kill 检测侧（checkKillSegment :339 起）已有 bash -c 载荷解析先例，主仓写侧没有。

**修法**：段首解析落点为 shell 解释器（bash/sh/zsh/dash/ksh）且含 `-c` 时，`extractShellCPayload` 提取载荷（引号感知、escape 感知、未闭合 fail-closed），载荷作为独立命令**递归走 `checkMainCheckoutWrite` 同一基座**——豁免判定与拦截判定同一提取基座（基座对齐设计约束）。`echo … | bash`（管道喂 shell 且上游含 one-liner 载荷）由管道补面拦截（与 cmdLevel pipe-to-shell kill 检测同构先例）。

**与 :1330 r3 残余安全门的职责重评估**：r3 残余安全门（`scanNormalizedWithOneLinerExemption` 内「剥除全部 one-liner 载荷后残余仍命中拦截 → 不豁免」）原职责是防 bash -c 载荷被 wrapper 吸收后差分等价误判放行。本次做了真判定后，该门**保留为兜底**——它防的是「归一化二次扫描路径上载荷集合差分误判」，与本次「首次扫描路径上的段首结构判定」是两条独立防线，语义不重叠（防御纵深）。

### 洞2：包装词表封闭性（换结构，不扩词表）

**现象**：`timeout 5` / `watch` / `setsid` / `stdbuf -o0` / `arch` 词表外全放。三轮连续爆在词表枚举。

**修法（换结构）**：`parseSegmentHead` 段首 token 解析器（与 heredocInterpreter :709 同构「跳前缀词认解释器」式）——跳过「赋值前缀（含空值）+ 已知包装词（`WRAPPER_SPECS` 表承载各词旗标形态：env 带 assigns、timeout/watch/nice 带 duration、stdbuf 值内联旗标等）」后：
- 落 one-liner 解释器（python/node/ruby/perl，含版本号尾缀）→ 按 one-liner 通道判定；
- 落 shell 解释器 + -c → 递归洞1；
- 落 `SEGMENT_HEAD_PASS_THROUGH` 高频只读常见词（git/grep/cat/make 类不在内——见下）→ 放行交后续层；
- **未知落点 + 段内含 one-liner/shell-c 特征 → fail-closed 收窄拦**（`timeout 5 node -e 写` 典型包装绕过必拦；`make build`/`gradle assemble` 纯未知命令不含 one-liner 形态不拦——误拦面收口）。

**未知包装词策略作答（任务要求权衡）**：选 **fail-closed 收窄拦** 而非「记录观察放行」——理由：① 放行面若开，词表外新包装词（`ionice`/`chrt`/`taskset`…）即刻成为新洞，与「换结构」初衷相悖；② 收窄条件（未知词 + one-liner 特征同段）把误拦面压到「用生僻包装词跑解释器 one-liner」这一极小集合，高频构建词（make/gradle/cargo）不含 one-liner 形态不受影响；③ 与 ruby/perl 只读全拦（S-5）、#1207 白名单反转同 fail-closed 先例一致。

**豁免基座对齐（实现期发现并修）**：词表内包装形态（`timeout 5 node -e 只读`）下，既有 `oneLinerPayloadReadOnly` 以 ONELINER_ANCHOR 词表为提取基座，与段首解析器不同源——豁免失明误拦只读载荷。补 `wrappedOneLinerPayloadsReadOnly`：剥段首前缀后在裸解释器起始的剩余文本上重跑既有白名单判定，提取基座与拦截落点同一解析器产出，词表差异归零。

### 洞3：空赋值前缀（预存洞顺带修）

**现象**：`FOO= node -e "<写>"` / `FOO= git push origin main` 放行。

**修法**：赋值项正则 `\S+` → `\S*` 两处——one-liner 锚集（ONELINER_ANCHOR）与 git 写族锚（MAIN_WRITE_PATTERNS[5]）。shell 语义上空赋值是合法赋值前缀，与 FOO=1 等价参与环境传递。

## 设计取舍

**机制预算四问（动手前判定，命中「新增机制」——洞2 换结构）**：
1. **解决什么问题**：主仓写检测对包装后的 one-liner 形态结构性失明——逐洞枚举词表四轮审视证明必开新洞，需要结构化的段首 token 解析器替代正则锚集枚举。
2. **现有机制为何不够**：ONELINER_ANCHOR 是正则词表枚举，未知包装词与 bash -c 壳包装都在词表外；bash -c 把整个载荷藏进引号，正则层完全不可见。
3. **更小机制可否达成**：洞3 是纯正则修复（`\S+`→`\S*` 两处，无更小形态）；洞1 复用已有 `checkMainCheckoutWrite` 基座递归，无新白名单；洞2 的段首解析器是换结构的最小形态（与 heredocInterpreter 同构先例，非新发明）。
4. **退役条件**：段首解析器取代 ONELINER_ANCHOR 包装词枚举部分后，锚集常量中的包装词表可删除（本次未删——正则通道仍承担词表内形态的快速命中，两通道同一豁免基座）；若未来 AST 级 shell 解析器（modelParseOk）全面替代 V1 链，本解析器随 V1 链一并退役。

**Modification-Class**：`mechanism-addition`（段首解析器 + 递归通道是新增机制，已过机制预算四问；洞3 部分为 narrow-fix）。

**负面向验收条目**：本次变更**没有**绕过任何既有保护——新增拦截通道挂点在 cd 豁免之后、git 只读白名单之后，与正则通道同一判定位置，无新增豁免面；`bash script.sh` 的模型层保守拦（guard-v2 既有行为）不受影响。

## 验证

**修复前实测复现证据**（tests/repro-1285.test.ts，13 载荷修复前全部 ALLOWED）：
- 洞1：`bash -c 'node -e "…writeFileSync…"'` / `sh -c` / `sudo bash -c` / `echo '…' | bash`
- 洞2：`timeout 5` / `watch -n 1` / `setsid` / `stdbuf -o0` / `arch` / `env -i` / `nice -n 5` + `node -e 写`
- 洞3：`FOO= node -e 写` / `FOO= git commit -m x`

**修复后**：13/13 转 BLOCKED；守卫测试全套 49 文件 1147 用例全绿（含 #1275/#1207/#984 等历史回归面）；lint（complexity/max-statements/max-params）全净。

**对称测试**（每类拦截配只读放行）：
- bash -c 只读载荷（`console.log(1)` / 多语句 `;` 载荷）→ 放行
- timeout/env -i 包装只读 one-liner → 放行
- 纯未知命令（make/gradle）→ 放行；timeout + 非解释器（grep）→ 放行
- FOO= + 只读（node console.log / git status）→ 放行

**自对抗变体实测（8 个未修变体，上轮教训：实现者不自对抗，检视必开新洞）**：
1. 递归 bash -c 嵌套两层 → 拦
2. timeout 5 + bash -c 混合包装 → 拦
3. env -i FOO=1 + bash -c 三层包装 → 拦
4. bash -c 载荷内重定向写 → 拦（递归基座含重定向通道）
5. bash -c 载荷内 git 写族 → 拦（递归基座含 git 通道）
6. 未知包装词（ionice -c3）+ python 写 → 拦
7. 放行面：载荷内引号分隔符是数据（`print('a;b|c&d')`）→ 放行（引号感知切段修复的误拦面）
8. 放行面：bash -c 只读多语句载荷 → 放行

**最简实现检查**：已过——洞3 纯正则两处；洞1 复用 checkMainCheckoutWrite 基座无新白名单；洞2 段首解析器与 heredocInterpreter 同构，非新框架。确认已最简。

**Golden Gate / 锚点重放**：n/a——本变更是守卫判定逻辑（硬代码），非 prompt/skill/协议层软代码，无行为触发语义改动。

**pre-existing 声明**：无——基线 363/363 全绿后动手，修复后 1147/1147 全绿，零 pre-existing 失败。

## r1 处置（检视獭-1297 初轮 REQUEST_CHANGES，3 严重 + 1 B 级全采纳）

初轮审视结论：三洞修复本体达标（13 载荷实测全拦、误拦面零、基座对齐核验为真同源），但双轨交界处开出 3 个严重。逐条处置：

### 严重1：词包装 git 写族全绕（:973）→ 采纳，git 落点接入段首解析器

git 写族正则锚只认赋值前缀不认包装词前缀，`env git commit` / `sudo git commit` / `timeout 5 git commit` 曾全放（旧基线对照：`env git stash push` 双版本都 ALLOWED，洞2 同型洞在 git 通道漏网）。修法：judgeSegment 新增 ③a' git 落点——剥包装前缀后落 git，`GIT_WRITE_SUBCOMMAND` 判定写子命令（比 MAIN_WRITE_PATTERNS[5] 宽：补 push / reset --hard / clean -f 同写族口径补齐）；只读子命令显式放行防误拦。连带形态 `(git commit)` / `{ git commit; }`（子壳/命令组，**预存洞**——旧基线 git 正则锚同样不含壳字符）：`stripSubshellWrap` 剥壳重判（全段单壳形态）+ `SUBSHELL_GIT_WRITE_GATE` 兜底（壳内多命令 fail-closed 收窄拦，与 ③d 同策略）。验收：8 拦 + 4 放对称断言。

### 严重2：extractShellCPayload 旗标在 -c 前全放（:807）→ 采纳，null 三态拆分

初版 null 单态把「旗标在 -c 前」与「无 -c 文件落点」混同，`bash -x -c '写'` 返回 null 被归文件落点放行（注释写「保守拒」实际放行，判定链语义错误）。修法：`ShellCExtract` 三态——FILE（无 -c，bash script.sh 放行）/ FAIL_CLOSED（-c 存在但旗标白名单外，拦）/ PAYLOAD（提取成功，递归 + consumedEnd）。旗标白名单 `SHELL_FLAG_WHITELIST` 参照 PY_FLAG_GROUP 模式列 shell 共有短旗标（a-y 常用集 + C E F H T W X），长旗标（--posix 等带参形态）白名单外 fail-closed。验收：4 拦 + 1 放（白名单旗标+只读载荷）。

### 严重3：载荷后剩余 token 无人判定（judgeSegment ③b :918）→ 采纳，③b 后继续判定剩余段

`bash -c 'echo a' timeout 5 node -e "写"` 载荷干净就 return，段内第二写命令裸奔。修法：③b 拆出 `judgeShellCSegment`——载荷递归命中即拦；未命中则剩余 token（consumedEnd 之后）按 splitShellSegments 切段重过 judgeSegment（depth 消耗与载荷递归同级，consumedEnd 严格右移保证终止）。参数位变体 `env C=k bash -c 'python3 -c "写"' _` 同型覆盖。验收：2 拦 + 2 放（`_` argv[0] 占位符 / `echo b` 只读剩余段）。

### B 级：tests/repro-1285.test.ts 伪断言 → 采纳，改真断言

原探针全部 `expect(true).toBe(true)`（修复前留档用），改 13 载荷全 `expect(r).not.toBeNull()` 真断言回归。

### r1 自对抗（三处修法边界，6 变体）

嵌套子壳 `((git commit))` 拦 / `bash -i -c` 白名单合写分离形态拦 / bash -c 载荷+剩余段 git 写族拦 / 递归终止性（嵌套 bash -c + 剩余段，depth 消耗不 hang）拦 / `git -C /wt status` 全局旗标+只读放行 / `bash --posix script.sh` 无 -c 不误判 FAIL_CLOSED（模型层既有拦不变）。

### r1 验证

守卫全套 1147 用例绿（+27 新断言）；lint 净；CI 待 push 后确认。

## 守卫宪法三问（必答）

1. **这次改动让攻击面变大了还是变小了？** 变小——新增拦截通道无新增豁免面；未知包装词从「默认放行」变「收窄拦」。
2. **白名单外形态是否 fail-closed？** 是——未知落点 + one-liner 特征拦；载荷提取失败/未闭合引号拦；嵌套超深拦。
3. **已知可判定的只读形态会不会误拦？** 不会——只读白名单基座对齐后（wrappedOneLinerPayloadsReadOnly）包装形态只读载荷不误拦；9 个对称放行断言 + 2 个自对抗放行面断言固化。

**#1260（守卫宪法 PR）状态同步**：开工时 #1260 未合入 main（`git log origin/main` 无对应提交，guard-constitution worktree 仍在）——已知洞清单对应条目状态无法在 main 上更新，按任务约束在此登记：洞1（bash -c wrapper）/ 洞2（包装词表）/ 洞3（空赋值前缀）三条目本 PR 修复，待 #1260 合入后由该线同步「已修复」状态。
