---
id: F20261124mvcas
title: memory_vec 代际 sidecar 与同代 CAS
summary: 为 memory_entries、embedding_tasks 与 memory_vec 建立同一内容代际，旧 embedding 无论经成功、实时、salvage 或失败重试路径晚到，都不能覆盖新向量或完成、标死新代任务；存量库以加法迁移绑定既有数据。
change_type: fix
doc_type: feature
created_at: 2026-11-24
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯 A 类 SQLite 代际与持久队列并发契约，由真实 vec0、真实 worker 和可控晚到结果验证；不新增 LLM 自由行为"
tags: [memory, vector, embedding, sqlite, concurrency, migration]
modules:
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/memory/embedding-task-queue.ts
  - src/usecases/memory/store-memory.ts
  - src/usecases/memory/embedding-retry-worker.ts
  - src/usecases/memory/entry-memory-projector.ts
  - src/usecases/memory/memory-queue.ts
  - src/usecases/memory/memory-writer.ts
intent:
  problem: "embedding 只按 entryId 无条件 DELETE+INSERT memory_vec，并按 entryId 删除或标死任务；内容已进入新代后，旧代慢结果或 salvage 晚到仍会覆盖新向量、删除新任务或把新任务标死。"
  expected_effect: "entry、task 与向量 sidecar 使用相同 generation/contentHash；只有候选仍等于 entry 当前代际且不落后于 sidecar 时才写向量，任务完成与失败也只作用于同代任务。内容不变保留代际和向量，新代入队重置 attempts，同代重试保留 attempts。"
  verify_by:
    type: behavior_check
    rollback: "代码可 revert，但回滚前必须停止 worker 并等待在飞任务，目标版本必须理解代际；不得回到无条件覆盖向量的旧实现。加法列与 sidecar 可保留且不得借回滚删除数据。"
    risk_note: "新增两个 entry 字段、两个 task 字段和一张普通 sidecar；启动回填既有 hash、任务与向量代际。schema 只增不删，vec0 形状不变，检索排序与 durable 不变。"
---

# memory_vec 代际 sidecar 与同代 CAS

## 背景与基线

实施基线：`origin/main@a9611d2485f0aae0e7db7028c1fc7db5c26bcfaa`。开工时仅有开放 PR #1966，文件与本批无交集；前置投影政策与检索出口均已合入。

定稿方案指出根因：向量表与任务表只有 entryId，无法区分内容代际。旧代 A 计算慢、新代 B 已完成后，A 的正常完成、超时 salvage 或失败记账仍按同一 entryId 写库，造成三类用户可感知错误：

1. 新内容检索被旧向量污染，召回语义回到旧版本。
2. A 的 `markTaskDone` 删除 B 的 pending task，B 失去持久重试账本。
3. A 的 `markTaskAttemptFailed` 改写 B 的错误或把 B 标 dead，新内容不再重试。

## 目标与非目标

目标：让 entry 内容、任务与已落向量拥有可机械校验的同代身份；所有实时、投影、批量、单条、salvage 和失败路径都经过同一 CAS；存量数据以加法 schema 和真实启动迁移升级。

非目标：不实现 outbox 或持续对账，不改 vec0 虚拟表形状，不改 embedding 模型、队列优先级、检索排序、投影政策、查询日志、durable 或其它整改批次。

## 核心数据结构与消费方

| 字段/表 | 写入 | 消费方 |
|---|---|---|
| `memory_entries.generation/content_hash` | 新 entry 从代际一开始；内容变化时递增并重算 hash，内容不变保留 | `storeEmbedding` 的当前代际校验、`enqueueRetry` 的任务绑定、claim 的 stale 过滤 |
| `embedding_tasks.generation/content_hash` | 入队时复制 entry 当前代际；新代替换旧任务并重置 attempts，同代保留 attempts | worker 把 claim 快照传入 store/markDone/markFailed；SQL 条件阻止旧回调修改新任务 |
| `memory_vec_generations(entry_id,generation,content_hash,updated_at)` | 与 memory_vec 同事务 CAS upsert；存量向量启动回填 | `storeEmbedding` 拒绝落后于已落向量水位的候选；同代同 hash 重放幂等 |

sidecar 是 vec 的代际水位，不代替 entry 当前代际。内容更新删除旧 vec 防止陈旧召回，但保留 sidecar；彻底删除 entry 时才通过统一卫星清理删除 sidecar。模型版本禁用 vec 时清空 vec 的既有行为不变，同代同 hash 在 vec 缺失后仍可补写。

## 设计与旧机制接管

