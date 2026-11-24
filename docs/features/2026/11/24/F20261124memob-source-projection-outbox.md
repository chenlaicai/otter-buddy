---
id: F20261124memob
title: 源侧记忆投影 Outbox 与无水位对账
summary: 将 user/speak entry、entries_fts 与无正文 outbox 在同一源库事务落盘，由持久 worker 重读源并经统一 projector 至少一次投递；持续三方对账覆盖历史、故障及兼容回滚窗口，不依赖部署时间或一次性水位。
change_type: feature
doc_type: feature
created_at: 2026-11-24
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯 A 类 SQLite 持久化、故障恢复与投影契约，由真实 SQLite、子进程故障注入和真实启动验证；不新增 LLM 自由行为"
tags: [memory, entries, outbox, sqlite, recovery, migration]
modules:
  - src/frameworks/db/schema.ts
  - src/frameworks/db/conversation/sqlite-entry-repository.ts
  - src/frameworks/db/memory/projection-outbox-repository.ts
  - src/frameworks/db/memory/memory-projection-maintenance.ts
  - src/usecases/memory/entry-projection-worker.ts
  - src/usecases/conversation/send-entry.ts
  - src/bootstrap/memory.ts
  - src/app.ts
intent:
  problem: "entry 落库后直接同步写 memory，进程在两者之间死亡会永久丢失投影；兼容回滚窗口的直接写入没有 outbox 记录，一次性回填标记也无法发现后续差异。"
  expected_effect: "user/speak entry、FTS 与无正文 outbox 原子落盘；worker 按 entryId 重读源并幂等应用，崩溃后续投；三方对账持续报告并收敛 missing/different/pending/dead/oldest age，external 明确 skipped，兼容回滚后的直接投影在再升级后无缺失、无新代重复。"
  verify_by:
    type: behavior_check
    rollback: "仅允许回滚到包含统一 ProjectionPolicy 与代际写入的兼容版本。先停 outbox worker，保留 outbox 表，由兼容版直接 projector 写入；再升级执行无 watermark 对账。external 启用后禁止 pre-C2，禁止回到无条件向量覆盖版本。"
    risk_note: "新增一张源侧表及状态索引；启动和巡检增加批量源扫描与 outbox 维护成本。不复制正文、不做长期双写、不声称跨存储恰好一次，不改 vec0、durable、检索排序或投影政策。"
---

# 源侧记忆投影 Outbox 与无水位对账

## 背景与基线

实施基线：`origin/main@e5ed5232c560d1e438a57375bee642e93f6eba3e`。前置统一投影政策和向量代际均已合入。旧发送链在 entry 落库后直接调用 memory adapter，两个写动作之间没有持久投递凭据；进程死亡、直写失败或兼容回滚都会留下只能靠下一次全量回填偶然修复的缺口。

## 目标与非目标

目标：源 entry 与 outbox 原子提交；worker 至少一次、统一 policy/projector 幂等应用；无正文、无 watermark 的三方持续对账覆盖升级、故障、兼容回滚与再升级；异常和积压可观测。

非目标：不改数据库为跨库分布式事务，不改 durable/vec0/FTS 形状，不重写 projector、embedding worker、PatrolWorker、池或锁；不增加常驻定时器，不做长期 entry→memory 双写，不实现其它整改批次。

## 核心数据结构与消费方

`memory_projection_outbox` 以 `entry_id` 为主键，保存 conversation、附件发送意图 ID、政策版本、pending/done/skipped/dead、attempts、下次重试时间、错误与时间戳。正文只存在 entries，worker 每次按 entryId 重读 entries、conversation/invoke 和附件元数据。

