---
id: F20261015glfp
title: bash 守卫误拦止血——git -C <worktree> 写族落点豁免（豁免分支对齐 v2 求值器 -C 落点语义）
summary: V1 生产链 git 写族豁免只认 cd 形态，`git -C <worktree> commit` 无 cd 段被「写命令落点解析到主仓」误拦（落点明明是 worktree 自树）——补 git -C 多级累积落点解析（段级豁免），豁免分支对齐 write-target-evaluator evalGitWrite「-C 目标优先」（全命令对齐不成立——skipGitWrite 短路在前不看 -C 目标，差异面挂 M-026d87ff 第三项）；负门（主仓根/worktrees 根/../ 逃逸/--git-dir|--work-tree 覆盖/混合段）全部保持
type: BugFix
date: 2026-10-15
capability_test: "n/a: 守卫判定逻辑修正，验证走单测（bash-safety-guard-git-dashc 20 例：放行侧 8 + 拦截侧 12），无独立 LLM 能力面"
intent:
  problem: "M-bf4049a3 案卷实证（b9026422 三组对照）：`git -C <worktree> commit --author=$(cat …)` 被「写命令落点解析到主仓」误拦，海獭 worktree 提交被堵死只能绕 cd 形态；机制结论「词面规则只在写链里扫，cd 豁免是唯一主通道」——V1 生产链的 git 写族豁免（cwdInGitWorktree→skipGitWrite，F20261014cwsp S1）只认 cwd 形态，-C 形态落点识别缺失"
  expected_effect: "git -C 目标（多级累积）落 worktree 区（<root>/.otter/worktrees/<name>[/…]）的 git 写族放行（worktree 自树操作非主仓写），与 cd 形态等价、豁免分支与 v2 求值器口径一致；主仓根/worktrees 根自身/../ 逃逸/--git-dir|--work-tree 覆盖/嵌套 decoy/混合段主仓写全部照拦；攻击面负门（eval 注入/主服务脚本 stop·restart/pkill 族）零放水"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
pr: ""
related_issues: ["#1170", "#1285", "#1304", "#1421", "#1494"]
causal_links: ["F20261014cwsp", "F20261008gduc", "F20261015smrj"]
---

# bash 守卫误拦止血：git -C <worktree> 写族落点豁免

## 背景

M-bf4049a3（板上止血工单）原始定性是「禁令族词面规则路径误伤」（`bash-safety-guard.ts` 的 `/\beval\b/` 撞 worktree 名 `guard-eval-v2`、`/otter-buddy|node/` 撞仓库路径，双命中误拦「针对主进程」）。**本轮探针复现证伪了这一定性**（见「排查结论」），真实病灶是 V1 生产链 git 写族豁免的落点识别面缺 `-C` 形态——与 #1170→#1360（F20261008gduc）同款「修复只落一条链」的双链语义割裂：v2 求值器（write-target-evaluator）早有「git 写族落点 = -C 目标优先，无 -C → cwd」跟踪，生产链只认 cd。

## 排查结论（预注册 → 实测）

**预注册**：动手前假设板上定性命中——词面正则 `:561/:563` 参与拦截判定、去掉词面命中即放行。

**预期 vs 实际**：**反转**。探针实测（checkBashCommandSafety 全链，projectRoot/sessionCwd 真实值）：

| 样本 | 预期（板上定性） | 实测（修前） | 结论 |
|---|---|---|---|
| A1 `git -C <guard-eval-v2> status`（eval+路径词面双命中，只读） | 拦 | **ALLOW** | 词面命中不拦 |
| A3 `git -C <guard-eval-v2> commit --author="$(cat …)"`（写+无 cd） | 拦（词面致因） | 拦「写命令落点解析到主仓」 | 拦的不是词面 |
| A4 同 A3 但路径无 eval 字样（guard-converge） | 放 | **同款拦** | 与词面命中无关，唯一变量是写动词 |
| D5 `git -C "<guard-eval-v2>" commit` | — | 拦 | 引号形态同病 |

**根因**（file:line，c7e83211 基线）：
- `src/frameworks/agent/bash-safety-guard.ts:557-564` `locateTriggerContext` 的 eval/进程名词面表**只做诊断回显、不参与拦截判定**（:552 注释明写）——【命中详情】把注意力引向词面，误导了板上定性（大獭 10-14 核实「两个都命中就触发拦截」被 A1/A4 反例证伪）
- 真拦截面：`judgeSegment` ③a'（`bash-safety-guard.ts:1112-1121`）git 写族段——豁免只看 `ctx.skipGitWrite`（= cwd 形态 `cwdInGitWorktree`，:1925 附近），`-C` 目标从不参与落点判定 → `git -C <worktree> commit` 恒被「写命令落点解析到主仓」拦
- 对照证据（案卷 b9026422 三组对照，探针逐条复现）：`git -C <wt> status`✓ / `cd <wt> && git add`✓ / `git -C <wt> commit --author=$(cat)`✗

**顺带实证的预存洞（不属本止血，另立 issue）**：`git -C "/path with space" commit`（引号含空格路径）**ALLOW**——`GIT_WRITE_SUBCOMMAND` 的 `\S+` 词面解析吞不下带空格 token，写族判定整体失明 = fail-open（v2 求值器词级解析无此洞，又一处双链强弱差）。同族：attached 形态 `-C<path>`。

## 机制识别检查点（修法决策树，动手前判定）

七项逐项：新增配置字段/枚举/开关 ✗；新增状态生命周期 ✗；新增定时任务/后台进程 ✗；新增信号类型/消息格式 ✗；新增持久化存储 ✗；新增决策分支（持久影响后续行为）✗——新增的是纯运行时落点谓词，不落任何状态；新增跨模块调用路径 ✗（同文件内 helper）。**全不命中 → 默认走修法决策树①②③**。