1. `storeEntry`、`replaceEntryBySource` 与统一 projector 返回实际代际。StoreMemory 在发起 embedding 时捕获该值，不能等晚到完成后重读 entry 并冒充旧结果属于新内容。
2. `claimPendingTasks` 固化任务代际快照。批量成功、单条成功、两条 salvage、ghost/hard failure 全部显式传递该快照。
3. `storeEmbedding` 单事务依次校验 entry 当前代际、sidecar 水位，再 DELETE+INSERT vec 并 CAS upsert sidecar。entry 不存在、候选不等当前代际、sidecar 更新或同代不同 hash 都是 no-op；同代同 hash 且 vec 已存在是幂等 no-op。
4. `markTaskDone` 和 `markTaskAttemptFailed` 的 SQL WHERE 同时匹配 entryId、generation、contentHash。stale task 不再被 claim；entry 已不存在的 ghost task 保持原有死信处理。
5. 启动以加法 ALTER 和 sidecar 建表升级。空 hash 的存量 entry 计算 SHA-256，存量 pending/dead task 绑定当时 entry 代际，既有 vec 按 entry 主键 JOIN 回填同代 sidecar；已带代际的任务不会在重启时被重绑。
6. 旧投影 ID 换键保留 entry/task/sidecar 代际，显式 cleanup 和旧 body 清理同步处理 sidecar。离线审计在 sidecar 不存在的老库上仍可运行。

### 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 代际真源 | entry 当前代际 + vec 普通 sidecar 水位 | 给 vec0 增加虚拟列或只看任务代际 | vec0 形状不变；任务删除后仍能拒绝旧 salvage |
| 异步参数 | 发起时捕获 generation/contentHash，worker 使用 claim 快照 | 完成时按 entryId 重读当前 hash | 重读会把旧计算错误认领到新内容 |
| 内容更新 | 增代、删旧 vec/旧 task，保留 sidecar | 连 sidecar 一起删除 | 保留水位才能拒绝更晚到达的旧代结果 |
| 重试计数 | 新代 attempts 归零，同代保留 | 所有入队都清零或都保留 | 新内容应获得新失败预算，同内容重试不能无限续命 |
| 大库回填 | 单向扫描 memory_vec 后按 entry 主键 JOIN | 对每个 entry 相关查询 vec0 | 生产副本证明相关查询会超出健康窗口；JOIN 保持同语义并避免 N+1 |

机制识别：命中新增持久化字段/表、持久化决策分支和跨模块代际传递，因此归类 `mechanism-addition`，不是只改函数签名。定稿方案已完成主审 delta 签认；实现仍须独立对抗检视，不以方案签认替代代码验收。

机制预算四问：

1. **谁需要它**：记忆投影与文档同步流程需要新内容可靠召回；embedding retry worker 需要持久任务不被其它代际误删；调用 search_memory 的獭需要结果不回到旧内容。
2. **失败后果**：旧向量覆盖会让用户看到与当前正文不一致的语义召回；旧回调删除或标死新任务会让新内容长期只有 FTS、缺失向量且无法自动恢复，不只是内部指标异常。
3. **后续机制与修复**：新状态可能出现孤儿 sidecar、task/entry 不同代、sidecar 超前或大库回填缓慢。统一删除清理孤儿，claim 过滤不同代任务，entry+sidecar 双重 CAS 阻止超前写入，生产副本验证回填性能与幂等；既有 pending/dead/age 继续提供任务观测。
4. **退役条件**：只有当 vec 存储原生提供等价的代际约束与任务 CAS、或整个向量检索机制退役，并且所有在飞旧 writer 停止、数据完成可读迁移后，才可删除 sidecar。代码行数下降或长期未发生事故不是退役信号；在此之前是永久维护承诺。

机制提案准入三问：决策者不变，仍由既有投影与 worker 决定何时计算，数据库只拒绝错误代际；核心约束由真实 SQL 条件和事务机械执行，不靠调用方自觉；真实竞态、迁移和启动证据让人能直接判断新代是否保持，降低并发深潜成本。负面清单不命中：没有自动替人裁决、随机抽查或限速跳过。

## 负向核查

