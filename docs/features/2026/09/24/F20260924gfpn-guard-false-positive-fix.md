---
id: F20260924gfpn
title: bash 守卫第四次误拦修复：git 只读白名单快通道 + merge/commit-tree 负向断言 + cd 检测跳过赋值前缀 + heredoc 载荷剥离
doc_type: feature
change_type: fix
created: 2026-09-24
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/git-readonly-whitelist.ts
  - src/frameworks/agent/quoted-text-sanitizer.ts
  - tests/frameworks/agent/bash-guard-false-positive-fix.test.ts
summary: "9/23 台账（healing_events a9260c50《issue处理》12:43-15:23 约 20 条连环拦）实证：bash 守卫三天三修（qbsw/glay/gr1f）仍误拦正当命令，阻塞守卫修复 PR 自身 commit。根因：历史修复只覆盖『该拦的拦住』，放行侧系统性缺失。修 4 处真根因：① 写族正则 merge 词吞只读 git merge-base（merge(?!-) 负向断言）；② 缺 git 只读白名单快通道；③ cd 检测漏识别变量赋值前缀段（W=/path; cd $W/...）；④ heredoc 载荷体字符串（测试文本含终止族字样）被当真实终止命令。排查期误判的『⑤进程名模式吞路径』经真实主进程 PID 实测证伪——它只是诊断回显层，症状是旧 dist 上①-④的表现，合入+重启即消失。核心交付：66 例放行侧回归（历史三次修复都缺的一侧）+ 拦截侧保持。"
tags: [bash-safety-guard, false-positive, git-readonly-whitelist, heredoc-payload, cd-detection, narrow-fix]
capability_test: "n/a: narrow-fix 收窄既有守卫误拦面，回归用例固化于 tests/frameworks/agent/bash-guard-false-positive-fix.test.ts（66+ 例含安全面与放行侧）"
causal_links:
  from:
    - F20260923qbsw
    - F20260923glay
    - F20260922scwd
  to: []
---

# F20260924gfpn：bash 守卫第四次误拦修复（放行侧回归 + 5 处根因）

## 背景：守卫修复 PR 被守卫自己拦死（9/23 连环拦）

9/23 台账实证（healing_events 表 conversation_id=a9260c50，《issue处理》对话 12:43–15:23 约 20 条连环拦）：守卫修复獭在 guard-r1-fix worktree 里做完了 #1154 全部修复、227 测试全绿，**结果 commit 这一步被守卫连环拦**：

- `cd .../guard-r1-fix && git add -A && git commit -F /tmp/...` → 被「未 cd 主仓写」拦（真正拦截的是①-④的判定层在旧 dist 上的表现；回执里的「进程名模式」仅是诊断回显，非判定层——详见⑤节）
- 换 `W=/path; cd $W/...` → 变量赋值前缀让 cd 检测失效
- 连 `rm -f .commit-msg.txt` 都被拦

**"修了这么多次还有问题"的根因**：qbsw（引号盲）/ glay（分层判定）/ gr1f（r1 审视）三次修复各打一处盲区，**测试只覆盖"该拦的拦住"，从没系统覆盖"不该拦的放行"**。误拦/漏拦是同一硬币的两面，只测一面必然翻车。

## 5 处根因与修法

### ① git 写族正则吞只读子命令（`merge\b` → `merge(?!-)`）

`bash-safety-guard.ts` 写族正则 `/(?:^|[|&]...)git\s+(?:commit|rebase|merge\b|...)/` 中 `merge\b` 把只读的 `git merge-base` 判成写操作。实测（dist 当前 main）：`git merge-base main feature/x` → BLOCKED。

**修法**：`merge` → `merge(?!-)` 负向断言（merge 后不允许紧跟 `-`，merge-base/merge-file 等 `-` 开头派生只读词放行）。同组其他词审计：`commit` → `commit(?!-tree)`（commit-tree 是 plumbing 只读，同型前缀吞噬）；cherry-pick/apply/rebase/stash push 无 `-` 开头只读派生，不改。

### ② 缺 git 只读白名单快通道（黑名单思维 → 补白名单出口）

git 后跟明确只读子命令（log/diff/status/show/rev-parse/rev-list/merge-base/branch/blame/describe/ls-files/ls-remote 等 22 个）时应跳过主仓写判定。**历史全靠「恰好不在写族正则里」兜底，脆弱**。