**判定：修法决策树①（既有语义内修）→ Modification-Class: `narrow-fix`，轻对抗**。论证：豁免机制已存在（F20261014cwsp S1 的 skipGitWrite + v2 求值器「-C 目标优先」双签口径），「写 worktree 自树 ≠ 写主仓」是既有裁决语义；本修只是把既有豁免的**落点识别面**补全到 `-C` 形态，未新增机制、未扩大豁免语义边界（豁免面 = 与 cwd 形态严格等价的 worktree 区判定）。

## 设计取舍

1. **段级豁免而非命令级**：`gitDashCTargetsWorktree` 挂在 `judgeSegment` ③a' 内、逐 git 段判定——`git -C <wt> commit && git commit` 的第二段（主仓写）照拦。若做成命令级开关（对齐 skipGitWrite 的注入形态），豁免会泄漏到同命令其他 git 段（D3 混合段回归钉死此取舍）。
2. **多级 -C 累积解析**：`git -C /repo -C .otter/worktrees/wt commit` 逐级 resolve 后判终态——与 git 自身 -C 累积语义一致；逃逸形态（`../../..`）经 path.normalize/relative 现形，不豁免。
3. **fail-closed 面刻意保守**：`--git-dir`/`--work-tree` 任一出现即不豁免（落点可被改写，静态不可信）；`~` 前缀不展开不豁免；剥引号后残余 `$`/反引号/引号/反斜杠（动态/解析不完整）不豁免；相对 -C 无绝对 sessionCwd 基准不豁免；worktrees 根自身不豁免（上溯发现主仓 .git = 写主仓树，与 v2 求值器「.otter/worktrees 根也属 worktree 区」的路径包含口径刻意取更严——git 写族的落点是「发现的 git 树」不是路径本身，根自身发现的是主仓树）。
4. **不修 GIT_WRITE_SUBCOMMAND 的 fail-open（D2 族）**：那是「放水」方向的预存洞，修它要动写族判定门本身（词面解析重写 + write-target-evaluator 两侧同步 + c107 词切分错位教训的风险面），与本止血（误拦方向）不同风险面、需独立对抗审视——单独立 issue，不混入止血 PR。
5. **词面诊断表不动**：`:557-564` 是纯诊断回显（误导性已记录），改它不改变判定、还会动诊断文案契约——留给 P1 双链一致性治理面。

## 影响范围

- `src/frameworks/agent/bash-safety-guard.ts`：新增 `gitDashCTargetsWorktree`（+40 行）+ `judgeSegment` ③a' 两行挂钩；其余通道（重定向/data 破坏/one-liner/kill 族/脚本自杀/PR merge）零改动
- 豁免面增量：仅「git 写族段 + -C 目标（可累积）解析后落 <root>/.otter/worktrees/<name>[/…]」一形态；与 cwd 形态豁免同语义边界
- v2 求值器（write-verdict/写链）零改动——corpus 冻结面不动；跨链一致性是朝求值器语义收敛（生产链补齐，不是求值器让步）——**但全命令级对齐未达成**：skipGitWrite 短路在前不看 -C 目标，`git -C <主仓> commit`（cwd=worktree）与 `cd <主仓> && git commit` 反判（prod:ALLOW/wv:BLOCK，delta 复核实测），差异面挂 M-026d87ff（wv 侧语义对齐伞下第三项：skipGitWrite 短路补 -C 目标）

## 对抗审视处置留痕（delta 复核 2026-10-15，检视獭1360 approve）

大獭裁决（15/10 11:49）逐条处置：

- **建议 1（记档说一套代码做一套 第三发）→ 本 commit 就地收窄**：「与 v2 求值器 -C 目标优先口径对齐」的声称只对豁免分支成立，措辞全部改为「豁免分支对齐」；差异面（skipGitWrite 短路补 -C 目标）立单挂 **M-026d87ff** 第三项
- 建议 2（symlink 逃逸链）→ **M-ed285d7c**（realpath 归一化工单）——与 cwd 形态共享既有边界、非本 PR 新泄漏（「与 cwd 形态严格等价」声称成立），修时两侧同口径
- 建议 3（反引号含空格构造双层全漏）→ 补进 **#1514**（M-46f0e74d）案面（同族：词切分失明）
- 建议 4（git alias 注入双层全放、真写主仓）→ **M-edd889c2**，大獭定级 **严重（P0）**（与 delta7 `~` 前缀同款依据：双层全放+真写主仓+攻击成本极低），既有词表设计边界不阻塞本 PR

## 验证

- **失败证据固化（修法决策树 5a）**：正式测试文件先行、stash 修复跑红——**7 failed**（放行侧 8 条中 7 条被误拦，仅「相对 -C + worktree 内 sessionCwd」走既有 cwd 豁免而绿），12 条负门全绿；恢复修复后 **20/20 passed**。修前/修后输出见 PR Verification 节
- 回归：全仓 `npx vitest run` **366 文件 5637 passed + 6 skipped**（基线 5617 + 新增 20），零回归——含 guard-touchstone 双库（corpus 守恒）、guard-v2-real-replay、agent 族全量
- 负门显式钉死（大獭点名验收）：eval 注入 `eval "kill 42877"` / 主服务脚本 `./scripts/otter-buddy.sh restart` / `pkill -f otter-buddy` 三攻击面照拦（测试内显式断言 + 全量既有负门零翻转）
- 边界形态回归：D1 主仓根 / D4 worktrees 根自身 / D6 `..` 逃逸 / D7 `--git-dir` 覆盖 / `--work-tree` 覆盖 / D3 混合段 / `~` 前缀 / 嵌套 decoy（`data/.otter/worktrees`）/ 相对 -C 无基准——全部照拦
