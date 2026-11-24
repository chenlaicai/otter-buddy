---
id: F20261124mempr
title: Conversation Entry 统一记忆投影政策与老库审计清理
summary: 增量、迁移与显式清理共用 MemoryProjectionPolicy 和 EntryMemoryProjector；external 在内容处理前排除，普通 secret 脱敏后入库，独立政策版本驱动老库纠偏，audit/cleanup 覆盖全部 SQLite 卫星。
change_type: feature
doc_type: feature
created_at: 2026-11-24
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯 A 类持久化边界与运维行为，由真实 SQLite/vec0、生产库副本启动和 CLI dry-run/apply 验证；不新增 LLM 自由行为"
tags: [memory, entries, external, security, sqlite, migration]
modules:
  - src/usecases/memory/entry-projection-policy.ts
  - src/usecases/memory/entry-memory-projector.ts
  - src/frameworks/db/memory/memory-projection-maintenance.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/migration.ts
  - src/usecases/conversation/send-entry.ts
  - src/bootstrap/memory.ts
  - scripts/audit-memory-projection.mjs
  - scripts/cleanup-memory-projection.mjs
intent:
  problem: "entries 增量与老库回填各自实现 external、卡片和附件规则，旧 backfilled=done 会永久跳过安全回填；普通历史 secret 不能纠偏，external 历史污染也缺少只读审计和完整卫星清理。"
  expected_effect: "external user/speak 不进入 memory/FTS/vec/tasks；普通内容经统一卡片、附件和 secret 政策后以稳定 hash 幂等投影；老库按独立政策版本补齐/纠偏，audit 无正文，cleanup 经 dry-run 与备份后清理全部卫星且幂等。"
  verify_by:
    type: behavior_check
    rollback: "整体 revert 本 PR 代码与脚本；无 schema 变更。清理造成的数据删除只能用 apply 前 SQLite 备份回滚。external 启用后禁止回滚 pre-C2。"
    risk_note: "普通历史投影会按新政策纠正内容并使旧 vec/task 失效，后续由暗条目扫描重新嵌入；启动迁移只补写/纠偏，external 删除只能由显式 cleanup 执行。"
---

# Conversation Entry 统一记忆投影政策与老库审计清理

## 背景与基线

实施基线：`origin/main@3bca655831bcab3ccb00a5a08723b1630ab9b2fa`。开工时开放 PR 为 #2006、#1994、#1966，无 C2 在途实现。

定稿 PR-04 要求统一 entries→memory 边界。现状存在三个缺口：

1. `SendEntry` 在调用 memory gateway 前自行判断 external、剥卡片、拼附件；迁移另写一套相似 SQL/文本逻辑。
2. `entry_memory_index_backfilled=done` 使老库永久跳过后续政策，已存在的未脱敏 memory 也不会纠正。
3. 没有统一只读审计；简单删除 `memory_entries` 不能覆盖 FTS、vec、weights、embedding_tasks 与关系边。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 政策单源 | `decideEntryProjection` 固定执行类型/external 准入 → 卡片/附件 → secret 脱敏 → SHA-256 | SendEntry、迁移、cleanup 各自复制规则 | 增量与迁移得到相同 decision/contentHash；external 在正文投影、脱敏和 hash 前退出 |
| 应用单源 | `EntryMemoryProjector.apply` 由增量、迁移、显式 cleanup 共用；SQLite store 负责幂等 upsert | 迁移直接 INSERT，直接路径走另一套 StoreMemory 写入 | 同一 entry.id 重放稳定，未来 outbox worker 可复用同一安全回滚入口 |
| 重放与 embedding | 同内容重放返回 unchanged，不重写、不重复 embedding；内容变化更新主表/FTS并使旧 vec/task 失效 | 每次重放 DELETE+INSERT 或重复 embed | 保持幂等并避免旧内容向量/任务覆盖新政策；PR-06 代际 CAS 不在本批冒充实现 |
| 老库迁移 | 新 `entry_memory_projection_policy_version` 独立记录政策版本，不读取旧 done 作为安全证明 | 继续信任 `entry_memory_index_backfilled=done` | 旧回填完成不代表 C2 external/secret 边界已执行；未来政策版本可独立演进 |
| 启动删除 | 启动只补写和纠偏，skip 不删除任何历史记录 | 启动时自动清除 external 污染 | 遵守不可静默批量删除的红线；删除只发生在人工显式 cleanup |
| 大库性能 | 一次装载附件和 memory/FTS/weights 快照，仅对缺失或 hash 不同项写投影 | 每条 entry 逐点查数据库和 FTS 虚表 | 生产副本从超过 10 分钟未完成降至迁移 15.5 秒、audit 5 秒，避免 N+1 全扫 |

机制识别：命中新增跨模块政策/投影路径和显式运维机制；该边界已在双方认可定稿 PR-04 中批准，不在本批扩张为 outbox。

机制预算四问：

