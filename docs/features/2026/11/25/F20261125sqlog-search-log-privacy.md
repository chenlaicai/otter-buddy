---
id: F20261125sqlog
title: 检索埋点隐私默认边界——metadata-only 默认、显式 redacted、off 与保留删除
summary: search_query_logs 埋点从「query 原文 + 上下文预览默认落库」改为三态模式：metadata-only（默认，只写 queryHash/queryLength/检索元数据，零上下文读取）；redacted（显式评估用途，secrets 脱敏后落原文与预览，external 对话不记正文，带有限保留期并在插入时清理超期行）；off（零写入零读取）。新 schema 加 query_hash/query_length/log_mode 三列幂等迁移；repo 增按对话删除与超期 redacted 清理；错误日志只带 queryHash 不带原文。
change_type: feature
doc_type: feature
created_at: 2026-11-25
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯埋点隐私边界契约，由真实 SQLite 内存库 + 模式判别测试验证；不新增 LLM 自由行为"
tags: [privacy, search, logging, retention, schema]
modules:
  - src/usecases/memory/record-search-query.ts
  - src/frameworks/db/memory/sqlite-search-query-log-repository.ts
  - src/frameworks/db/schema.ts
  - src/bootstrap/usecases.ts
intent:
  problem: "检索埋点默认落 query 原文与对话上下文预览（各 160 字符/条 × 5 条），且错误日志带 query 前 50 字符——搭档与外部对话的隐私文本在无任何显式授权的情况下进入持久层与日志，评估期外无人消费。"
  expected_effect: "默认（metadata-only）下 DB 与错误日志均无 query/preview 原文（queryHash/queryLength 是唯一指纹信号）；上下文预览零读取（metadata-only 不调 getEntries）；redacted 显式开启时原文/预览先脱敏、external 对话不记正文、超期行被保留期清理；off 零写入；对话销毁可按 conversation 删除全部埋点行。"
  verify_by:
    type: behavior_check
    rollback: "配置回滚：环境变量回默认即回到 metadata-only；代码回滚 = revert 单 commit（schema 新列带 DEFAULT，老代码不写三列不报错——列可回滚容忍）；存量已写原文行不静默删（运维决策，见下）。"
    risk_note: "存量行（历史 query 原文）不在本 PR 处置——按方案与既有 audit/cleanup 同批运维决策，不静默删；评估脚本 eppq 依赖原文行，metadata-only 新行被长度过滤自然跳过（行为兼容），但长期评估基线需显式开 redacted 采集。"
---

## 背景与问题

整改方案 §PR-10（H9）：`record-search-query.ts` 默认把 query 原文与最近 5 条对话上下文预览（160 字符/条）写入 `search_query_logs`，catch 分支的 warn 还带 query 前 50 字符——埋点是旁路观测，却没有隐私默认边界：原文/预览在无显式授权下持久化，评估期结束后也没有保留期与删除通道。

## 方案

**三态模式**（`SearchQueryLogMode`，构造注入 `SearchQueryLogConfig`，bootstrap 从环境读）：

| 模式 | 写入内容 | 上下文预览 | 备注 |
|---|---|---|---|
| `metadata-only`（默认） | queryHash（sha256）、queryLength、conversation/caller、detailLevel/library/limit、topEntryIds、total、createdAt、log_mode | **不读取**（entryRepo.getEntries 零调用） | legacy `query`/`context_messages` 列落空值/`[]`——不伪造脱敏正文 |
| `redacted`（显式评估） | 上行全部 + 脱敏后 query 原文 + 脱敏后上下文预览 | 读取，逐条过 `redactSecrets` | **external 对话不记正文**：query 落空、预览不读；有限保留期，插入时清理超期 redacted 行 |
| `off` | 零写入 | 零读取 | record 入口直接返回 |