| 消费方 | 契约 |
|---|---|
| entry repository | user/speak 的 entry、entries_fts、outbox 在同一本地事务；正文更新重新入队 |
| SendEntry | 只传附件发送意图并弱触发 worker，不再直接索引正文；触发失败不影响消息发送 |
| projection worker | 逐条重读源；external/空内容标 skipped；projected 后才调度同代 embedding；失败持久退避并最终 dead |
| reconciler | 全量/分批重读 user/speak，按 entryId+当前投影 contentHash 对齐 outbox 与 memory；不用部署时间推断缺口 |
| 兼容回滚版 | 保留 PR-04 直接 projector 路径；outbox 表保留，再升级时补登 done 或重新入队 |

## 设计与旧机制接管

1. 所有 entry 创建入口共用源侧 enqueue helper；只有 user/speak 建行，external 同样入队，由统一政策决定 skipped。
2. worker 串行 drain 并防重入。apply 成功、markDone 前崩溃会重放；projector 对同内容返回 unchanged，不增加代际、不重复实时 embedding。
3. reconciler 使用批量快照避免大库 N+1：memory 同 hash 时补 done；缺失或 hash 不同则补/重开 pending；external 补 skipped；既有 dead 保持显式可见，不在每轮巡检无限复活。
4. 新 entry 弱触发即时 drain，启动与既有 PatrolWorker 周期执行 reconciliation+drain；不新增 timer。
5. 直接 `MemoryIndexAdapter.indexEntry` 保留为兼容回滚和统一投影测试入口，但生产 SendEntry 不再调用。

### 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 投递凭据 | 源侧每 entry 一行，仅存 ID/附件意图 | outbox 复制正文 | 源是唯一正文真相，避免双正文漂移与 external 泄漏 |
| 一致性边界 | entry+FTS+outbox 单事务，memory 至少一次 | 声称跨存储 exactly-once 或长期双写 | 崩溃可恢复且 projector 已具备幂等/代际语义 |
| 回滚收敛 | 每次启动与巡检按源和 hash 对账 | 部署时间/watermark/settings.done | 回滚窗口没有 outbox 写入，只有重读源才能发现 |
| 附件 | 创建事务保存发送 intent ID，worker 查元数据 | 依赖 attach 最终结果 | attach 非阻断失败时仍保持用户发送意图 |
| dead | 对账报告保持 dead，正文更新显式重开 | 每轮自动清零 dead | 防止永久错误每小时复活，死信必须可处置 |

机制识别：命中新增持久表/状态机、跨模块投递与恢复决策，归类 `mechanism-addition`。定稿方案已完成主审签认，代码仍须独立对抗检视。

机制预算四问：

1. **谁需要它**：消息生产者需要落库后可靠投影；worker 需要持久重试；运营者需要识别回滚窗口和死信；检索调用方需要最终完整的记忆。
2. **失败后果**：源已提交而 memory 未提交会永久漏记；重复 apply 若绕过 projector 会增代和重复 embedding；external 若在生产者预过滤会留下政策旁路。
3. **后续机制与维护**：新增 outbox 行积累、全量对账和 dead 处置成本；以状态索引、批量快照、pending/dead/age 报告控制，复用现有巡检和 projector，不另建调度框架。
4. **退役条件**：只有源与投影获得同等持久原子性、且历史 outbox 完成对账并具备可读迁移后才可退役；长期无事故或减少文件数不是退役依据。

## 旧机制接管表

| 被替换物 | 原保护的不变量 | 原消费者 | 新机制接管 |
|---|---|---|---|
| SendEntry 落库后直接 indexEntry | user/speak 正文、附件 intent、卡片剥离、external 隔离；索引失败不阻断发送 | 用户与獭消息、memory/FTS/vec/tasks、发送链测试 | entry 事务先存 outbox；worker 使用同一 policy/projector；弱触发失败仍不阻断发送，持久 pending 兜底 |
| 一次性 policy backfill/settings.done | 老库升级时补写和纠偏，不静默删除 | 启动迁移、老库测试 | 保留既有政策升级；持续对账接管后续与回滚窗口，不读取旧 done 作为永久正确性证明 |

## 负向核查

