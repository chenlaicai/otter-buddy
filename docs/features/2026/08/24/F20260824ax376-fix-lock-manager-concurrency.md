---
id: F20260824ax376
title: SimpleLockManager 并发安全修复
summary: |
  修复 SimpleLockManager 锁机制失效：旧版仅检查 waiters 队列长度判断是否有人持有锁，但第一个获取者不入队，导致后续调用者绕过等待、两个操作并发执行。数据结构改为显式跟踪 held 状态，消除 EEXIST 竞态条件。
change_type: bugfix
status: active
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# SimpleLockManager 并发安全修复

## 背景与需求

### 问题描述

issue #376：定时任务触发时 session 文件创建出现 EEXIST 竞态条件——同一文件路径出现 2 次错误，间隔 15ms。

### 根因分析

**问题不在 pi-coding-agent SDK，在 otter-buddy 的 `SimpleLockManager`。**

旧版锁实现：

```typescript
// 旧版 acquire
const queue = this.queues.get(key) ?? [];
this.queues.set(key, queue);

if (queue.length > 0) {  // ← 问题在这
  await Promise.race([...]); // 等待
}
return release;
```

第一个获取者调用 `acquire` 时队列为空，`queue.length > 0` 为 false，直接获得锁——但它没有往队列里写任何东西。第二个调用者检查同一个队列，发现还是空的，也直接获得锁。

**结果**：两个操作并发执行，pi-coding-agent SDK 的 `_persist` 方法使用 `openSync(file, "wx")`（O_CREAT | O_EXCL）创建 session 文件，第二个操作因文件已存在抛出 EEXIST。

### 竞态路径

```
Scheduler.triggerTask()
  → restartBeforeInvoke → manageSession.restartSession()
    → agentGateway.reset() → 创建新 SessionManager（flushed=false，文件未写）
  → invokeAgentWithTimeout() → agentInvoker.invokeConversation()
    → piSessionFactory.invoke() → _restoreOrCreateSession()
      → session.prompt() → _persist() → openSync(file, "wx") → EEXIST
```

两个定时任务同时触发同一个 otter 的 `restartBeforeInvoke` + `invoke`，锁失效导致并发写入。

## 方案设计

### 修复思路

将数据结构从 `Map<string, Array<() => void>>`（只有等待队列）改为 `Map<string, { held: boolean; waiters: Array<() => void> }>`（显式跟踪"持有"状态）。

核心逻辑：
- `acquire` 时：检查 `held`（非 `waiters.length`），第一个获取者标记 `held = true`
- `release` 时：有等待者则唤醒下一个（保持 `held = true`），无等待者则 `held = false` 并清理

### 额外加固

1. **timeout 后清理 stale entry**：超时回调中从 waiters 数组移除对应的 resolve 函数，防止超时后被意外唤醒
2. **double release 防护**：新增 `released` 标志，第二次调用 release 无操作

## 实现细节

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/agent/session-helpers.ts` | 修改 | `SimpleLockManager` 类重构 |
| `tests/frameworks/agent/simple-lock-manager.test.ts` | 新建 | 7+2 个测试用例 |

### 关键代码变更

```typescript
// 新版 acquire
let lock = this.locks.get(key);
if (!lock) {
  lock = { held: false, waiters: [] };
  this.locks.set(key, lock);
}

if (lock.held) {  // ← 显式检查持有状态
  let waiterResolve: (() => void) | undefined;
  await Promise.race([
    new Promise<void>(resolve => {
      waiterResolve = resolve;
      lock.waiters.push(resolve);
    }),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        // timeout 后清理 stale entry
        if (waiterResolve) {
          const idx = lock.waiters.indexOf(waiterResolve);
          if (idx !== -1) lock.waiters.splice(idx, 1);
        }
        reject(new Error(`Lock acquire timeout for key: ${key}`));
      }, timeout)
    ),
  ]);
}

lock.held = true;
```

## 验收标准

### 测试覆盖

| 测试 | 场景 | 验证点 |
|------|------|--------|
| 并发互斥 | 两个操作竞争同一 key | 执行顺序严格串行 |
| 顺序访问 | 释放后立即获取 | 无阻塞 |
| 不同 key 并发 | 两个操作使用不同 key | 可以并发 |
| 超时 | 锁持有者不释放 | 等待者超时抛错 |
| double release | 同一 release 调用两次 | 不报错、不影响后续获取 |
| 队列唤醒 | 3 个等待者 FIFO | 严格 FIFO 顺序 |
| destroy 清理 | destroy 后等待者被唤醒 | 不挂起 |
| destroy 后 late release | destroy 在持有者释放前调用 | 不 crash |
| timeout 后新获取 | waiter 超时 → holder 释放 → 新获取 | 正常获取锁 |

## 影响范围

- 影响模块：agent-runtime（`PiSessionFactory` 的并发控制）
- 影响文件：1 个（`session-helpers.ts`）
- 使用者：仅 `PiSessionFactory`（`invoke` 和 `reset` 方法）
- 破坏性变更：无（接口不变，仅内部实现）

## 设计决策

| 问题 | 决策 | 理由 |
|------|------|------|
| 锁状态存储 | `{ held, waiters }` 对象 | 比纯数组更清晰表达语义 |
| release 转移 | 保持 `held=true` 唤醒下一个 | 避免经过 unheld 状态的竞态窗口 |
| double release | `released` 标志防护 | 调用方可能在 finally 中多次调用 |
| timeout 清理 | splice 移除 stale entry | 防止超时后 resolve 被意外唤醒 |

## 参考

- issue: #376
- PR: #383
- 根因文档：session-reuse-fix 特性文档「并发安全方案」章节
