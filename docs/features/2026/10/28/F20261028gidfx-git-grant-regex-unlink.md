---
id: F20261028gidfx
title: Git 授权窄写域 regex 形态与 worktree 目标解析修复
summary: 修复两个授权缺陷——窄写域路径形态 allow 在删除类操作上被通用 .git regex deny 压住（worktree remove 必死），以及 worktree 目标按宿主进程 cwd 而非 -C/cd 目录解析（常用命令形态直接丢授权）。
change_type: fix
capability_test: "n/a: SBPL 语义由判别实验锁定（sbx-lab3：regex-deny 后 regex-allow 创建/删除双通）；策略行为由 git-sandbox-policy 48 项单测覆盖，真实沙箱面由 CI git-sandbox-integration 覆盖"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
causal_links:
  - F20261028egitx
  - F20261027gscv
tags: [bash-guard, git, sandbox, sbpl, bugfix]
modules: [src/frameworks/agent/git-execution-policy.ts]
---

## 目标

修复 F20261028egitx（#1685）合入后实测暴露的两个授权面缺陷，恢复 agent 侧 git 管理写的正道能力：

1. **删除面误拒**：授权窄写域（`grantToProfileRules`）用 `subpath`/`literal` 路径形态 allow，位于通用 `.git` regex deny 之后——实测 SBPL 语义对**创建类操作**后写 allow 赢（worktree add 成功），对**删除类操作（unlink/rmdir）regex deny 赢**（worktree remove 双双 EPERM）。`git worktree remove` 因此在生产必死。
2. **相对路径解析错位**：`parseWorktreeTarget`/`evaluateWorktreeWrite` 用 bash 工具进程 cwd 解析相对目标，而 git 语义是按 `-C`/`cd` 目标目录解析——`git -C <repo> worktree add .otter/worktrees/x` 等常用形态拿不到授权，落到默认 deny。

## 非目标

不改 envelope 识别面（单段 `git -C` / 字面 `cd && git`）、不动文本守卫规则族、不放开 `branch -D`（R1 破坏性清单，仍需窄受控工具另案）、不放开外部仓管理写（#1682 边界不变）。

## 根因与证据（2026-10-28 夜，会话 7b41e085）

SBPL 语义判别实验（工作区假仓 `.g1t` 同构命名，经 until 通道非嵌套 sandbox-exec 实测）：

| 规则组合 | 创建/写入 | 删除（unlink/rmdir） |
|---|---|---|
| path-deny + 后置 path-allow | allow 赢 | allow 赢 |
| regex-deny + 后置 path-allow | allow 赢 | **deny 赢（bug 面）** |
| regex-deny + 后置 regex-allow | allow 赢 | allow 赢 |

生产实证链（同会话）：绝对路径 `worktree remove --force` 拿到完整 grant（探针 `probe-policy.mjs`/`probe-hook.mjs` 打印真实 profile 确认规则齐全），但删除仍双 EPERM；同形态 `worktree add`（创建）+ 空 commit 走通（8ababa1f）；`git worktree add` 相对路径形态 `could not create directory … .git/worktrees/… EPERM`（无 grant）。主仓 `deny(subpath)` 对 unlink 生效（node unlinkSync EPERM 实证），排除「路径规则对 unlink 失效」假说。

## 设计与取舍

- **窄写域改 regex 形态**（`escapeRegexPath` 转义 + `^` 全路径锚定）：`.git/worktrees/<id>`、`objects`、`refs/heads`、`refs/remotes`、`logs`、`packed-refs(\.lock)?`、`config.lock`、`FETCH_HEAD`/`ORIG_HEAD` 与 worktree `.git` 指针一律 regex allow，压过通用 `.git` regex deny 的删除面。锚定全路径防扩大到别仓 `.git`；`escapePath` 的控制字符拒绝保留。
- **目标树/父链保持路径形态**：它们面向的是主仓 `subpath` deny（路径 vs 路径后写胜出，创建/删除双通），无需 regex。
- **目标解析按 git 语义**：`envelope.targetPath ?? cwd` 作为相对参数解析基准（`-C`/`cd` 目标目录），实测与 git 自身解析一致。
- **remove/add 旗标混排解析**：add 位置参数 `<target> [<commit-ish>]` 与受控旗标（-b/-B 带值、detach/no-checkout/force/quiet）任意混排；remove 恰好一个目标 + `-f/--force/-q/--quiet` 任意位置；未知旗标（--lock 等）与多目标仍不授权（fail-closed 不变）。
- 取舍：regex 形态比路径形态匹配面略宽（子串语义 + `^` 锚定后可控）；换来删除面可用。generic `.git` deny 对非授权 `.git`（alpha/tmp/外部指针）的覆盖不变。

## 测试

- `tests/frameworks/agent/git-sandbox-policy.test.ts` 48 项全绿：新增相对目标按 -C 解析（生产回归复刻）、remove 旗标混排、add 旗标混排、指针 regex 规则、未知旗标/多目标拒绝。
- 全量本地跑（`--pool=threads`）7153 过 / 103 挂——挂的全部是运行环境故障类别（嵌套沙箱禁 `.git` 创建/禁信号 kill、threads 池 chdir 限制、embedding 模型缺失），无一与本改动相关；真实沙箱集成测试在 CI 无沙箱环境执行。

## 回滚

单 commit 纯 `git-execution-policy.ts` + 测试改动，`git revert` 即回滚；回滚后退化回「worktree remove 死 + 相对形态无授权」的已知状态，无数据面影响。