- 不放宽 external、secret、附件、卡片剥离、代际或非阻断发送契约。
- 不绕过统一 projector，不在 outbox 或 worker 另写投影政策。
- 不删除既有直接 projector，兼容回滚仍能写；新版运行时不长期双写。
- 不用 watermark 掩盖回滚缺口，不在启动静默删除污染或 dead。
- 不新增后台常驻循环、不修改 embedding 队列语义和 durable。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 源事务 | 真实 SQLite 创建 user/speak/其它 entry，注入 outbox 失败 | user/speak 的 entry+FTS+outbox 同生同灭；其它类型无 outbox；附件仅存 ID |
| 崩溃续投 | 子进程提交 entry 后、memory 写入前接收 SIGKILL，重开并 drain | outbox 仍在，最终 memory/FTS 恰一条，状态 done |
| apply 后崩溃 | 在 apply 成功、markDone 前注入中断，再 drain | 重放 unchanged，generation 不增加，embedding 不重复，最终 done |
| external | external kind/source/restricted speak 入队并 drain | outbox skipped，memory/FTS/vec/tasks 无对应正文 |
| 回滚窗口 | 升级后故障，兼容版直接 projector 写新 entry，再升级 reconcile+drain | 无 watermark 补齐 outbox；已有同 hash 标 done，缺失/不同补投影；无双嵌、无重复增代 |
| 对账可观测 | 构造 missing/different/pending/dead 与旧 pending | 报告各项计数、ID/hash 与 oldest age；收敛后非预期差异为零 |
| 老库与生产副本 | 无 outbox 老库升级，生产副本完整 alpha 启动 | 表结构/索引/功能探针通过，无 SQLite 错误，最终对账可解释 |

## Verification

### 失败与修正证据

- 实现前新增套件在旧基线上失败：outbox repository 不存在，原始输出见对话工作区 `evidence/memob-red.log`。
- 首轮 capability 的真实用户消息召回锚超时；根因是 capability harness 未像真实 main 一样执行 `postListenInit`，不是放宽检索断言。补齐启动步骤后，单锚和完整 capability 均通过，见 `evidence/memob-capability-memory-recall-fix.log`、`evidence/memob-capability-final.log`。

### 当前证据

- 判别套件覆盖源事务回滚、老库结构/FTS 探针、跨 SQL 参数批、源重读、附件 intent、apply 后中断重放、dead/oldest age、orphan tombstone、external skipped、无水位回滚收敛和 SendEntry 外部行为，见 `evidence/memob-batch-stop.log`。
- DB/memory/conversation 扩大回归 **128 文件 / 1310 用例通过**，见 `evidence/memob-expanded.log`。
- 真实编译产物故障演练：子进程在 memory 写入前接收 **SIGKILL**；恢复后 pending→done；兼容回滚同 hash 直写补 done 且不增代，缺失源重新入队；最终 missing/different/pending/dead/orphaned 全零，见 `evidence/memob-recovery-drill-final.log`。
- 全量单测 **538 文件 / 6875 用例通过**，见 `evidence/memob-full-test-final.log`。
- `npm run check` 的 build、全仓 eslint、schema、fresh/existing DB boot 与脚本探针通过，见 `evidence/memob-check-final.log`。
- capability **17 文件通过，17 passed + 48 个无 LLM 配置 skip**，见 `evidence/memob-capability-final.log`。
- schema、intent、docs、capability 文档、tests lint 与 TypeScript 均通过；无新增依赖、无新增 timer。
- 生产库在线备份前后均为 **79,484 entries / 69,197 memory entries**，升级前 outbox 表不存在，见 `evidence/memob-production-backup.log`。生产副本真启动尚待其他 worktree 的无锁 alpha 实例由所属任务收尾；当前不把该项记为通过。

### 最简实现检查

复用现有 policy/projector、StoreMemory、SqliteEntryRepository 事务与 PatrolWorker；仅新增方案要求的 outbox 状态存储、worker 和对账，不新增依赖或定时器。大库读取采用固定 ID 批量，shutdown 等待在途 drain，避免以简化名义绕过 SQLite 参数边界或关闭保护。