- **错误日志只带 queryHash**：catch 分支 warn 元数据从 query 切片改为 queryHash——原文不进日志（测试锁死）。
- **schema**：`search_query_logs` 增 `query_hash TEXT DEFAULT ''`、`query_length INTEGER DEFAULT 0`、`log_mode TEXT DEFAULT 'metadata-only'` 三列——fresh CREATE + 存量 ALTER 幂等（每列独立 try/catch，同 healing_events 先例）；存量行三列取默认值，不伪造。新索引（conversation_id / log_mode+created_at）在补列之后建——老库表内建索引会因未知列整块 exec 失败（迁移测试实证）。
- **repo 新接口**：`deleteByConversation`（对话销毁/合规清除覆盖日志）与 `deleteRedactedOlderThan`（保留期清理；metadata-only 行无正文不受约束）。
- **复用 C2 sanitizer**：redacted 模式的 query/preview 脱敏走 `redactSecrets`（与记忆投影同一保守模式集）。
- **配置**：`OTTER_SEARCH_LOG_MODE`（默认 metadata-only）、`OTTER_SEARCH_LOG_RETENTION_DAYS`（默认 30，仅约束 redacted）。
- **评估导出兼容**：`eppq-real-model-throughput.mjs` 按只读原样读库；metadata-only 新行 query 为空被既有长度过滤自然跳过——导出默认即 metadata-only 兼容，评估需原文时由运维显式开 redacted 采集（脚本注释已写明）。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 默认 metadata-only | record 正常调用 | 行内 query=''、context_messages='[]'、query_hash 64 位 hex、query_length、log_mode='metadata-only'；getEntries 零调用 |
| off | record 调用 | 行数不变、读取不变 |
| redacted 脱敏 | query/正文含 sk-ant 密钥 | 落库 query/preview 均含 [REDACTED] 不含原文 |
| external 不记正文 | kind=external + redacted | query 落空、预览不读、hash/长度仍记 |
| 保留期 | 40 天前 redacted + metadata-only、5 天前 redacted | 插入触发清理：超期 redacted 删除、metadata-only 保留、未超期保留 |
| 按对话删除 | deleteByConversation | 该对话全部模式行删除，他对话不受影响 |
| 存量库迁移 | 老表无三列 + 存量行 | initSchema 补列、存量行取默认值、新插入可用 |
| 错误日志 | repo 抛错 + query 含密钥 | warn 不含 query 原文/密钥，含 queryHash |

## Verification

### 失败用例证据（bugfix）

- 基线红测：`evidence/sqlog-modes-red.log`——模式判别 10 用例在旧代码全部失败（三态接口不存在）。
- 修复后绿：`evidence/sqlog-green.log`（modes 10 + 既有埋点测试 5，全绿）。

### 回归证据

- `tests/frameworks/db` + `tests/usecases/memory` + `tools` 定向：109 文件 / 1006 用例通过（含 migration-equivalence 守卫）。
- 既有 `search-query-log.test.ts` 快照路径用例固定走 redacted（上下文快照路径仅 redacted 存在），insert 用例补三新字段——形状契约显式测试化。

### 运维文档

- 开启评估采集：`OTTER_SEARCH_LOG_MODE=redacted` 启动（建议同设 `OTTER_SEARCH_LOG_RETENTION_DAYS`）；采集期结束改回默认（metadata-only）或 `off`。
- 存量原文行处置：本 PR 不静默删（方案规定与既有 audit/cleanup 同批运维决策）——需要清除时 `DELETE FROM search_query_logs WHERE log_mode IS NULL OR log_mode='metadata-only'`（存量行 log_mode 取默认值，原文仅在旧行 query 列非空者）需人工核对后执行并留备份。
- 对话销毁清除：调用 repo.deleteByConversation（挂接对话删除流程时零额外操作）。

## 未做项

- 对话删除流程与埋点删除的自动挂接（repo 接口已备，挂接点属对话生命周期域，不夹带）。
- 存量原文行的批量清理脚本（运维决策 + 备份，方案规定不静默删）。
- 不改 fire-and-forget 语义、不改 topEntryIds/total 口径。
