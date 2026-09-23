---
id: F20260923icus
title: invoke token usage 补齐 cacheRead/cacheWrite 落库
change_type: fix
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
intent:
  who: 健康面板用量数据的消费者（搭档 + 大獭）
  problem: "invokes 表 token_usage 只存 input/output，cacheRead/cacheWrite 在落库链上被丢弃——SDK SessionStats.tokens 本含四字段（agent-session.d.ts:182-188），circuit-breaker-helpers.ts:126 只取两个，健康面板 invoke 均值口径（invoke-stats-collector）因此缺 cache"
  trigger: "1149这个小问题你直接修复"
  expected_effect: "invokes 表新增 token_usage_cache_read / token_usage_cache_write 两列，新 invoke 落库含 cache 快照；invoke-stats-collector 差分口径可扩展含 cache（后续面板增强可用）"
verify_by:
  type: static_only
  reason: "数据落库透传扩展，无 LLM 行为变更；验证方式=单测全绿（279 文件 3856 用例）+ 类型编译通过 + migration 幂等性代码审查"
summary: "#1149：invokes 表 token_usage 只存 input/output，cacheRead/cacheWrite 在落库链上被丢弃（SDK 数据本有，circuit-breaker-helpers.ts:126 只取两个）。修复链路：SDK stats.tokens 四字段 → circuit-breaker-helpers 全量取 → types.ts TokenUsage 类型扩展 → orchestrator 透传 → send-entry/agent-invoker 回调透传 → sqlite-invoke-repository 写两列 → schema+ migration 补列。健康面板 invoke 均值口径从此含 cache 数据可用。"
tags: [observability, token-usage, cache, invoke]
capability_test: "n/a: 数据落库透传扩展，无运行时行为变更；279 测试文件 3856 用例全绿"
causal_links:
  from:
    - F20260914rtsp
---

# invoke token usage 补齐 cacheRead/cacheWrite 落库

## 背景

搭档原话（意图锚）：

> 「1149这个小问题你直接修复」

issue #1149：usage 四字段互斥（event-mapping.ts: input 不含 cacheRead/cacheWrite），但落库只存 input/output——cache 数据被丢弃。成本分析系统性低估（本系统大量使用 prompt cache）。

**实现期查证的关键事实**：SDK `SessionStats.tokens` 本就含四字段（input/output/cacheRead/cacheWrite/total，agent-session.d.ts:182-188）——数据一直在生产侧可用，是 `circuit-breaker-helpers.ts:126` 只取了 `input/output` 两个字段，从那里开始整条链路的类型定义都只有两字段，cache 在透传过程中丢失。

## 修复链路（5 层透传 + 2 层落库）

| 层 | 文件 | 改动 |
|---|---|---|
| 生产侧 | `circuit-breaker-helpers.ts:126` | `stats.tokens` 四字段全量取 |
| 类型定义 | `types.ts` / `sdk-invoke-port.ts` / `agent-turn-port.ts` / `agent-metrics-port.ts` / `exit-classifier.ts` / `pi-session-factory.ts` / `agent-invoker.ts` | `tokenUsage` 形状加可选 `cacheRead?`/`cacheWrite?` |
| 编排透传 | `orchestrator.ts:184` | 落库回调透传四字段 |
| 回调链 | `send-entry.ts` / `agent-invoker.ts` | `updateInvokeTokenUsage` 签名扩展 |
| 落库 | `sqlite-invoke-repository.ts` | UPDATE 写 `token_usage_cache_read` / `token_usage_cache_write` 两列 |
| Schema | `schema.ts` invokes 表 | 新增两列（新库 CREATE 含） |
| Migration | `migration.ts` | `ensureInvokeCacheColumns`：存量库 ALTER 补列，PRAGMA 探测幂等 |

## 影响范围

- invokes 表新增两列（历史行留 NULL，无法回补——cache 数据此前未记录）
- 所有 tokenUsage 形状扩展为可选字段（向后兼容，无破坏性变更）
- agent-metrics.ts 的差分快照（`lastTokenSnapshot`）未扩展——metrics 通道的 cache 已由 session JSONL 解析覆盖（cost-output-collector.ts），不在本 PR 范围

## 边界与不做

- 历史数据不回补（cache 数据此前未记录，无法回填）
- invoke-stats-collector 的差分/均值计算未改——数据落库后可另行扩展口径（面板增强另立 issue）
- agent-metrics.ts 差分快照未加 cache 字段——该通道已有 JSONL 解析路径覆盖

## 验证

- Golden Gate: n/a（数据落库透传，无 LLM 行为）
- ✅ 279 测试文件 3856 用例全绿
- ✅ TypeScript 编译零错误
- ✅ migration 幂等性：PRAGMA table_info 探测，新库 CREATE 含两列 / 存量库 ALTER 补列，重复执行无副作用

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/frameworks/agent/circuit-breaker-helpers.ts` | 修改 | 生产侧四字段全量取 |
| `src/usecases/conversation/agent-turn-orchestrator/types.ts` | 修改 | TokenUsage 类型 + 回调签名扩展 |
| `src/usecases/conversation/agent-turn-orchestrator/exit-classifier.ts` | 修改 | 类型扩展 |
| `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts` | 修改 | 落库透传 |
| `src/usecases/ports/sdk-invoke-port.ts` / `agent-turn-port.ts` / `agent-metrics-port.ts` | 修改 | 端口类型扩展 |
| `src/usecases/conversation/send-entry.ts` | 修改 | 回调透传 |
| `src/usecases/conversation/invoke-repository.ts` | 修改 | 接口签名扩展 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | 回调透传 + emitInvokeEnd 类型 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | 类型扩展 |
| `src/frameworks/db/conversation/sqlite-invoke-repository.ts` | 修改 | UPDATE 写两列 |
| `src/frameworks/db/schema.ts` | 修改 | invokes 表新增两列 |
| `src/frameworks/db/migration.ts` | 修改 | ensureInvokeCacheColumns 幂等补列 |
| `docs/features/2026/09/23/F20260923icus-*.md` | 新增 | 本文档 |
