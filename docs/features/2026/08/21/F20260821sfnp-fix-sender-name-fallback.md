---
id: F20260821sfnp
status: development
created_at: "2026-08-21T11:18:00+08:00"
updated_at: "2026-08-21T11:18:00+08:00"
feature_number: F20260821sfnp
title: sender name fallback 统一修复
summary: 修复 speak.intermediate/message.aborted 的 sender name fallback 策略不一致导致发言名字显示为 Otter 的反复回归 bug
change_type: fix
tags: [sse, sender-name, fallback, bugfix, regression]
modules: [agent-runtime, orchestrator, frontend]
authors: [大獭]
reviewers: []
created_in_conversation: "0d2efc85-ee7b-49aa-bd05-c114ba9fe817"
causal_links:
  - from: F20260724regd
    relation: regression_of
    note: sender name 显示问题是 F20260724regd 的反复回归
  - from: F20260819spyd
    relation: regression_of
    note: PR #325 修了 speak.intermediate 的上游注入但 fallback 未对齐
---

# F20260821sfnp: sender name fallback 统一修复

## 概述

对话《html展示优化》中 10:54 再次出现海獭发言显示为 "Otter" 而非实际名称。这是该 bug 的第 4 次回归。

三方排查（大獭 + mimo + kimi）确认根因是 **sender name 解析的 fallback 策略不一致**：5 个 SSE 事件中，`speak.intermediate` 的 fallback 是空串 `''`（会被前端 `||` 链跳过），`message.aborted` 完全没有 fallback。

## 问题分析

### 根因链

```
speak.intermediate 事件: otterName ?? '' → 前端收到 sn: ''
→ m.sn || otter?.name || 'Otter'
→ '' 是 falsy，跳过
→ otter?.name 也跳过（新獭 store 未缓存）
→ 最终显示 'Otter'
```

### 反复回归的原因

sender name 解析散落在 8+ 个代码路径中，每个路径有独立的 fallback 逻辑。修一条路径漏一条。

## 方案设计

### 最小修复（4 处改动，3 个文件）

| # | 文件 | 行 | 改动 | 作用 |
|---|------|-----|------|------|
| 1 | `agent-invoker.ts` | 379 | `otterName ?? ''` → `otterName ?? otterId` | speak.intermediate fallback 对齐其他事件 |
| 2 | `orchestrator.ts` | 597 | `otter?.name` → `otter?.name ?? otterId` | message.aborted 补齐 fallback |
| 3 | `index.tsx` | 275 | 加 `sn: serverMsg.sn \|\| m.sn` | refreshMessages 保留本地 sn |
| 4 | `index.tsx` | 880 | 加 `sn: serverMsg.sn \|\| m.sn` | stopStream 保留本地 sn |

### 设计决策

| 决策 | 理由 | 替代方案 |
|------|------|----------|
| fallback 到 `otterId` 而非空串 | UUID 至少可追溯，不会被 `\|\|` 跳过 | 空串（当前行为，导致 bug） |
| 前端保留本地 sn | SSE 事件的 sn 来源更实时（message.start 已设置），API 响应可能降级 | 不保留（当前行为，覆盖后丢失） |
| 不抽取 resolveOtterName 函数 | 4 处改动足够小，过早抽象增加复杂度 | 抽取工具函数（后续如再回归再做） |

## 行为条目

| ID | 触发条件 | 预期行为 | 来源 |
|----|---------|---------|------|
| B-1 | 海獭通过 speak 工具发言 | 前端消息气泡显示正确的海獭名称 | UA-1 |
| B-2 | 海獭发言被中止 | message.aborted 事件携带正确名称 | UA-1 |
| B-3 | 用户中止海獭发言后轮询收敛 | stopStream 不覆盖已有的正确 sn | UA-1 |

## 验收标准

| ID | 验收条件 | 验证方法 |
|----|---------|---------|
| AC-1 | speak.intermediate 事件 otterName 不为空串 | 代码审查 + 单元测试 |
| AC-2 | message.aborted 事件 otterName 有 fallback | 代码审查 |
| AC-3 | 全量测试通过 | `npx vitest run` |

## 决策记录

| 决策 | 理由 | 替代方案 | 决策模式 |
|------|------|----------|----------|
| 三方位排查而非直接修 | 问题反复回归 4 次，需要系统性分析而非补丁式修复 | 直接修不排查（容易再回归） | 技术事实，自主决策 |
| 最小修复优先 | 4 处改动足够止血，架构层面的统一抽取留后续 | 一次性抽取 resolveOtterName（改动范围更大） | 技术事实，自主决策 |
