---
id: F20260902gvrd
title: 'bash 守卫 eval 误报修复：词边界收紧为命令位置'
summary: |
  bash-safety-guard 命令级 eval 规则（L133）误报修复。原 /\beval\b/ 匹配命令中
  任何位置的独立单词 eval——路径/标识符中的 eval-xxx（连字符构成 \b 词边界，
  如 eval-activation-p0、guard-eval-fix）叠加任意 2-6 位数字（路径中的日期、
  sed 行号）即误拦纯 git/grep 命令。当日实证：mimo 的 git add、大獭的 git
  status/commit -m 多次被拦，绕行手段（改名/脚本文件/-F 传参）成本高。
  修复：eval 判定收紧为命令位置（行首或 shell 操作符/管道后的独立 eval 单词后接
  空白或引号）。字符串拼接绕过（eval "kil""l 42877"，eval 必在命令位置才执行）
  仍在覆盖面内；路径中的 eval-xxx 不再触发。PoC-9 原用例保持拦截，新增 3 个
  误报回归用例。
causal_links:
  from:
    - F20260831aksp
status: development
change_type: fix
tags: [bash-safety-guard, false-positive, eval, agent]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: "eval 词边界正则误匹配路径中的 eval-xxx（连字符是 \\b 词边界），叠加路径中的日期/行号数字即拦截纯 git 命令，当日实证多次"
  expected_effect: "eval 在命令位置（行首/操作符后）+ 数字参数才拦截；路径含 eval-xxx 的 git/sed/grep 命令放行；PoC-9 拼接绕过用例保持拦截——54/54 测试绿"
  verify_by:
    type: capability_test
---

# F20260902gvrd: bash 守卫 eval 误报修复

## 背景

当日评测机制激活 P0（F20260902gact）落地过程中，任务命名 `eval-activation-p0` 自带触发词：
- mimo 的 `git add .github/pull_request_template.md ...` 被拦（路径含 eval-activation + 文件名日期）
- 大獭的 `git status`、`commit -m`（message 引用方案文件名 eval-activation-v6.md）被拦
- 甚至修复本守卫时引用 worktree 路径 `guard-eval-fix` 再次被拦（回旋镖实证）

healing 台账 2 条 open 事件同源。绕行手段（worktree 改名、脚本文件中转、commit -F 文件传参）均有成本且不可持续。

## 根因

```ts
// 原规则
if (/\beval\b/.test(cmdLower) && /\b\d{2,6}\b/.test(command)) → 拦截
```

`\beval\b` 的词边界 `[-_ ]eval[-_ ]` 匹配一切独立出现——包括路径/分支/文件名中的
`eval-xxx`（连字符是合法词边界）。两个各不相干的子串（路径中的 eval + 日期数字）
拼出拦截。规则设计意图是防 shell eval 内建的字符串拼接绕过，但 eval 只有在
**命令位置**（会被 shell 执行的位置）才有威胁——出现在路径里时它只是字符串。

## 修复

```ts
// 收紧后：eval 必须在命令位置
const evalInCommandPosition =
  /(?:^|[;&|]\s*|\|\s*)eval\s/.test(cmdLower) ||
  /(?:^|[;&|]\s*)eval\b"/.test(cmdLower);
if (evalInCommandPosition && /\b\d{2,6}\b/.test(command)) → 拦截
```

行首 / `;` `&&` `||` `|` 操作符之后的独立 eval（后接空白或引号）= 命令位置。
`eval "kil""l 42877"` 这类拼接绕过 eval 仍在命令位置，覆盖面不缩水。

## 覆盖面核对

- 原测试 51 个全部保持绿（含 PoC-9 `eval "kil""l 42877"` 拦截、`eval "echo 42877"` 拦截）
- 新增 3 个误报回归用例：
  1. `git -C .../guard-eval-fix status` + 日期路径 → 放行
  2. sed 行号 + 变体路径 → 放行
  3. `cd /tmp && eval "echo 42877"` → 仍拦截（操作符后命令位置）

## 与 normalizeForDetection 的关系

checkBashCommandSafetyOnText 对原始与归一化文本各跑一次全量检测。归一化（塔死
`ki''ll` / `k\ill` 引号反斜杠拼接）后 eval 若被拆为 `e''val`，归一化消除空引号对后
回到 `eval` 且仍在命令位置——收紧不破坏该防线。

## 验证

- [x] `npx vitest run tests/frameworks/agent/bash-safety-guard.test.ts` → 54/54 绿
- [x] 修复 commit 的命令行本身含 guard-eval-fix 路径（live 验证：若守卫仍误报则无法提交）

## 影响范围

- 唯一文件：src/frameworks/agent/bash-safety-guard.ts（1 处正则 + 注释）
- 测试：3 个新用例
- 行为变化：路径含 eval-xxx 的命令从「拦截」变「放行」；命令位置 eval 行为不变