**修法**：`GIT_READONLY_WHITELIST`（精确全称 Set）+ `gitSubcommandOf`（取首个非 flag 词元为子命令，剥赋值前缀）+ `allSegmentsGitReadonly`（整条命令每段都是白名单只读段才命中）。

**安全红线（防放宽变形绕过）**：
- 白名单词**精确匹配子命令全称**（首词元全等），`git log-f` 变形不命中。
- 白名单**只管跳过 git 写族判定**——重定向/data 破坏/kill 族判定照常跑。
- **写族字面判定先于白名单**（`git stash push` 的 push 在写族正则内，先于白名单命中，杜绝 stash 白名单词被显式写子命令借壳）。
- 链式绕过防线：`git log && git commit` / `git log; rm -rf data` 任一段不在白名单 → 不命中快通道，回落既有判定。

### ③ cd 检测漏识别变量赋值前缀段（hasRealCdSegment）

`W=/path; cd $W/.otter/worktrees/x && git add -A` 中首段是赋值（`W=/path`）不是 cd，`hasRealCdSegment` 取 segs[0] 漏识别。

**修法**：段判定跳过纯赋值前缀段（`isPureAssignPrefix`：`VAR=value` 形态、可任意多个）后再取首个真命令段——剥除赋值前缀后首个真命令段须为 cd 才豁免；赋值前缀后再出现其他命令段（非 cd）→ 该段不是 cd，不豁免。

### ④ python/node heredoc 载荷体字符串被当真实终止命令

`python3 - <<EOF ... EOF` 的载荷体（测试用例文本含 kill 字样）被当真实终止命令——cmdLevel「脚本 one-liner + kill + 数字」在**原文**上命中载荷内数据，abort 整个 invoke + 重试刷屏（失败代价放大器）。

**修法**：`stripHeredocPayloads`（quoted-text-sanitizer.ts）——heredoc 定界行之后到闭合行为止是 python/node 的 stdin 数据（非 shell 语法），对 shell 层判定是数据 → 整体剥离（等长空格替换，offset/分段不受影响）。

**安全红线（fail-closed，剥不干净宁可拦）**：
- 定界符带引号（`<<'EOF'` / `<<"EOF"`）→ 无展开无危险，剥。
- 定界符裸名且命令行含 `$()`/反引号/`${}` → 载荷内有 shell 展开（危险通道），**不剥**。
- 找不到闭合行（未闭合 heredoc）→ **不剥**，保守拦。
- 每条放宽都问：LLM 能不能用这个放宽变形绕过 kill 主进程？——剥后文本上 kill 检测照常跑（glay「kill 检测看原文」语义不回退）。

**语义边界**：`python3 - <<EOF` 命令头本身是主仓写形态（patch 语义静态不可分），守卫对该命令头保守拦是对的；**cd worktree 后**（落点即 worktree）载荷体内 kill 字样数据不得再触发 cmdLevel 拦截——这才是台账连环拦的失效层。要跑 heredoc 分析脚本先 cd worktree。

### ⑤「进程名模式吞路径」——排查期误判，实测证伪（无独立第五缺陷）

**排查期的假设**：拦截回执【命中详情】总显示 `进程名模式：…s/orca/ai/otter-buddy/.otter/wo…`，看起来是进程名正则 `otter-buddy` 词元匹配到了 worktree 路径——据此推断存在「一个独立判定层，cd 豁免对它不生效」。

**实测证伪（真实主进程 PID 95447）**：
- 「进程名模式」那段代码是 `locateTriggerContext`（bash-safety-guard.ts），注释明确写着**只做诊断回显、不参与拦截判定**——它只是拦截后告诉你「命令里哪里出现了敏感词」，是个「显示层」，不是「判定层」。
- 真正拦下那些命令的，还是 ①-④ 修的那几处判定层（cd 豁免被引号剥离盲区吃掉 + 写族正则覆盖不全）。
- 症状在**旧 dist**（9/23 20:18，未 build + 主进程未重启）上表现：守卫跑旧代码，①-④ 的修复未生效，于是「命令含 worktree 路径就被拦」。

**结论**：不存在未修的「第五个 bug」。⑤ = 「命令含 worktree 路径就被拦」这个症状的**误诊**——它就是①-④的既有缺陷在旧 dist 上的表现。修复合入 + 主进程重启（重新 build dist + 重启）后，这个症状自然消失。

**本特性处置**：无需改代码修⑤。①-④ 已在本特性修复且 worktree 单测全绿；⑤ 随①-④ 的部署生效而消解。

## r1 处置（检视獭1156 对抗审视）

