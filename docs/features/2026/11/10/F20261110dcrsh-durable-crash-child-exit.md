---
id: F20261110dcrsh
title: durable SIGKILL 测试子进程早退诊断
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 测试夹具进程等待与构建前置校验，无 LLM 参与行为"
intent:
  problem: "durable-runtime SIGKILL 用例在缺少 dist 时因子进程立即退出且 exit 监听注册过晚，稳定拖满 20 秒超时且无根因输出"
  expected_effect: "缺少构建产物立即提示 npm run build；运行中子进程早退立即抛出 exit code/signal 与 stderr；已构建环境仍完成真实 SIGKILL 恢复验证"
  verify_by:
    type: behavior_check
causal_links:
  - F20261109pidrx
summary: 修复 durable crash fixture 的构建产物前置检查和子进程 exit 竞态，保留真实进程崩溃恢复与 unsafe 工具不重放断言。
---

# durable SIGKILL 测试子进程早退诊断

## 问题

#1822 报告 `reopens after a real process SIGKILL without replaying the unsafe tool` 在 origin/main 单跑稳定超时。#1816/#1817 的 diff 不涉及 agent/durable 路径，不能仅凭提交相邻关系归因。

本地复现确认：干净 worktree 未构建时，`tests/fixtures/durable-crash-child.mjs` 导入的 `dist/src/frameworks/agent/durable-session.js` 不存在，子进程立即以 `ERR_MODULE_NOT_FOUND` 退出。父进程等待 marker 四秒后才注册 `exit` 监听，事件已经发生，因而继续挂到 Vitest 20 秒超时。

## 修复契约

- 启动子进程前检查其真实 Node fixture 需要的 `dist` 入口；缺失时明确提示先执行 `npm run build`，与 capability 集成测试的构建前置约定一致。
- 子进程 stderr 必须保留用于失败诊断，不再 `stdio: ignore` 吞掉模块加载错误。
- `exit` Promise 在 spawn 后立即创建，marker 等待期间同时检查进程状态；未等到 marker 时立即报告 code/signal/stderr，不拖满测试超时。
- 已构建环境仍杀真实 Node 进程，并从磁盘重开 durable store；unsafe 工具只执行一次的既有断言不弱化。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 无 dist，单跑用例 | 27ms 报告构建前置，不发生 20 秒超时 | ✅ |
| 子进程启动失败 | 140ms 报告 code=1、signal=null 与 ERR_MODULE_NOT_FOUND stderr | ✅ |
| 已构建，真实 SIGKILL | 重开成功且 calls 仅一行，目标用例约 0.97 秒通过 | ✅ |
| durable-runtime 全套 | 18/18 通过 | ✅ |

## 验证记录

- 修复前：干净 worktree 单跑稳定 20 秒超时；独立运行 child 抓到 `ERR_MODULE_NOT_FOUND`。
- 对照：同一基线执行 `npm run build` 后，用例约 1.05 秒通过，证明 durable 恢复生产逻辑未回归。
- 无 dist 负路径：暂时移走构建目录后单跑，27ms 内给出 `npm run build` 前置提示，无 Vitest timeout。
- 子进程早退负路径：临时将 fixture 的 runtime import 改为不存在模块，140ms 内报告 `code=1 signal=null` 和完整 `ERR_MODULE_NOT_FOUND` stderr；探针后 fixture 已恢复，最终 diff 不含该改动。
- 正路径：`durable-runtime.test.ts` **18/18** 通过；`npx tsc --noEmit`、目标 ESLint、`lint:docs`、`lint:intent`、`lint:tests`、`git diff --check` 全绿。intent 仅存量 warning。

## 独立审查

检视獭-1822 独立检视代码修复**通过**，无严重/一般发现：exit 监听无 await 前竞态，失败分支清理并回收子进程，原 SIGKILL 恢复与 calls=1 断言未弱化，前置检查只读且无新增悬挂句柄。独立复验目标用例、durable-runtime 18/18、ESLint 与 tsc 全绿。

流程闸首轮因 PR body 缺「测试改动声明」打回，第二轮补「证据分层声明」；最终 body 已本地通过 `check-pr-tests` 与 `check-pr-evidence`。GitHub CI run `42795380919` 的 check、e2e、golden-selftest、guard-macos 四项全绿。
