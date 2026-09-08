---
id: F20260908bsg7
title: "bash 守卫位置感知白名单语义反转：数据位置词元不再误拦（closes #777）"
summary: "#760 的 isKillAtCommandPosition default 分支 return true 与位置感知目标语义相反——一切非白名单前导字符（/ 引号 空格 中文 数字）都误判命令位置，9/3-9/4 四组误拦实证。反转：默认 continue（数据位置放行），白名单显式化（段首/操作符后/$(/反引号/子shell）+ 命令前缀词循环剥除（sudo/env/xargs/timeout/赋值）+ 分段含管道 |（前缀词判定依赖段首上下文）+ bash -c 内嵌 pkill 词元按 pkill 语义 + PID 参数剥括号。"
change_type: fix
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 303b94d4-b3ad-4de4-9ee4-2b54da95f9a2
tags: [bash-guard, security, false-positive, daily-review]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
created_at: 2026-09-08
---

# bash 守卫位置感知白名单语义反转（closes #777）

## 背景

#760（位置感知 v1）合入后误拦持续：9/3 三组 + 9/4 健康检查 firsthand 一组，全部是「字符串字面量/路径恰好含词元」。根因是 `isKillAtCommandPosition` 的 default 分支 `return true`——豁免清单只覆盖 `{字母, -}`，其余一切前导字符都判命令位置，与「位置感知 = 默认非命令位置、显式白名单才拦」的目标语义相反。

本特性开发过程两次被守卫拦截自己的调试命令（healing 回发 3 次）——#777 误拦的活体实证。

## 修复（四处联动）

1. **白名单语义反转**（核心）：`isKillAtCommandPosition` default 改 `continue`（数据位置放行）。白名单：段首 pos 0、shell 操作符后（`|;&\n\r\f`）、`(` 子 shell、`` ` `` 反引号内。
2. **命令前缀词循环剥除**：`stripCommandPrefixes`——sudo/env/nohup/timeout/xargs/nice/command/watch/exec/time/do + 参数（`-n1`/`-I{}`/时长/赋值）循环剥除，词元前文本剥空即命令位置。覆盖 #698 攻击链 wrapper 变体。
3. **分段含管道 `|`**：#760 不含 `|` 的理由（间接向量整体拦截）在白名单语义下变成漏拦——`cat x | xargs -n1 kill 42877` 的 xargs 前缀判定依赖段首上下文，管道右段被吞进左段剥除失败。`|` 右段首恒为命令位置（shell 语义），分段代价为零。
4. **bash -c 内嵌 pkill/killall 词元按 pkill 语义**：`bash -c 'pkill -f otter-buddy'` 的 KILL 匹配走 kill 语义解析不到字面量 PID 会漏拦——检测 bash -c 分支内嵌 pkill 族词元时 isPkill=true（检查目标进程名）。
5. **extractLiteralPids 剥括号**：`(kill 42877)` 子 shell 形态的 PID 带右括号尾，parseInt 前剥除。

## 回归防护

- 既有 76 用例全绿（含 #698 攻击链回归全套：wrapper/赋值/bash -c/xargs 参数/路径变体）
- 新增 7 条：#777 四组事故案例（路径/heredoc/title 字符串/检索词）+ 中文语境 + 段首真拦截 + 子 shell
- 一处既有用例语义修正：「管道到 shell 拦截含误拦退出引导」原用例（`grep -q kill && bash -c`）恰是本 issue 修的词元误拦型，改为真管道到 shell 攻击形态（`curl | bash`）

## 验证

- 83/83 全绿，tsc 0 error，eslint 0 error
- 独立复现脚本（工作区 dbg 系列）逐环定位管线行为
- 最简检查：纯函数内反转 + 分段字符集扩展，零新依赖

## Discovered Issues

无。