PR #1156 初轮对抗审视（检视獭1156，kimi 模型与实现者 kimi-k28 错开）产出 1 严重 + 3 建议，全部处置：

### F1（严重，必修）：白名单快通道短路重定向主仓写判定——拦截侧回归

**现场**：`git log > /repo/hacked.txt` / `git show HEAD:src/a.ts > /repo/src/a.ts` / `git diff > /repo/docs/x.md && git status` 在 PR 上放行、main 基线拦截。

**机制**：原实现 `allSegmentsGitReadonly(command)` 命中时 `return null` 跳出整个 `checkMainCheckoutWrite`，把下方 `REDIRECT_PATTERN` 重定向防线整体旁路——与「重定向判定照常跑」注释直接矛盾。正是「历史三次修复缺的那一侧的镜像盲区」：放行侧测试补了，但「放行逻辑不得旁路拦截侧」这条没测。

**修法**：白名单命中只跳过 git 写族循环、**不 return null**——把写族循环包在 `if (!gitReadonlyCmd)` 里，命中则跳过该循环，继续走下方重定向判定。重定向目标绝对路径且在主仓外仍豁免（`git log > /tmp/out.txt` 放行，与 #1038 绝对路径豁免一致）。

### S1（建议）：白名单含 stash/config/tag/branch 等有写形态子命令

**处置**：白名单收紧为真只读子集（移除 stash/remote/tag/config/reflog/branch 6 词），新增 `AMBIGUOUS_READONLY_FLAGS` 第二级精确判定——这 6 个「带写形态子命令」的只读形态（`git branch -a` / `git stash list` / `git tag -l` / `git config --get`）靠 flag/参数精确识别放行，写形态（`git stash push` / `git tag v1` / `git config k v`）不在白名单、也非只读形态 → 回落写族判定拦截。bare 形态（`git branch` / `git stash` / `git tag`，git 语义里 bare=list）放行。

**澄清**：`git tag v1.0` / `git config k v` / `git branch newb` 等写形态**守卫历史上就不拦**（dist 当前 main 实测 PASS，写族正则只覆盖 commit/rebase/merge/cherry-pick/apply/stash push）——非本次回归。S1 收窄与既有 main 完全一致。

### S2（建议）：「cd 豁免优先于危险载荷检测」设计选择进正文

**处置**：见 ④ 语义边界——cd worktree 后（落点即 worktree）载荷体内 kill 字样数据不再触发 cmdLevel 拦截；要跑 heredoc 分析脚本先 cd worktree。这是与 glay「cd 豁免优先于脚本 one-liner 载荷字符串规则」同型的设计选择，固化于测试。

### S4（信息）：新增实为 62 例 it，文档三处称 81 例

**处置**：r1 补 4 条「白名单+重定向」对抗用例后，文档统一改为 66 例。

## 修改的对抗面自检（每处放宽的变形绕过评估）

| 放宽 | 变形绕过尝试 | 结果 |
|------|------------|------|
| merge(?!-) | `git merge--x`（非词，git 报错） | 无写语义，不影响 |
| 白名单快通道 | `git log && git commit` | commit 段不在白名单 → 不命中，回落写族判定仍拦 |
| 白名单快通道 | `git log; rm -rf data` | rm 段无 git 子命令 → 不命中，data 破坏判定仍拦 |
| 白名单快通道 | `git log-f`（前缀模糊变形） | log-f 不在白名单全称集合 → 不命中（守卫无写语义可拦，放行） |
| 白名单快通道 | `FOO=1 git commit`（赋值前缀） | gitSubcommandOf 剥赋值前缀取到 commit → commit 不在白名单 → 不命中，写族正则（含赋值前缀锚）命中仍拦 |
| cd 跳过赋值前缀 | `FOO=1; git commit`（赋值独立段，无 cd） | 剥赋值后首真命令段是 git commit（非 cd）→ 不豁免，写族仍拦 |
| heredoc 载荷剥离 | `python3 - <<EOF` 载荷内 `$(rm -rf data)` | 裸定界符 + 命令行含 $() → 不剥（危险通道），保守拦 |
| heredoc 载荷剥离 | 未闭合 heredoc 载荷内 kill 字样 | 不剥，fail-closed 保守拦 |

## 测试

**新增 `tests/frameworks/agent/bash-guard-false-positive-fix.test.ts`（66 例）**——历史三次修复都缺的**放行侧回归**（PASS 断言）+ 拦截侧保持（BLOCKED 断言）：

