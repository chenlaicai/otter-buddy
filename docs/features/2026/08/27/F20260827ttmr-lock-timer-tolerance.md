---
id: F20260827ttmr
title: simple-lock-manager 计时断言加 5ms 容差，消除 CI 计时 flake（#481）
doc_type: feature
summary: |
  simple-lock-manager 超时计时断言加 5ms 容差，消除 CI 计时 flake。
  #512 连续两轮 CI 失败根因：waitedMs >= 60 断言在 CI 高负载下因 Node 计时器
  早触发（实测 59ms）挂掉，与被测 PR 改动无关。下界放宽 5ms，超时行为
  本身由 rejects.toThrow 覆盖，语义不变。
change_type: fix
created_in_conversation: e407eda2-1c7b-4e84-b544-f33220febd5f
tags: [test-stability, ci-flake, timing]
---

# 背景

#512（#501 token 化，纯 web 改动）合入前 CI 连续两次失败，失败用例是后端锁测试 `tests/frameworks/agent/simple-lock-manager.test.ts:232`：

```
AssertionError: expected 59 to be greater than or equal to 60
```

同用例此前也在 #511 的首轮 CI 挂过一次（当时重跑后绿）。

# 根因分析

1. 生产代码 `SimpleLockManager.acquire`（`src/frameworks/agent/session-helpers.ts:111-148`）用 `Date.now()` 记 `waitStartedAt`，超时回调里 `waitedMs = now - waitStartedAt`
2. Node 定时器精度受事件循环负载影响，`setTimeout(…, 60)` 在 CI 高负载下可能 59ms 即触发（Date.now 毫秒截断 + 调度抖动）
3. 断言 `waitedMs >= 60` 是零容差精确边界断言，负载下必然偶发失败
4. 该测试与被合 PR 的改动无关联（纯 web vs 后端锁），属于"挡路测试"

# 修复方案

测试断言加容差，不改生产代码：

```ts
// 修复前
expect(context.waitedMs).toBeGreaterThanOrEqual(60);
// 修复后
expect(context.waitedMs).toBeGreaterThanOrEqual(55); // 5ms 容差
```

`holderHeldForMs >= 30` 同理放宽到 `>= 25`（同一根因）。语义保持：超时路径与日志结构由 `rejects.toThrow` + `toMatchObject` 覆盖，计时断言只验证量级。

# 影响范围

单测试文件 2 处断言。无生产代码改动。

# 验证

单文件连跑 5 遍全绿（12/12 × 5）。
