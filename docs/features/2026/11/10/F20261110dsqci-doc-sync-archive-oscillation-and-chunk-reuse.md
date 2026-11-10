---
id: F20261110dsqci
title: doc sync 归档-复活振荡根治与 chunk 内容寻址复用
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯后端 sync/队列幂等修复，无 LLM 参与行为"
intent:
  problem: "doc sync 见 rootDir 下无文件即归档 + chunk reindex 无条件删旧插新全量登记 embedding 任务，归档-复活振荡下每轮全量重灌 ~6200 任务白算，回填队列不收敛（#1818 实测 pending 6301 且涨）"
  expected_effect: "worktree 视角 sync 不再误归档主仓文档；即使全量 reindex，内容未变的 chunk 复用旧 entry（向量保留零重算），仅新建 chunk 登记 embedding 任务；二次 sync 同输入登记数=0"
  verify_by:
    type: behavior_check
causal_links:
  - F20261110embrc
  - F20261109epqst
  - F20261105embqg
summary: 归档判定收窄到 canonical rootDir（服务主仓）视角；chunk 按三重判据复用旧 entry 并在事务内核实实际复用集，summary 内容未变保留 vec，消除归档-复活振荡驱动的每轮 ~6200 chunk + ~1100 summary 重算。
---

# doc sync 归档-复活振荡根治与 chunk 内容寻址复用

## 问题（#1818 案发，比 issue 根因假设深一层）

issue #1818 假设「sync 见无向量 chunk 即登记任务，不查 pending 在途」。实测根因是**双缺陷振荡**：

**主库铁证（2026-11-10 16:00 实测）**：1137 个文档 **1133 个处于 archived 状态**（draft 仅 4）；当日 feature_chunk 重建 6088 条（前一日 34）；pending 5260 持续不收敛。

**完整因果链**（服务日志 pid=39954 时间线还原）：