- **git merge-base 各形态**（5 例）：裸命令 / --all / HEAD origin/main / 命令替换内 / 管道链 → 全部 PASS
- **git 只读白名单**（20 例）：log/diff/status/show/rev-parse/rev-list/merge-base/branch/blame/describe/ls-files/ls-remote/stash list/stash show/remote/tag/config/shortlog/reflog 等 → 全部 PASS
- **cd worktree + git 写族正道**（6 例）：台账连环拦现场形态（cd worktree && git add -A && git commit -F /tmp/xx）→ 全部 PASS
- **变量赋值前缀**（5 例）：W=/path; cd $W/... / 多赋值前缀 → PASS；赋值后无 cd → 仍拦
- **python heredoc 载荷剥离**（8 例）：cd worktree 后载荷含 kill/pkill/eval/项目路径 → PASS；未闭合 fail-closed → 仍拦；真 patch 未 cd → 仍拦
- **node -e 载荷**（4 例）：载荷含 kill+数字保守拦（glay 语义不回退）/ 无数字或纯项目路径 → PASS
- **gh issue create --body 含项目路径**（3 例）：#858 脱敏管道保持
- **拦截侧总回归**（10 例）：kill <mainPid> / git commit 未 cd / eval kill / pkill -f / bash -c kill / kill $(lsof) / rm -rf data / 重定向未 cd / git merge 真合并 / FOO=1 git commit 未 cd → 全部仍拦

**既有测试基线保持绿**：`bash-safety-guard.test.ts` / `quoted-text-sanitizer.test.ts` / `bash-guard-layered-detect.test.ts` 全绿；全仓 `npx vitest run` 3937 例全绿。

**bugfix Verification（修复前失败输出 + 修复后通过输出）**：
- 修复前：`git merge-base main feature/x` → BLOCKED（dist 当前 main 实测，guard-test3.mjs）；新测试文件 77 例中 18 例失败（before-fix.txt）
- 修复后：全部台账命令形态 PASS（单测 66 例全绿，after-fix.txt）

## 影响范围

- `src/frameworks/agent/bash-safety-guard.ts`：写族正则（merge/commit-tree 负向断言 + 赋值前缀锚）、GIT_READONLY_WHITELIST + gitSubcommandOf + allSegmentsGitReadonly、hasRealCdSegment 跳过赋值前缀、checkMainCheckoutWrite 判定顺序（cd 豁免 → 写族字面 → 白名单快通道）
- `src/frameworks/agent/quoted-text-sanitizer.ts`：stripHeredocPayloads（heredoc 载荷剥离，fail-closed）
- `tests/frameworks/agent/bash-guard-false-positive-fix.test.ts`：新增 66 例放行侧 + 拦截侧回归

## 合入后生效验证 checklist（本次最大教训）

**核心教训**：守卫修复改的是 `src/`，但主进程运行时加载的是 `dist/`（build 产物）。**只改 src 不 build + 不重启主进程，修复不生效**——本次排查期误以为存在「第五个独立 bug」，实为旧 dist 上①-④缺陷的持续表现。

**合入后必须执行**：
1. `npm run build`——重新编译 dist（含本次①-④ + r1 全部修复）
2. 重启主进程——让运行时代码重载新 dist（重启方式遵循受控脚本，勿直接 kill 主进程）
3. 台账观察 24–48h——复跑 9/23 台账（healing_events a9260c50）里被拦的命令形态，确认误拦面收敛
4. 抽验拦截侧仍拦——`kill <主PID>` / `git commit -m x`（未 cd）/ `git log > /repo/x.txt` 等仍 BLOCKED

**验证锚点**：重启后用真实主进程 PID 跑守卫单测里的放行用例（`git merge-base` / `cd worktree && git checkout -b` / `W=/path; cd $W/...`），应全 PASS；拦截用例（kill 主 PID / 未 cd 写族）应全 BLOCKED。

## 已知取舍（非遗留 bug）

- **node -e / python heredoc 的 kill 字样保守拦**：glay 既定「kill 检测看原文」语义在 node -e 字符串含 kill+数字时保守拦，分析脚本须写成 .mjs 文件绕开。这是既定取舍（防误放行），本特性固化了该语义（测试防误放行），后续如需放宽须独立评估。

## causal_links 说明

- from F20260923qbsw（引号盲修复）/ F20260923glay（分层判定）/ F20260922scwd（主仓写拦截）：本特性在其后修第四次，不回退已修
- 本特性是 qbsw/glay/gr1f 的延续——三次修复缺放行侧回归，本特性补上