1. **谁需要它**：普通对话记忆生产者、external 隔离边界、老库升级运营者，以及未来 PR-07 outbox worker。
2. **失败后果**：external 正文进入全局 memory/FTS/vec/tasks，普通 secret 被持久化或送往 embedding；老库旧 done 造成假安全，单表清理留下可检索或可关联的卫星残留。
3. **后续机制**：政策版本、内容 hash 和清理列表可能出错；由真实 SQLite/vec0、增量/迁移一致性、生产副本和 CLI 幂等测试持续约束，修复仍落在同一 policy/projector/maintenance 边界。
4. **退役条件**：仅当上游提供等价统一投影、独立版本迁移与完整卫星清理，并迁移全部 external/secret/重放/运维测试后才可退役；PR-07 应消费而不是复制本政策。

## 实现

1. 新增 `entry-projection-policy.ts`：只接受 user/speak；conversation.kind=external、entry.source=external 或 restricted invoke 的 externalSpeak 均 skip。普通 user 保留发送 intent 附件投影，speak 剥离卡片，随后复用 `redactSecrets`。
2. 新增 `entry-memory-projector.ts`：project/skip 统一应用；skip 不写也不删，project 按 entry.id upsert。
3. `SqliteMemoryRepository` 增加投影端口：同内容重放只修补缺失的 FTS/weights，不重复 embedding；内容变化更新主表与 FTS、保留 weights/关系边、删除旧 vec/task；显式删除联动所有卫星。
4. `SendEntry → MemoryIndexAdapter` 全量经过统一政策，不再由生产者提前决定是否索引。只有 projected 且内容变化的条目进入实时 embedding。
5. 启动回填按独立版本执行，处理缺失与内容不同项；旧 `entry_memory_index_backfilled` 只为历史观测继续写入，不作为本政策凭据。
6. 新增只读 audit 与默认 dry-run cleanup 脚本。cleanup `--apply` 先用 SQLite 在线备份，再删除 external/excluded 记录及全部卫星，或纠偏普通 missing/different/satellite-incomplete 项。

## 旧机制接管与负向核查

| 被替换物 | 原保护的不变量 | 原消费者 | 新机制接管 |
|---|---|---|---|
| SendEntry 私有 external/卡片/附件判断 | 增量 user/speak 投影，external 隔离 | Web/IM/external user 与 speak | 所有 entry 调统一 policy；发送 intent 附件语义不变 |
| migration 私有回填 SQL 与文本规则 | 老库 user/speak 回填、主键幂等 | `migrateDatabase` | 同一 decision/projector；独立版本键；缺失与不同内容均处理 |
| 单表或脚本各自删除 | 清理主记录 | 运维人员 | repository 单事务删除主表、FTS、vec、weights、tasks、edges；备份后执行 |

负向结论：没有删除 StoreMemory 对其他记忆类型的最终脱敏，没有改变 attachments 发送 intent、普通记忆检索、embedding worker 或既有池/锁。启动迁移明确不清理 external 历史污染；本批不声称 PR-06 的同代 CAS，也不声称 PR-07 的崩溃恢复。

## 非目标

- 不实现 outbox、持续对账、dead-letter 或升级/回滚窗口 worker（PR-07）。
- 不新增 memory_vec 代际 sidecar、generation 或 CAS（PR-06）。
- 不启用 external 流量，不新增 external 功能面或公开任务配置。
- 不改数据库 schema、durable 格式、普通 transcript、检索排序或 H9 查询日志。
- 不在启动时静默删除污染，不处理 PR-05/P2 backlog。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| external 增量 | 以 source=external 调真实 MemoryIndexAdapter | memory/FTS/tasks 全为零 |
| external 老库 | external conversation、external source、restricted invoke 各造 entry，并放普通 canary | canary 正常投影；三类 external 均不投影 |
| 普通 secret | 新增缺失投影及已存在未脱敏投影，重跑迁移 | 两者均为 `[REDACTED]`，FTS 不含原 secret |
| decision/hash | 同一普通输入经 policy 与真实 SQLite 投影 | 入库内容等于 decision.value，入库内容 hash 等于 decision.contentHash |
| 同 hash 重放 | 连续 apply 同一 decision，并预置 vec | 第二次 unchanged，无重复 task，原 vec 保留 |
| 启动负向 | 预置 external memory/task 后执行启动迁移 | 记录仍在，未发生静默删除；audit 可发现，cleanup 才可清理 |
| cleanup | 真实 SQLite/vec0 预置 external 全卫星与普通未脱敏投影 | external 主表/FTS/vec/weights/tasks/edges 全清零；普通内容纠偏；第二次执行零差异 |
| CLI | 默认 audit/cleanup，再 `--apply` | audit 只读且输出无正文；dry-run 无写入/备份；apply 先生成备份，再清零差异 |
| 生产副本 | SQLite 在线备份真实库，跑完整 DB bootstrap 与 audit | 启动成功、无 SqliteError；26,538 条扫描完成且最终差异为零 |