- 不放宽既有断言：既有测试只补当前代际参数或 fake 返回值，原优先级、退避、死信、drain、检索和清理断言保留。
- 不绕过旧保护：entry 删除仍清全部卫星；ghost task 仍进入既有死信路径；vec 禁用仍降级 FTS；同内容且 vec 存在仍保留向量；队列优先级和 attempts 既有语义不变。
- 不引入旧回调新旁路：实时、统一投影、批量、单条、partial salvage、单条 salvage、ghost/hard failure 均使用代际快照。
- 不改旧格式为不兼容：加法列提供默认值，存量 hash 启动补齐；vec0 DDL、memory entry 实体读取和 durable 不变。
- 不用回滚制造旧写者：回滚必须停在懂代际的版本；禁止恢复无条件 DELETE+INSERT。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 老库升级 | 构造无代际列的 entry/task/vec，执行 initSchema 两次并做 KNN | entry/task/sidecar 同代，attempts 与 vec 内容保留，vec0 结构及 KNN 可用 |
| 新代成功、旧代后到 | A claim 后更新为 B，B 经真实 worker 成功，A 最后 store/markDone | vec 与 sidecar 保持 B，A 不影响 B 完成态 |
| 旧失败晚到 | B pending 且 vec 已写，A store/markFailed | B 的 attempts/status/last_error 完全不变，vec 保持 B |
| 实时与 salvage | 分别让实时旧 Promise、worker 旧 salvage 最后完成 | 两条实际调用链均不能覆盖 B 或删除 B task |
| 同代与新代重试 | 同代重复 enqueue，再换内容 enqueue | 同代 attempts 保留，新代 attempts 重置并绑定新 hash |
| 同代重放 | 同代同 hash 以不同向量重复写入，再以同内容 replace | 首向量保留，代际不变，embeddingKept=true |
| 统一投影与 ID 换键 | projector 连写两代；旧投影 ID 经 migrateDatabase 换键 | projector 返回真实代际；换键后 entry/task/sidecar/vec 代际和向量保留 |
| 生产副本真启动 | 在线备份生产库，在 alpha 副本完整启动并回读 | 健康探针通过、无 SQLite 错误、空 hash/孤儿 sidecar/超前 sidecar 均为零 |

## Verification

### 失败用例证据（bugfix）

实现前运行新增真实 SQLite 套件，**7 个场景全部失败**：缺 generation 列与 sidecar，旧接口把新增参数错当成向量或错误参数，无法保证新代状态。原始输出保存在对话工作区 `evidence/mvcas-red.log`。修复过程中仅修正测试自身的 Float32 精度表达与异步等待空值读取，业务断言未放宽；随后补充统一投影和 ID 换键两条正向覆盖。

### 当前证据

- 新增聚焦覆盖：竞态/投影/ID 换键 **8 用例** + schema 老库迁移 **1 用例**，合计 **9/9 通过**；DDL 归位后两文件共 **17 用例**通过，见 `evidence/mvcas-focused-final.log`、`evidence/mvcas-ddl-ratchet-fix.log`。
- 首轮相关回归：**9 文件 / 95 用例通过**；lint 局部抽取后相关回归：**5 文件 / 53 用例通过**，见 `evidence/mvcas-focused.log`、`evidence/mvcas-post-lint-refactor.log`。
- memory/schema/DB 扩大回归：**77 文件 / 704 用例通过**；迁移与离线清理专项：**4 文件 / 39 用例通过**，见 `evidence/mvcas-memory-db-regression.log`、`evidence/mvcas-migration-cleanup.log`。
- 生产库在线备份：69,124 entries、152,360 vectors、0 tasks，备份前后计数一致且升级前代际列为零，见 `evidence/mvcas-production-backup.log`。
- 生产副本首次验证暴露 vec0 相关查询 N+1，改为单向 vec JOIN 后完成迁移；完整 alpha 启动与健康探针通过，幂等 schema 初始化 606ms，启动日志无 SQLite 错误。副本正常文档同步推进 18 个 entry 代际；空 hash、孤儿 sidecar、sidecar 超前均为零。显式关闭 embedding 后 vec 被既有降级逻辑清空，实例已停止，见 `evidence/mvcas-alpha-start-long.log`、`evidence/mvcas-production-post-start-invariants.log`。
- 已过最简检查：复用现有 projection hash、MemoryWriter/MemoryQueue、runInTx、任务队列与卫星删除；新增一张方案指定 sidecar，无新依赖、无新 worker、无新配置。
- `npm run check`：build、eslint、schema、fresh/existing DB boot、脚本/端口/otterbar 探针全通过；`lint:intent`、`lint:docs`、`lint:capability`、`lint:tests` 均通过，见 `evidence/mvcas-check-final.log`、`evidence/mvcas-ddl-ratchet-fix.log`。
- `npx vitest run`：**537 文件 / 6863 用例全部通过**，见 `evidence/mvcas-full-test-final.log`。
- `npm run test:capability`：**17 文件通过，17 passed + 48 skipped**；跳过均为未配置真实 LLM，确定性回放与本地用例实跑通过，见 `evidence/mvcas-capability-final.log`。
- `npx tsc --noEmit`、eslint、`git diff --check` 通过；最终 head 的新增注释编号锚点门通过，回读输出为「新增注释行无特性/轮次/issue 编号」。

## 回滚

先停止 embedding worker 并等待在飞任务，再回滚到理解代际的兼容代码。加法列和 sidecar 保留，不需要也不应执行 DROP；旧数据可由同代代码继续读取。不得回滚到无条件按 entryId 覆盖 vec、删除或标死任务的实现。若必须暂停新版本，应停 worker 而不是让旧写者继续运行。
