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

- [x] `npx vitest run tests/frameworks/agent/bash-safety-guard.test.ts` → 57/57 绿
- [x] 修复 commit 的命令行本身含 guard-eval-fix 路径（live 验证：若守卫仍误报则无法提交）

## #730 拦截回显增强（chen 追加：修守卫应修完整体验）

mimo 审视建议 1 当日升级进本 PR：拦截文案从静态说明 → 附加【命中详情】块（规则名 × 片段 × 位置偏移），被拦的獭能自诊断。

实现：`locateTriggerContext()` 扫描四类高危词表（kill 族 / eval / PID 文件 / 进程名），命中片段带前后 10 字符上下文 + offset；`withDiagnostics()` 挂到两条拦截出口（原始文本 + 归一化文本，归一化路径扫归一化后文本——e""val 拆开的原文字面扫不到）。

**PID 脱敏铁律兼容（F20260831aksp）**：片段中的主进程 PID 替换为 `<main-pid>` 占位符——既有测试「拦截文案不含 42877」继续成立，防「试探→回显→二次打击」链不被诊断功能重新打开。

#731（拦截后自动回发控制信号恢复行动权）不在本 PR：那是 agent 编排层变更（拦截点在 agent 运行时，非守卫函数本身），单开 PR 做。

## 影响范围

- src/frameworks/agent/bash-safety-guard.ts：L133 正则收紧 + locateTriggerContext/withDiagnostics 两个纯函数 + 两处拦截出口挂接
- tests：6 个新用例（3 误报回归 + 2 回显 + 1 脱敏断言）
- 行为变化：路径含 eval-xxx 的命令从「拦」变「放」；命令位置 eval 不变；拦截文案末尾多【命中详情】块（含 PID 脱敏）
