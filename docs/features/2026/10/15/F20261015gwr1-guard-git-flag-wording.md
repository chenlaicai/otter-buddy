---
id: F20261015gwr1
title: bash 守卫 P0——git 旗标词面判定词级化（引号含空格/attached/反引号三形态 fail-open 修复）
summary: GIT_WRITE_SUBCOMMAND 正则 \S+ 词面对 `git -C "/x y" commit`（引号含空格）/`git -C/x`（attached）/`git -c \`echo /repo\` commit`（反引号）整体失明=写族判定 fail-open（#1514/M-46f0e74d 实证）——写族判定/落点解析词级化（词法层归一），旧正则两侧退役；wv 侧 attached 值回收 + git 写族 dynamic-path 不洗白（词面证盲点收窄），corpus 棘轮零新增缺口
type: BugFix
date: 2026-10-15
capability_test: "n/a: 守卫判定解析基座修正，验证走单测（bash-guard-git-flag-wording 11 例）+ 全量回归 + corpus 棘轮精确复位"
intent:
  problem: "M-46f0e74d/#1514：git 写族判定门（GIT_WRITE_SUBCOMMAND 正则）的 \\S+ 词面解析对引号含空格路径/attached 旗标/反引号动态值三形态整体失明——`git -C \"/repo/<含空格>\" commit` 类真写主仓双层漏（prod gate 盲 + wv attached 值丢失回落 cwd 洗白 + 动态 -c 载荷被词面证洗白）；检视獭1518 建议 3 补强的反引号构造双层全漏同族"
  expected_effect: "三形态写族判定归位：prod 拦（正道豁免仍可用——worktree 落点引号/attached 感知）、wv 正判落点证据（引号归一/attached 值回收）；反引号/动态 -c 载荷 wv fail-closed（dynamic-path 不洗白）；push --dry-run/stash push 等严格语义与 r2-C 基线一致；空格形态与无空格形态判词一致（病核=同语义两形态反判）"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
pr: ""
related_issues: ["#1514", "#1513", "#1285"]
causal_links: ["F20261015gali", "F20261015glfp", "F20261015gsub"]
---

# bash 守卫 P0：git 旗标词面判定词级化（#1514 fail-open 家族）

## 排查结论（探针 + 词法模型实证，修前证据存档 PR Verification）

| 形态 | 修前 prod | 修前 wv | 病灶 |
|---|---|---|---|
| P1/P2/P4 `git -C "/x y" commit/reset --hard`（引号含空格主仓路径） | **ALLOW** ✗ | BLOCK ✓ | prod gate 正则 `\S+` 盲引号 |
| P3 `git -C/repo commit`（attached） | **ALLOW** ✗ | **ALLOW** ✗（target 回落 cwd=工作区被豁免洗白） | wv walk 把 `-C/repo` 当通用旗标跳过（X1 引入面）+ prod gate 盲 attached |
| P5 `git -c \`echo /repo\` commit`（反引号动态） | **ALLOW** ✗ | **ALLOW** ✗（词面证洗白） | wv: evaluateFromModel 返回 dynamic-path 后被 proveNoWrite 词面洗白（**git 写动词不在词面写清单**——「可证无写」假证明）；prod gate 盲 |
| N2/N3 worktree 含空格/attached | ALLOW（gate 盲**偶然**放）| ALLOW ✓ | 修后须走豁免正道（gitDashCTargetsWorktree 词级化） |

词法模型实证（parseOnce）：三形态 words 全干净（引号归一/attached 单词/cmdsub evaluated=null）——**基座无罪，全在消费层**（正则 token 化 + walk 缺口 + 洗白盲点）。

## 设计取舍

1. **词级化而非再补正则**：gate 正则已修过三轮（S1 偶然命中、X1 旗标加宽、今次引号盲）——每次补一层漏一层（c107 教训的正则版）。词法层本就存在且归一引号/attached/转义，写族判定与落点解析全部改走词级（`gitWriteSubcommandHit` + `gitDashCTargetsWorktree` 词级化），**旧 GIT_WRITE_SUBCOMMAND 正则两侧退役**（同源镜像契约随共享词级真相源结构性治愈）。
2. **严格/宽词表双语义如实分立**：prod gate 严格语义（push 排除 --dry-run/-n、stash 限 push、reset 限 --hard、clean 限 f 旗标——r2-C 基线原文）≠ 求值器 isWrite 宽词表（双签终版 2026-10-12：reset/clean/stash/pull 一律写族、落点判在上层）——此前「同源」注释掩盖了这处分歧（记档说一套代码做一套同族），现两词表分立命名 + 注释互指。
3. **洗白面收窄到 P5 家族（corpus 棘轮教出的精确刀口）**：git 写族 + `dynamic-path`（git 调用自身参数动态——-c/-C 值可改写树发现，落点真不可证）不洗白；`cwd-unresolvable`/`parse-failed` 族维持词面证放行——**能力 4 既有语义 + 双签背书**（corpus 96a21f3c `pushd <wt> && git push -u origin <branch> && popd` 正面 ALLOW：pushd 不进 cd 跟踪是 Phase 1 设计内缺口，词面证是其既定兜底）。首版 wash-guard 过宽（全 reason 禁洗）被棘轮拦红——corpus 守恒闸是对的，收窄后棘轮精确复位。
4. **严格 fail-closed 面**：--git-dir/--work-tree 覆盖、动态 -c 值、~ 前缀、worktrees 根自身一律不豁免（gitDashCTargetsWorktree 词级化后语义保持）；**core.worktree/core.bare/core.gitdir 配置改写树发现是净新增**（检视獭1519 建议 4 正名：18b0577a 基线零命中——旧正则对此无任何检查）——prod 侧不豁免 + wv 侧 fail-closed（F20261016smrj 建议 3 对称）。
5. **known-gap 意外收获**：走查循环体 `i += 2; continue` 在 for 循环里被 i++ 追加推进（跳词过冲）——审查实证的低级陷阱，改 while 形态并注记「勿改 for」。

