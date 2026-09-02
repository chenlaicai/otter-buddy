---
id: F20260901fift
title: 飞书用户信息在途请求合并（in-flight dedup）
doc_type: feature

summary: |
  修复 #490：FeishuUserInfoClient.getUserName 缓存未命中时无在途合并，短窗口
  同一 open_id 多条消息并发到达会各自独立调用飞书通讯录 API（应用级限流风险）。
  方案：Map<open_id, Promise> 存在途请求，同 id 并发共享同一 Promise，完成后
  写正结果缓存并清理在途表（finally 保证失败也清，维持"失败不缓存可重试"约定）。

causal_links:
  from:
    - F20260826fuid   # FeishuUserInfoClient 的引入方（本次在其缓存层上补并发合并）

status: implemented
change_type: feature-update
tags: [feishu, user-info, concurrency, dedup, in-flight, tech-debt]
modules: [src/frameworks/feishu/user-info-client.ts, tests/frameworks/feishu/user-info-client.test.ts]

created_at: 2026-09-01
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260901fift 飞书用户信息在途请求合并

## 背景

### 来源

issue #490（PR #488 对抗审视建议发现 1）。

### 问题

`getUserName` 原实现：缓存未命中 → 直接发 API。同一 open_id 的并发调用各自独立出网，
高频场景（短时间多条消息）可能触发飞书应用级限流。

### 风险评估（issue 原文）

低——当前长连接消息处理实际是串行（onMessage → process 逐条 await），并发窗口极窄。
本次为防御性优化，不改变串行路径行为。

## 方案

### 设计

与 `FeishuAccessTokenManager.refreshPromise` 同构的单 promise 共享模式，泛化为按
open_id 键控的 Map：

```ts
private readonly inflight = new Map<string, Promise<string | null>>();
```

`getUserName` 流程：

1. 参数防御（空 / `unknown` → null，不入任何表）
2. 缓存命中（TTL 内）→ 直接返回
3. 在途命中 → 返回已有 Promise（**同步段**完成检查+写入，fetch 出网前并发调用者即可复用，
   无竞态窗口——JS 单线程事件循环保证）
4. 未命中 → 发起 `fetchUserName`，`.finally()` 清在途表，存入 Map 后返回

关键取舍：

- **`finally` 清表而非 `then`**：失败（null / 异常）同样必须清，否则失败结果会像被缓存
  一样驻留在途表，违反"null 不缓存、可重试"的既有约定（权限开通后自动恢复的语义不变）
- **失败不缓存**：保持原设计，权限/限流/网络故障恢复后下次调用自然重试
- **不做缓存 TTL/淘汰策略重构**：只加 in-flight 合并（issue 边界）

### 原实现内联请求体提为私有方法 `fetchUserName`

纯结构移动，逻辑零变更（token 获取 → fetch → 业务码判断 → 正结果缓存 / null 降级）。

## 验证

- 新增 `tests/frameworks/feishu/user-info-client.test.ts`（6 用例，fetch 全 mock 不出网）：
  - 同 open_id 三路并发（手动闸门制造真实并发窗口）→ API 仅 1 次调用、结果共享
  - 成功后写缓存 → 后续同 id 调用不出网
  - API 业务失败 → 并发共享同一 null；之后在途已清、重新发起（可重试）
  - 网络异常 → 并发共享同一 null 降级；之后可重试
  - 不同 open_id 并发 → 各发一次、不互相合并
  - 空 id / unknown → 直接 null 不出网
- API 调用次数用 fetch mock 的副作用计数器断言（仓规禁 `toHaveBeenCalledTimes`，
  行为式断言与 testing-rules 精神一致）
- 全量 vitest：209 files / 2603 tests 全绿；`tsc --noEmit` 零错误；eslint 零告警
- **最简实现检查**：已过——单 Map + 4 行编排复用同仓已验证模式（refreshPromise 同构），
  无新增依赖/文件/抽象层
- pre-existing 失败：无（全量全绿，无需基线对照）

## Discovered Issues

无——变更范围内未发现其他问题。
