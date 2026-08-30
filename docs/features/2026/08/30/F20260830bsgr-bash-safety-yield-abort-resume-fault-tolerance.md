---
id: F20260830bsgr
title: 8/30 三处修复：bash安全守卫 + failed消息abort + resume容错
date: 2026-08-30
status: development
summary: 防止LLM通过bash直接kill主进程、消息failed后强制abort SDK session、resume消费每conversation独立容错+429退避重试
created_in_conversation: a359984d-6069-41ca-bfc9-cd08fc44b53e
capability_test: "n/a: 纯 A 类改动，安全守卫和状态机修复不涉及 LLM 行为"
---

# F20260830bsgr: 8/30 双 Bug 三处修复（含 R2 对抗审视修正）

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
- 主进程 PID 从 `.otter-buddy.pid` 实时读取（每次检查都读文件，不缓存，支持热重启换 PID）
- 检测到危险命令时 `session.abort()` 阻断执行

**设计决策（R2 对抗审视修正）**：
- 翻转策略（F20260830fabt-r2）：字面量黑名单必输，LLM 可用变量/$()/反引号/xargs/eval/base64 绕过
- 非字面量 kill 目标（变量/`$()`/反引号/xargs 管道）→ 保守拦截
- kill 字面量 PID → 放行，除非等于主进程 PID
- pkill/killall + node/main.js/otter/dist 类模式 → 拦截
- 命令中出现 `.otter-buddy.pid` 引用 + kill 族 → 跨段拦截
- 全命令级高危模式：eval+数字参数、管道到 shell、脚本语言 one-liner → 拦截
- PID 每次检查现读，不缓存（R2 严重3）
- 文档如实写：这是纵深防御的一层，不是绝对防线（base64 编码等超出文本分析能力）
- 检视獭的10 个绕过 PoC（9 个拦截+1 个已知局限）全部转为回归测试

### P0-2: Failed 消息必 Abort（F20260830fabt）

**问题**：消息被标 failed 后 SDK session 未中止，LLM 在 dead message 上继续运行 3 分钟。

**修复**：
- 修改 `src/interface-adapters/agent-runtime/agent-invoker.ts`：`failMessage` 回调中增加 `agentInvoke.abort()` 调用
- 消息标 failed 后立即 abort SDK session，阻止 LLM 在 dead message 上继续运行
- 不走 `driver.abort()` 以免触发 `userAbortedMessages` 标记（那是用户中断的语义）

**修复（R2 对抗审视修正）**：
- R2 严重1（F20260830fabt-r2）：`_executeWithSession` 的 finally 块先于 orchestrator 收到 error 执行，
  session 从 activeSessions 删除后 abort 查表落空（no-op）
- 修法：在 pi-session-factory 新增 `pendingAborts` Map，invoke 前存入 session.abort() 闭包，
  finally 块删除后 abort 仍可通过闭包调用已 dispose 的 session
- `piSessionFactory.abort()` 优先查 activeSessions（session 仍活跃），
  找不到时查 pendingAborts（session 已 dispose 但闭包仍可调用）

**设计决策**：
- abort 通过 `this.agentInvoke.abort()` 直接调用，不经过 `driver.abort()` 的 user-aborted 追踪
- 确保所有 failMessage 路径（auto-retry、yield-retry、degenerate-retry、circuit-break）都自动 abort
- pendingAborts 在 finally 块中同步清理，防止内存泄漏

### P1: Resume 容错（F20260830rfto）

**问题**：resume 消费遇到 429 rate limit 后中断，部分消息既未成功也未标记 exhausted，永久停留在 pending 状态。

**修复（R2 对抗审视修正）**：
- 修改 `src/usecases/conversation/resume-interrupted-service.ts`：
  - 每个 conversation 独立 try/catch，一条失败不阻塞其余
  - sendSystem 失败不阻塞 resume 消费（恢复可以没有系统提示）
  - 429/限流类错误指数退避重试（最多 3 次，基础延迟 5s）
  - 所有异常路径确保 `updateResumeStatus` 被调用，不允许永久 pending
- R2 建议1（F20260830rfto-r2）：`resumeOne` 内层 catch 原本吞掉所有错误（含 429），
  导致 `resumeOneWithRetry` 的 429 退避永远等不到错误——死代码。
  修复：429/限流错误从内层 catch 向上传播，由 `resumeOneWithRetry` 退避重试；
  非限流错误仍在内层标记 exhausted（不可重试的失败快速闭环）。
  同时使退避基础延迟可配置（测试注入小值避免35s+超时）

**设计决策**：
- 429 重试在 `resumeOneWithRetry` 层包装，不影响 `resumeOne` 内部逻辑
- 非限流错误直接抛出，由外层 catch 兜底标记 exhausted
- `updateResumeStatus` 本身失败时记录日志但不阻塞后续处理

## 变更文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/frameworks/agent/bash-safety-guard.ts` | 新增→重写 | bash 命令安全守卫（v2 对抗设计：保守拦截 + 10 PoC 回归） |
| `src/frameworks/agent/circuit-breaker-helpers.ts` | 修改 | 集成 bash 安全守卫 + PID 实时读取（去除缓存） |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | pendingAborts map 解决 abort no-op + projectRoot 传递 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | failMessage 回调增加 abort |
| `src/usecases/conversation/resume-interrupted-service.ts` | 修改 | resume 容错增强 + 429 传播 + 退避延迟可配置 |
| `tests/frameworks/agent/bash-safety-guard.test.ts` | 新增→重写 | bash 安全守卫测试（39 用例含10 PoC 回归） |
| `tests/usecases/conversation/resume-interrupted-service.test.ts` | 修改 | resume 容错测试（+3 用例含 429 传播） |

## 验证

- 全量测试：2254 passed（0 failed）
- 新增测试：39 用例（bash-safety-guard 39 含 10 PoC 回归 + resume 429 传播）
- 已过最简检查：bash 安全守卫复用现有 circuit-breaker 钩子，无额外依赖

## 关联前案

- #474（8/26）：石砧熔断重启后 yield 回大獭被链引擎吞掉
- #574：开发獭-574 交接摘要自述在修「yield 静默失败——第三次断」
- F20260717d4ab：invocation abort mechanism（参考但未直接复用）
- F20260826rsme：服务重启自动恢复（resume-interrupted-service 原始实现）