## 一审修复轮留痕（检视獭1519 request-changes + 大獭 16/10 09:46 裁决）

- **严重 1 已修（单点谓词，双层同愈）**：附着+动态混合形态（`git -c"$P" commit`/`git -C$P commit`/`git -C"$P" commit`）曾双层 fail-open（同语义空格/附着拼接反判——本 PR 自己钉的病核换个拼接就复活）——修法：gitWriteSubcommandHit 动态词位不弃权，**后续静态写族子命令前瞻判 write**；红线 `git -C"$P" status` 只读面照常放（前瞻无写族命中）；对称面：附着+动态 alias 定义（键+! 可见证）→ opaque 拦
- **建议 1 已修**：洗白禁入键从全局 reason 字符串改为 **git 段自身证据**（gitSegSelfWriteEvidence——可证主仓落点/不可证落点/树发现改写→禁洗，无 -C 且全静态→词面证语义保留），不依赖段序（前导 pushd 改 reason 不再旁落）；corpus 96a21f3c 保绿（棘轮无 GAP_DIFF）
- **建议 2 已修**：bare `git stash` ≡ `git stash push`（git-stash(1) 明文）——三侧之一的 git-readonly-whitelist 白名单注释「stash→list」是**事实错误**（branch/tag/remote/config 才是 bare=list），stash 只读面收窄为显式 list/show；附带排掉 `[] .every` vacuous-truth 坑；第四对不变量钉死
- **建议 3 已修（尽力→全收）**：wv core.worktree/bare/gitdir 树发现改写 → dynamic-path fail-closed（evalGitWrite + evalGitAdd 两同形走查同治）
- **建议 4 已修**：头注释正名（退役正则不得以活权威口气出现）+ 本取舍条 core.* 改「净新增」

## 机制识别检查点（修法决策树）

七项：新增配置/枚举/开关 ✗；状态生命周期 ✗；定时任务 ✗；信号/消息格式 ✗；持久化 ✗；持久决策分支 ✗（纯解析谓词）；跨模块调用路径 ✗（payload-extract-aux 纯函数共享=收敛非新路）。全不命中。**判定：① 既有语义内修 → Modification-Class: narrow-fix**——写族判定语义（严格词表）逐形态对齐旧正则锚原文，洗白收窄经 corpus 棘轮零缺口验证。

**每轮三问**：①旧规则变冗余——**GIT_WRITE_SUBCOMMAND 正则两侧退役**（词级真相源接管）；②正则净增——净减（退役镜像 2 条，词级判定为纯函数非正则）；③指纹表——无文案变化，不同步（说明在案）。

## 影响范围

- `payload-extract-aux.ts`：+gitWriteSubcommandHit（词级严格语义）+ GIT_WRITE_SUBS（求值器宽词表正名）+ aliasKvOfString（attached 共用）
- `bash-safety-guard.ts`：③a' gate 词级化 + gitDashCTargetsWorktree 词级化（while 形态）+ GIT_WRITE_SUBCOMMAND 退役
- `write-target-evaluator.ts`：evalGitWrite attached 值回收 + isWrite 改词表引用 + 洗白面收窄（一处条件）+ 正则锚退役
- corpus 冻结面零改动（棘轮精确复位实证）；指纹表/文案零变化

## 验证

- **失败证据固化（5a）**：修前探针输出存档（P1-P5 双层漏表）；stash 修复跑红 **7 failed | 4 passed** → 恢复 **11/11 绿**
- 回归：bash-guard-git-flag-wording 11 例（负门 6：引号双形态/attached/反引号/纯 var；放行 5：worktree 豁免引号/attached、push --dry-run 严格语义、stash push、空格一致性不变量 3 对）
- 全仓 `npx vitest run` **370 文件 5715 passed + 6 skipped**（基线 5704 + 新 11）零回归——含 guard-touchstone exam（棘轮精确复位：known-109 缺口集零增减）、guard-v2-real-replay、alias/dashc 全族
- `npx tsc --noEmit` 通过