1. **误归档**：`sync_docs(rootDir=worktree)` 时 worktree 检出比主仓少文档是常态（部分检出/滞后检出），`archiveDeletedDocuments` 见「该 rootDir 下无此文件」即归档 → 主仓独有文档批量误归档（案发窗口还存在第二个进程 pid=52090 于 15:49-16:53 连主库跑 sync，rootDir 为 939 文档的目录）
2. **全量复活**：下轮主仓 sync 时 fingerprint 含 `status` 字段，archived→draft 全部 mismatch → ~1002 文档全走 update 分支 → `replaceChunksBySource` 删旧插新（全新 UUID）
3. **向量全损**：删旧时级联删 fts/vec/weights/**embedding_tasks**——worker 已算好的向量连同任务一起删光，再登记 ~6200 新任务（attempts=0，与 15:17 批 5698 条 attempts=0 实测吻合）
4. 振荡周期 20-40 分钟（当日 14:35/15:08/15:52/16:43/17:14/17:38/20:21 七轮全量重灌），排水速度（#1812 实测 ~119 条/分）永远追不上重灌速度

`enqueueRetry` 的 ON CONFLICT 幂等键从未生效：entry id 每次全新，重复登记不撞主键——issue 验证断言「二次 sync 登记数=0」在旧代码下不可能成立。

## 修复设计（Modification-Class: mechanism-addition）

sync 的本意是增量同步幂等；误归档与全量白算是缺陷不是特性。但第一轮对抗检视确认本修新增 canonical 开关、跨模块 port 与持久化复用决策分支，不能仅以 bug fix 归为 narrow-fix，故按机制新增走重对抗门。

### 机制预算四问（规程原问题）

① **谁需要它**：`sync_docs`/postListenInit 流程需要 canonical 守卫，避免 worktree 部分检出误归档；文档检索使用者与 embedding retry worker 需要稳定复用，避免复活后检索能力长时间缺口和队列永不排水。

② **失败后果**：用户可感知的损害是主仓文档被误归档、文档记忆检索缺失，以及 live 消息嵌入被数千个重算任务挤占；不只是内部 pending 指标异常。

③ **后续机制**：新状态包括「规划复用但旧行已被并发删除」「同 content 多个旧 id」「summary 有/无 vec」。分别由事务内实际复用集+stale INSERT 并登记、旧 id 队列逐个 consume、无 vec/内容变化退回重算修复；真实 SQLite 并发、重复、sync 级复活回归持续锁住。

④ **退役条件**：若未来 sync 取消多 rootDir/worktree 写入且归档不再由磁盘缺失驱动，canonical 守卫可在对应回归改写后删除；若底层索引原生提供稳定内容寻址 ID 与事务级复用，且同 corpus/并发/复活回归在不依赖本层时仍全绿，则退役本层复用编排。在此之前持续保留。

### 机制提案准入三问

① **决策者变了么**：没有。不新增或转移人的裁决权，只机械阻止非 canonical 流程执行其本无权判定的归档；复用也不改变内容是否入库的归属。

② **靠自觉还是靠守卫**：靠守卫。路径相等、SQL 现存交集、实际复用集登记均为机械约束；三重判据语义与上线口径属「半机械+异体审」，由回归和对抗检视共同把守。

③ **深潜成本降了吗**：降了。`sync_start`/`sync_archive_guarded` 直接给出 rootDir 与守卫结果，pending 与稳定 entry id 可直接对账；真实 sync 级测试把复活轮零净增变成可重复证据。**P0 负面清单：未命中**——没有自动巡检替人盯、随机审计、产出限速、自动跳过或智能预审。

### 设计属性

- **最小性**：仅同 source+contentType 的精确三重匹配复用，不引入全局内容寻址或新存储格式。
- **收敛性与退化**：同输入第二/三轮零登记；无匹配、旧行消失、vec 不可用均退回既有新建+重算，不传 canonicalRootDir 保持旧行为。
- **观测面**：沿用 archiveGuarded / pending 计数，并以真实 SQLite 与完整 SyncDocuments 验收作为持续证据。

### 重对抗门留痕

第二轮 delta 复核结论：**确认治本**。归档权限归位 canonical 主仓视角、向量身份生命周期归位稳定 entry id，stale/无 vec/内容变化均有退化路径；两项 🔴 与剩余 🟡 全部闭环，剩余上线后 24h 队列收敛监控不构成阻断。

### A. 归档守卫（断振荡驱动源）

`SyncDocuments.execute(rootDir, { canonicalRootDir })`：归档仅在 `path.resolve(rootDir) === path.resolve(canonicalRootDir)`（服务主仓视角）时启用。

- 语义依据：归档 =「文档从仓库删除」，只有主仓视角有资格判定；worktree 缺文档是常态不是删除
- app.ts 两处调用（postListenInit、sync_docs 工具闭包）均传 `canonicalRootDir: appRootDir`
- 不传 `canonicalRootDir` 时保持旧行为（归档启用）——存量调用方与测试零破坏
- 守卫触发时 `SyncResult.archiveGuarded` 计数 + `sync_archive_guarded` warn 日志
- `sync_start` 日志补 `rootDir`/`canonicalRootDir`/`archiveEnabled`（issue 待查项 3「不知道触发源扫哪」的可观测性缺口）

### B. chunk 内容寻址复用（向量保真 + 幂等键生效）

`StoreMemory.replaceChunksBySource`：入队前先读旧 chunks（新 port 方法 `findEntriesBySourceAndType`），按 **content + heading_path + char_count 三重判据**对齐：

- 命中的复用旧 entry id——向量/fts/weights/edges 卫星数据全保留，**不登记 embedding 任务**
- 未命中的新建（随机 UUID，F20260915midu 语义保持）+ enqueueRetry（bulk）
- 同文档内重复段落：完整三重判据映射到旧 id 队列，命中即 shift consume；两个重复 chunk 各自复用，第二/三轮均零登记
- `replaceEntriesBySource(entries, { reuseEntryIds })`：事务内核实规划复用集与现存行的交集并返回实际复用集；复用 entry 不删不重建（id/created_at 保留），仅 UPDATE metadata
- 并发 reindex 的 stale reuse id 降级为 INSERT；StoreMemory 以实际复用集登记任务，实际未复用的一律 enqueueRetry，杜绝「chunk 删成 0 且无任务恢复」

效果：归档-复活轮（chunk 内容全未变）→ **零重算零任务**；真实文档局部改动 → 仅变更 chunk 重算。

### D. summary 向量保留

`replaceEntryBySource` 同 id 快路径读取旧 content；content 未变且 memory_vec 行存在时保留 vec 并返回 `embeddingKept=true`，StoreMemory 跳过 fireAndForgetEmbed。内容变化或无 vec 时维持既有重算/入队路径。首轮约 1100 篇 summary 复活不再集中挤占 live embedding 通道。

### C. 环境字段漂移的正确性

文档中段插入新段落导致后续 chunk_index 全偏移：复用判据不含 chunk_index，未变段落仍复用；偏移量通过复用 entry 的 metadata UPDATE 落库。fts 不重建（content 不变）、vec 不动（entry id 不变）。

## 修改面

| 文件 | 改动 |
|---|---|
| src/usecases/document/sync-documents.ts | SyncOptions/canonicalRootDir + archiveDeletedDocuments 守卫 + countAbsentDocs + sync_start 日志 rootDir + SyncResult.archiveGuarded |
| src/usecases/memory/store-memory.ts | chunk 三重判据队列复用 + 按实际复用集登记 + summary embeddingKept 跳过重算 |
| src/usecases/memory/memory-writer.ts | replaceEntries 复用 opts/实际复用集返回值 + replaceEntry embeddingKept + findEntries port |
| src/usecases/memory/memory-repository.ts | 同步镜像声明（向后兼容完整接口） |
| src/frameworks/db/memory/sqlite-memory-repository.ts | 事务内核实际复用集/stale 降级 INSERT + summary vec 保留 + findEntries 实现 |
| src/bootstrap/memory.ts / src/app.ts | canonicalRootDir 透传装配 |

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 二次 sync 同输入登记数=0（#1818 验证断言） | 真 sqlite + 真文件系统 + SyncDocuments.execute：首轮后归档再复活强制 reindex，chunk id 不变、pending 零净增；再一次 sync skipped 且 pending 不变 | ✅ |
| 局部修改只重算变更 chunk | 改 1/3 chunk → 仅 1 条登记，其余复用 | ✅ |
| heading_path 变化不复用（三重判据） | content 相同但章节变 → 重新登记 | ✅ |
| 重复段落队列收敛 | 真 sqlite：两个相同 content chunk → 3 个独立 id，第二/三轮 id 全稳定且登记均为 0 | ✅ |
| 并发 stale reuse 不丢数据 | 真 sqlite 强制 A/B 同读旧行后交替替换 → 最终 1 条存活 chunk，且存活 id 有 pending 恢复任务 | ✅ |
| summary 内容未变保留 vec | 真 sqlite+sqlite-vec：第二轮仅 metadata 漂移 → vec 仍在、gateway 零新增调用、pending 0 | ✅ |
| 复用 entry 卫星数据保留 + metadata 更新 | 真 sqlite：fts/weights 计数不变，chunk_index 漂移落库，created_at 保留 | ✅ |
| 非 canonical rootDir 不归档 + archiveGuarded 计数 | DB 有磁盘无 → 不归档，updateStatus 未调用 | ✅ |
| canonical 相等（含尾斜杠差异）正常归档；不传参数保持旧行为 | 归档照常，存量兼容 | ✅ |
| 全量回归 | 修复后工作树：456 个测试文件、5848/5848 用例全绿 | ✅ |

## 验证记录

- 第一轮修复聚焦：store-memory 35/35、store-memory-sqlite-reuse（真 sqlite+vec+完整 SyncDocuments）4/4、sync-documents 14/14、replace-entries-idempotency 8/8、search-memory 39/39
- 修复后全量 `npx vitest run`：456 文件、5848/5848 通过（含完整 SyncDocuments 复活、并发 stale、重复收敛、summary vec 保留回归）
- `npm run build`、`npx tsc --noEmit`、相关 eslint、lint:tests、lint:docs、lint:criteria、lint:evidence-anchors 通过
- #1812 回归确认：embedding-persistent-queue（14 用例含 drain 无界续跑/批量消费/水位闸）、embedding-retry-worker 全绿，通道分离语义未回退

## 排查结论（issue 待查项）

- **15:21/15:23 触发源**：sync 无服务内定时器，全量轮=postListenInit（重启）或 sync_docs 工具调用；案发窗口存在两个进程（pid=39954 主服务 + pid=52090 已死，后者 rootDir 为 939 文档目录）交替写主库。sync_start 日志补 rootDir 后此类问题可从日志直读
- **worker CPU 397%→98%**：397%≈#1812 backfill 4 线程满载，98%≈单线程。最可能为全量重灌轮级联删任务后 claim 退避空转（任务被删→claim 空批→等待 earliestNextRetryAt）；A/B 修复断振荡后预期不再出现，监控验证

## 边界与遗留

- **主库现状修复**：1133 个误归档文档将在修复上线后首轮主仓 sync 复活（status mismatch → update 分支），chunk 内容未变全复用、summary content 未变保留 vec → 两者均零重算，队列零重灌
- **archived 文档的 chunk entries 仍可被检索**（memory_entries 不按 features.status 过滤）——归档语义与检索隔离的缺口，超出本修范围，建议另立 issue
- **监控任务「embedding 排水验收监控」（b1dace6a）**：修复上线排干后按 #1818 关闭标准验收，可删

## 关联

- closes #1818
- 前置：F20261110embrc（PR #1812，排水能力）、F20261109epqst（统一持久队列）、F20261105embqg（水位闸）
