---
id: F20260806dgrf
title: degenerate-retry-and-bge-m3-fix
doc_type: feature

summary: |
  修复对话频繁中断的双根因：degenerate_output 梯度介入是死代码（catch 路径直接走终态），
  worktree 中 bge-m3 模型重复下载导致 pre-commit 超时。

causal_links:
  from:
    - F20260805f146
    - F20260804dglp

status: development
change_type: fix
tags: [output-guard, degenerate, retry, bge-m3, worktree]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - scripts/download-bge-m3.mjs
---

# F20260806dgrf: degenerate_output 重试修复 + bge-m3 worktree 复用

## 背景

用户报告大量出现 `[系统保护] 检测到输出内容异常重复，已自动中断。` 和 `[系统保护] 单次工具调用超时，已自动中断。`。

排查日志：27 次 degenerate_output（14 个 otter），7 次 per-event timeout。多个对话出现"中断→用户发'继续'→又中断"的死循环。

## 根因分析

### 根因 1：degenerate_output 梯度介入从未生效

F20260805f146 实现的重试逻辑在 `_handlePostInvocation` → `_handleGuardAbortOrSpeakRetry` 中，但该路径仅在 `session.prompt()` 正常返回时执行。

实际流程：OutputGuard 触发 → `session.abort()` → `session.prompt()` 抛异常 → catch 块走 `wrapInternalAbort` + `handleInvokeError` 终态 → 直接返回。

`_handlePostInvocation` 中的 degenerate 重试逻辑是**死代码**（日志中 `Degenerate output retry triggered` = 0 条）。

### 根因 2：worktree 中 bge-m3 重复下载

`.githooks/pre-commit` 跑 `npm run check` → `npm run build` → `download-bge-m3.mjs`。

脚本用 `process.cwd()` 定位模型目录，worktree 中 cwd 是 worktree 路径。`models/` 在 `.gitignore` 中，worktree 的 models 目录为空，每次都要重新下载 2.1GB。

hf-mirror 阻断或下载不完整时，pre-commit 挂死超过 `maxPerEventTimeMs`（10 分钟）→ 触发 per-event timeout。

### 因果叠加

timeout 中断 → 用户发"继续" → 模型上下文堆积中断消息和"继续" → 加剧退化倾向 → 反复中断。

## 修复

### Part 1：degenerate_output 重试（catch 路径拦截）

在 `invokeConversation` 的 catch 块中，`wrapInternalAbort` 之前拦截 `degenerate_output`：

```typescript
const abortReason = err._guardAbortReason ?? getInternalAbortReason(messageId);
if (abortReason === "degenerate_output" && retryCount === 0) {
  return handleDegenerateRetry(...);
}
```

`wrapInternalAbort` 会消费 `guardAbortReason` 并加入 `abortedMessages`，故必须在调用前判断。

### Part 2：bge-m3 worktree 复用

`download-bge-m3.mjs` 新增 `resolveModelDir()`：通过 `git rev-parse --git-common-dir` 找到主仓 `.git` 路径，推导主仓根目录。主仓 models 目录存在时直接复用，跳过下载。

## 验证

- 新增 1 个测试：catch 路径 degenerate_output 走重试而非终态
- 全量 960 测试通过
- `npx tsc --noEmit` 编译通过
- worktree 中 `node scripts/download-bge-m3.mjs` 输出"复用主仓模型"