## 运维说明

先构建，脚本消费当前源码的 `dist`：

```bash
npm run build
node scripts/audit-memory-projection.mjs --db=/path/to/otter-buddy.db
node scripts/cleanup-memory-projection.mjs --db=/path/to/otter-buddy.db
```

- audit 以 readonly 打开数据库，只输出计数、entry/conversation ID、政策版本与 hash，不输出正文。
- cleanup 不带 `--apply` 时是 dry-run，不写 DB、不创建备份。
- 确认 dry-run 后执行：

```bash
node scripts/cleanup-memory-projection.mjs --db=/path/to/otter-buddy.db --apply
# 或显式指定备份：
node scripts/cleanup-memory-projection.mjs --db=/path/to/otter-buddy.db --apply --backup=/path/to/backup.db
```

`--apply` 使用 `better-sqlite3 db.backup()` 生成含已提交 WAL 的在线备份，然后才执行事务清理。备份路径打印在输出中；删除回滚必须停止写入并恢复该备份。普通被纠偏条目的向量由后续暗条目扫描/embedding worker 渐进补齐。

## 测试改动声明

方向：收紧。`MemoryIndexGateway.indexMessage` 改为接收完整 entry 的 `indexEntry`，相关文档测试 mock 做机械改名；`MemoryIndexAdapter` 构造注入既有 SQLite 投影端口。既有发送、附件、文档同步、队列断言均保留。新增 C2 测试全部使用真实 SQLite，external vec/task/edges 使用真实 vec0 与关系表，不接受内存 fake 代替。

## Verification

### 失败用例证据（bugfix）

实现前运行 `npx vitest run tests/frameworks/db/memory-projection-c2.test.ts`，4 个场景全红：旧 done 让普通 canary 不投影，缺失普通 secret 为 undefined，既有 secret 原文保持。原始摘录见对话工作区 `evidence/pr04-red-before.log`。

实现后同一组增加“启动不得静默删除”场景，并联跑增量、迁移、maintenance 与既有回归：**5 文件 / 21 用例全绿**，见 `evidence/pr04-focused-green.log`。

### 生产副本与 CLI 证据

- 通过 SQLite 在线备份取得 4.5GB 生产库副本，在副本上执行 `initDatabaseAndModels` 完整 DB 启动路径：`bootstrap=ok`、**15,468ms**、无 SqliteError。C2 扫描 26,538 条 user/speak：18 条纠偏、26,515 条同 hash 跳过、5 条 external skip。日志：`evidence/pr04-prod-copy-bootstrap.log`。
- 生产副本 audit 5 秒完成：26,533 matched、5 skipped、**items=0**。证据：`evidence/pr04-prod-copy-audit.json`。首次逐行实现超过 10 分钟未完成，已改为快照批量读取后复测得到上述最终结果。
- 独立真实 SQLite CLI fixture：dry-run 无写入/备份；apply 备份存在且差异归零；第二次 apply 前后均零；全部 JSON/log 不含 external 原文或 secret。证据目录：`evidence/pr04-cli/`。

### 回归与最简检查

- 已过最简检查：复用现有附件投影、卡片剥离、secret sanitizer、SQLite repository、暗条目扫描与 `db.backup`；新增文件仅为定稿 policy/projector/maintenance 和两个薄 CLI，无新依赖、无 schema。
- `npm run check`：build、eslint、schema、fresh/existing DB boot、脚本/端口/otterbar 探针全通过，见 `evidence/pr04-check-final.log`。
- `npx vitest run`：**532 文件 / 6834 用例全部通过**，见 `evidence/pr04-full-test-final.log`。首轮仅因本机缺 Chromium 失败 2 个浏览器文件，安装对应浏览器后失败文件 12 用例全绿，最终全量无豁免。
- `npm run test:capability`：**17 文件通过，17 passed + 48 skipped**；跳过均为未配置真实 LLM，确定性 wire 与本地 embedding 用例实跑通过，见 `evidence/pr04-capability-final.log`。
- `npx tsc --noEmit`、eslint、`git diff --check`：通过。
- Golden Gate 已随 capability 执行；锚点重放 `n/a`：未修改 prompt、Skill 或 tool description 文本。

## 回滚与迁移

政策代码、脚本和测试可整体 revert；无 schema 变更。启动回填已写入的新政策版本键在旧代码中不会被消费。若已执行 cleanup，数据删除只能用 apply 前备份回滚，代码 revert 不能恢复已删记录。

普通内容纠偏会使旧 vec/task 失效，这是避免旧 secret/external 内容继续被检索或嵌入的有意行为；重启后的暗条目扫描负责补齐。external 一旦启用，禁止回滚到 pre-C2 或含旧回填旁路的版本；后续 outbox 回滚目标仍须包含本统一政策及 PR-06 代际能力。
