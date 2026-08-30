---
id: F20260830bsgr
title: 8/30 三处修复：bash安全守卫 + failed消息abort + resume容错
date: 2026-08-30
status: development
summary: 防止LLM通过bash直接kill主进程、消息failed后强制abort SDK session、resume消费每conversation独立容错+429退避重试
created_in_conversation: a359984d-6069-41ca-bfc9-cd08fc44b53e
capability_test: "n/a: 纯 A 类改动，安全守卫和状态机修复不涉及 LLM 行为"
---

# F20260830bsgr: 8/30 双 Bug 三处修复

## 背景

8/30 发生主进程被 SIGTERM 杀死（13:04:28）+ yield 后目标獭不被唤醒、对话卡「处理中」。

根因链：
```
【根因】yield 状态机缺陷：消息被标 failed 后 SDK session 没 abort
   ↓ LLM 在 dead message 上继续跑了 3 分钟（91 次 toolcall）
【级联1】跑到 seq=91 时执行 bash 命令直接 kill 42877 杀了主进程
【级联2】16:00 重启后 resume 队列启动但消费遇 429 中断，4 条 pending 永久卡住
```

排查报告：`data/workspaces/a359984d-6069-41ca-bfc9-cd08fc44b53e/mimo-rootcause-0830.md`

## 修复

### P0-1: Bash 安全守卫（F20260830bsgr）

**问题**：LLM 通过 bash 工具直接执行 `kill <主进程PID>` 命令，无安全守卫拦截。

**修复**：
- 新增 `src/frameworks/agent/bash-safety-guard.ts`：解析 bash 命令中的 kill 类操作，检查目标 PID 是否是主进程
- 集成到 `src/frameworks/agent/circuit-breaker-helpers.ts` 的 `attachCircuitBreaker`：在 `tool_execution_start` 事件中拦截，早于工具实际执行
- 主进程 PID 从 `.otter-buddy.pid` 实时读取（懒加载，首次检查时读取）
- 检测到危险命令时 `session.abort()` 阻断执行

**设计决策**：
- 只拦截明确针对主进程的 kill 类命令（精确匹配，不误伤）
- 允许 kill 无关进程（如 ffmpeg、test 子进程等）
- 允许 otter-buddy.sh restart（通过脚本管理，有安全兜底）

### P0-2: Failed 消息必 Abort（F20260830fabt）

**问题**：消息被标 failed 后 SDK session 未中止，LLM 在 dead message 上继续运行 3 分钟。

**修复**：
- 修改 `src/interface-adapters/agent-runtime/agent-invoker.ts`：`failMessage` 回调中增加 `agentInvoke.abort()` 调用
- 消息标 failed 后立即 abort SDK session，阻止 LLM 在 dead message 上继续运行
- 不走 `driver.abort()` 以免触发 `userAbortedMessages` 标记（那是用户中断的语义）

**设计决策**：
- abort 通过 `this.agentInvoke.abort()` 直接调用，不经过 `driver.abort()` 的 user-aborted 追踪
- 确保所有 failMessage 路径（auto-retry、yield-retry、degenerate-retry、circuit-break）都自动 abort

### P1: Resume 容错（F20260830rfto）

**问题**：resume 消费遇到 429 rate limit 后中断，部分消息既未成功也未标记 exhausted，永久停留在 pending 状态。

**修复**：
- 修改 `src/usecases/conversation/resume-interrupted-service.ts`：
  - 每个 conversation 独立 try/catch，一条失败不阻塞其余
  - sendSystem 失败不阻塞 resume 消费（恢复可以没有系统提示）
  - 429/限流类错误指数退避重试（最多 3 次，基础延迟 5s）
  - 所有异常路径确保 `updateResumeStatus` 被调用，不允许永久 pending

**设计决策**：
- 429 重试在 `resumeOneWithRetry` 层包装，不影响 `resumeOne` 内部逻辑
- 非限流错误直接抛出，由外层 catch 兜底标记 exhausted
- `updateResumeStatus` 本身失败时记录日志但不阻塞后续处理

## 变更文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/frameworks/agent/bash-safety-guard.ts` | 新增 | bash 命令安全守卫核心逻辑 |
| `src/frameworks/agent/circuit-breaker-helpers.ts` | 修改 | 集成 bash 安全守卫到 tool_execution_start 钩子 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | 传递 projectRoot 给 attachGuards |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | failMessage 回调增加 abort |
| `src/usecases/conversation/resume-interrupted-service.ts` | 修改 | resume 消费容错增强 |
| `tests/frameworks/agent/bash-safety-guard.test.ts` | 新增 | bash 安全守卫测试（23 用例） |
| `tests/usecases/conversation/resume-interrupted-service.test.ts` | 修改 | resume 容错测试（+2 用例） |

## 验证

- 全量测试：2237 passed（0 failed）
- 新增测试：25 用例（bash-safety-guard 23 + resume-fault-tolerance 2）
- 已过最简检查：bash 安全守卫复用现有 circuit-breaker 钩子，无额外依赖

## 关联前案

- #474（8/26）：石砧熔断重启后 yield 回大獭被链引擎吞掉
- #574：开发獭-574 交接摘要自述在修「yield 静默失败——第三次断」
- F20260717d4ab：invocation abort mechanism（参考但未直接复用）
- F20260826rsme：服务重启自动恢复（resume-interrupted-service 原始实现）
