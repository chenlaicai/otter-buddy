---
id: F20261029gbrmv
title: 移除 bash 守卫全部机制（守卫重建清场）
summary: 按搭档指令整体移除 bash 守卫机制——文本规则引擎、sandbox-exec 沙箱 profile、git/write 授权层、文件工具结构化接防及其测试与运行时接线——为守卫重建清场；重建前 bash 执行面无守卫（搭档显式接受的过渡态）。
change_type: refactor
capability_test: "n/a: 机制整体移除（重建清场），无新增能力面；存量面由剩余全量测试覆盖（守卫族测试随主体移除，见 PR 测试改动声明）"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
causal_links:
  - F20261028gidfx
  - F20261028egitx
  - F20261027gscv
tags: [bash-guard, sandbox, removal, refactor]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/bash-sandbox.ts
  - src/frameworks/agent/git-execution-policy.ts
  - src/frameworks/agent/write-target-evaluator.ts
  - src/frameworks/agent/file-tool-guard.ts
---

## 目标与范围

搭档指令（原话）：「移除本系统所有的bash守卫！然后我要重新打造这个机制！快速！不检视！提pr！」

为守卫机制重建清场：把旧守卫的**判定、拦截、沙箱、授权**整体移除，不在旧机制上缝补。范围边界：

- **移除**：bash 命令守卫本体（规则引擎 + 沙箱 + git/write 授权 + 文件工具结构化接防）及其测试与运行时接线；
- **保留**：与守卫无判定耦合的平台面——熔断器（tool-call circuit breaker）、kill 工具族、output guard、命令词法器（command-lexer/command-model）、healing 拦截分类（guard-intercept-classify/escalation，历史 reason 分类仍可编译运行）、wait 工具本体（含 kill 族词样拒止）。

## 背景与决策

1. **为什么整体移除**：守卫规则 30+ 条（bash 30+ / git 5 / write 4，B5 调研）语义大量重复、拦截面反复误伤（6h 内拦截、变体重试等现场记录在案），搭档决定推倒重建。清场式移除让重建从零开始，不留旧规则残骸干扰新设计。
2. **过渡态风险（已向搭档显式说明并被接受）**：拆除到重建之间 bash 执行面无守卫。本变更经 PR 交付、git 可回滚（revert 单 commit 即恢复全量）。
3. **同步决策**：不检视（搭档显式指令「快速！不检视！提pr！」）——跳过对抗审视属显式决策，留痕于本 PR；commit 按 R1 全程 worktree 隔离 + PR-only。

## 移除清单

**src（守卫本体，11 个模块）**：
- `bash-safety-guard.ts`（规则引擎 checkBashCommandSafety，30+ 规则）
- `bash-sandbox.ts`（sandbox-exec profile 层 + createSandboxedTools 装配）
- `guard-model-judge.ts`（守卫内 LLM 判定）
- `git-execution-policy.ts`（git 写授权 5 规则 + envelope 解析）
- `git-readonly-whitelist.ts`（git 只读白名单，孤儿模块）
- `write-target-evaluator.ts` / `write-verdict.ts` / `write-word-face.ts`（write 判定层）
- `sleep-command-guard.ts`（bash sleep 守卫）
- `file-tool-guard.ts` / `file-write-policy.ts`（文件工具结构化接防，随 createSandboxedTools 装配点一并下线）

**运行时接线（4 处拆除 + 收口）**：
- `pi-session-factory.ts`：createSandboxedTools 装配、sandboxGuardedBySession 挂载决策链拆除（SDK 默认工具面接管）
- `model-runtime-registry.ts`：bashGuardGate（tool_call 门）移除，门链收口于 halt/loop-block
- `circuit-breaker-helpers.ts`：abortOnUnsafeBash 兜底链、recordGuardIntercept、dev-server 引导文案（appendDevServerGuidance）移除
- `tool-factory.ts`：wait 工具 until 通道的守卫检查移除（保留 kill 族词样拒止 + 元字符/引号检查）

**tests**：守卫族测试 40+ 文件随主体移除；3 个共享测试文件（allowed-service-ports / command-lexer-dq-backslash / quoted-text-sanitizer）只裁守卫集成段，保留纯模块单测；wait 工具 1 条守卫行为用例随行为移除。完整清单与方向声明见 PR「测试改动声明」。

**脚本**：`scripts/shadow-write-eval.mjs`（守卫影子评估脚本）随主体移除。

## 验证

- `tsc --noEmit` 零错；`eslint src/ tests/` 零告警。
- 全量测试（vitest --pool=threads）：与嵌套沙箱环境基线一致的环境性失败（git init EPERM / worker kill EPERM / process.chdir 不可用三类，#1696 处置记录同款）之外零失败；唯一业务面变化（wait 守卫用例）已随行为移除并声明。
- 机械闸：check-pr-tests（测试删改声明）/ lint-docs-added-fid（F20261029gbrmv 5 字母）/ commit-msg 模板——PR body 已含声明。

## 记忆片段

- 2026-10-29 搭档拍板整体移除 bash 守卫（原话「移除本系统所有的bash守卫！然后我要重新打造这个机制！」），过渡态 bash 执行面无守卫系显式接受；重建设计由搭档主导，不在旧规则上缝补。
- 守卫拆除边界：熔断/kill 族/output guard/词法器/healing 分类保留——它们是平台面不是守卫判定面；wait until 通道保留 kill 族词样拒止（until 的合法形态是状态查询）。
