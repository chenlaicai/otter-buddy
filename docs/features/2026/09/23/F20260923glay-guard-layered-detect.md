---
id: F20260923glay
title: bash 守卫分层判定与提示瘦身：脚本 one-liner 载荷字符串剥离 + 命中详情去重
doc_type: feature
change_type: fix
created: 2026-09-23
created_in_conversation: fcb57dbe-22c5-4286-9239-7261fbc369fe
modules:
  - src/frameworks/agent/quoted-text-sanitizer.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - tests/frameworks/agent/bash-guard-layered-detect.test.ts
summary: "9/23 守卫机制完整诊断（搭档要求）：666 行守卫含 53 处事故补丁锚点，今日 BLOCKED 93 次中疑似误拦 51 次（55%），历史 guard_intercept 台账 270 条——补丁摞补丁恶性循环。根因：stripQuotedTextSpans 的 SHELL_PAYLOAD_CHANNEL 把脚本 one-liner（python3 -c/node -e）与 shell 载荷（bash -c）一刀切同待，前者载荷内字符串字面量是数据（含 > | & 文本）被暴露给重定向判定误拦。Part A 分层：脚本 one-liner 载荷照常剥离（kill 检测看原文不受影响，且补 node -e 进脚本 kill 检测防绕过），shell 载荷仍整体保留原文。Part B 提示瘦身：命中详情同类合并计数（路径类命中一拦 5-6 段长路径刷屏），retry 引导从 200 字长文压为一句（原因透传保留）。"
tags: [bash-safety-guard, false-positive, layered-detection, usability]
capability_test: "n/a: narrow-fix 收窄既有守卫误拦面，回归用例固化于 tests/frameworks/agent/bash-guard-layered-detect.test.ts（10 例含安全面）"
causal_links:
  from:
    - F20260923qbsw
    - F20260923hsyn
---

# F20260923glay：bash 守卫分层判定与提示瘦身

## 背景：守卫机制完整诊断（9/23 搭档要求）

**数据**：守卫 666 行 + 脱敏器 166 行，代码内 53 处事故/特性锚点注释（每处都是一次被绕过/误拦的补丁史）。9/23 当日 BLOCKED 93 次中疑似误拦 51 次（55%）；healing 台账 guard_intercept 累计 270 条（8/31 至今）。

**架构性根因（三个互相咬的设计）**：

1. **文本正则而非语义解析**：引号内数据 vs 引号外语法全靠正则猜，猜错一次加一个补丁正则，正则间再互相干扰
2. **危险通道清单一刀切**：`SHELL_PAYLOAD_CHANNEL` 命中即整体放弃剥离——脚本 one-liner（python3 -c/node -e）与 shell 载荷（bash -c）同待。但两者语义不同：shell 载荷引号内是 shell 代码（剥离会瞎 kill 检测），脚本载荷是 python/node 代码、其中**字符串字面量是数据**（kill 调用词元在调用位不在字符串里）
3. **失败代价放大器**：误拦 → abort 整个 invoke + 500 字提示刷屏 + 自动重试 3 次重复刷屏

## Part A：判定基准分层

**改动**（quoted-text-sanitizer.ts）：
- 新增 `SCRIPT_ONELINER_CHANNEL`（python/perl/ruby -c|-e、node -e）
- `stripQuotedTextSpans`：shell 载荷（bash -c/管道进 shell/heredoc）仍整体保留原文；脚本 one-liner 载荷**照常剥离**（python/node 字符串与 shell 引号同形，剥离正则直接适用）

**安全不变量**（测试守护）：
- kill 族检测始终看原文（剥离只影响重定向/主仓写判定，两基准不交叉）
- 脚本 kill 检测（bash-safety-guard.ts:298）补 node -e 覆盖——防 `node -e "process.kill(42877)"` 绕过（此前只覆盖 perl/ruby/python）
- 已知取舍：python 字符串里的 kill 字样+数字（如日志分析查 kill 关键词）仍被保守拦截（kill 检测看原文无法区分字符串内字样与真调用）——误拦可接受，绕法是写工作区脚本文件而非 one-liner

## Part B：提示瘦身

- **命中详情去重**（locateTriggerContext）：同类命中只取首条 + 计数（`（共 N 处）`）。此前路径类命中一拦列 5-6 段 30 字符长路径片段，毫无信息量
- **retry 引导压缩**（retry-policy.ts）：原因透传保留（自诊断必需），引导语从约 200 字压为一句（四要素浓缩：不允许 + 无合法场景 + worktree 正道 + 换写法）

## 验证

- 新增 `tests/frameworks/agent/bash-guard-layered-detect.test.ts` 10 例：误拦面修复 4 例（python/node one-liner 含 > | & 文本/项目路径词元/stdin 管道）+ 安全面 6 例（python/node 真 kill 仍拦、字符串内 kill 字样保守拦、bash -c 载荷不回退、heredoc patch 仍拦）
- 全量 1933 tests 全绿（agent 框架 642 + usecases 等）
- retry-policy 既有测试四要素断言同步更新（浓缩文案仍覆盖四要素）

## 影响范围

- python3 -c / node -e 内联分析脚本（载荷字符串含 > | & 文本）不再误拦——覆盖今日 55% 误拦的主要形态
- 拦截提示显著变短（命中详情合并 + retry 引导一句）
- kill 族安全面零降级（原文检测 + node -e 补覆盖）

## 已知边界

- 文本正则检测的结构性局限仍在（不解析 shell AST）——本特性收敛误拦面但不重写守卫。若未来误拦率仍高，值得评估 AST 级解析（如 tree-sitter-bash），那是独立大特性
- 拦截仍 abort invoke（放大器未拆）——拆分降级为「工具级拒绝」涉及 SDK 事件机制改造（steer 注入时机在 tool_execution_start 之后才能生效），复杂度与风险另评，本 PR 不含
- 误拦遥测闭环（结构化事件 + weekly review）未实现，记录待办
