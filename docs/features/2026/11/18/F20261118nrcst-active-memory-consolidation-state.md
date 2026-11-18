---
id: F20261118nrcst
title: 夜间审视治量结构（P2b1：consolidation_state 区间幂等 + belief 区间查询）
doc_type: feature
summary: |
  「主动记忆层」P2b 的第一刀（治量结构），为夜间审视调度编排打地基。新增 consolidation_state 表：
  幂等键 review:{date}:{taskId}（撞键返回上次成功变更集，解决「LLM 重跑两次产出必不同」的判重问题）；
  failed_range=[failed_after, failed_through] 是区间不是点，连败计数绑定该区间（换区间计数清零，
  重跑只重做这个区间）；result_json 非空 = 已 settle。另在 MemoryReader/MemoryRepository 增
  listBeliefsByStatus(status, after, through)：按生命周期状态 + 创建时间闭区间列当日 belief 清单，
  是夜审任务「读当日 recorded 清单」的数据源。
change_type: feature
intent:
  problem: "夜间审视（P2b2）是 LLM 会话，重跑两次产出必不同——崩溃/停机重跑若没有存档点判重，要么重复审视（可能重复迁移/重复建边），要么丢审（该核实的没核实）；连败若绑定「单个失败点」而非区间，水位前移一次重跑就会重新撞同一批失败。此外当前无直接按状态+时间区间列 belief 的读口，夜审清单只能用 search_memory 的 FTS 语义近似，不精确。"
  expected_effect: "同一 (审视日, 任务) 只允许一份成功变更集（result_json 落盘后 claim 撞键直接返原结果，不重跑）；失败连败绑定 failed_range 区间、达 3 次同区间连败返回 shouldSkip（P2b2 编排侧据此跳过+报 healing）；listBeliefsByStatus 精确返回 [after, through] 内指定状态的 belief 条目（created_at 升序）。"
  verify_by:
    type: behavior_check
    note: "单测钉住：实体（buildReviewKey 形态边界 fail-closed、parseReviewKey 回解、半空区间一致性）；usecase（claim 撞键返原结果、complete 清零、recordFailure 同区间连败+异区间重置+达阈值跳过）；SQLite 表（save upsert 幂等、CHECK 拒半空区间、getByKey 往返）；listBeliefsByStatus（状态过滤、时间闭区间、升序、非 belief 不命中）。"
capability_test: "n/a: 本刀是治量结构（表+usecase）+ 读口，无编排行为；行为门禁为新增单测（实体 9 + usecase 12 + repo 4 + 读口 6 = 31 项）。编排消费在 P2b2。"
created_at: 2026-11-18
created_in_conversation: 82f71e1a-a8b0-4e0f-916e-5e219624483c
causal_links:
  from: [F20261118nrwht]
tags: [memory, belief, active-memory, night-review, idempotency, consolidation, scheduler]
modules:
  - src/entities/memory/consolidation-state.ts
  - src/usecases/memory/consolidation-state-repository.ts
  - src/usecases/memory/manage-consolidation-state.ts
  - src/frameworks/db/memory/sqlite-consolidation-state-repository.ts
  - src/frameworks/db/schema.ts
  - src/usecases/memory/memory-reader.ts
  - src/usecases/memory/memory-repository.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/bootstrap/types.ts
  - src/bootstrap/repositories.ts
  - src/bootstrap/usecases.ts
---

# 夜间审视治量结构（F20261118nrcst）

> **定位**：P2「夜间审视」的第二刀的第一段（治量结构），承接 P2a（F20261118nrwht，受限写者獭档案）——
> night-reviewer 獭的「身份」已就绪，本刀把它的「档案点」落地。P2b2（调度编排 + 獭召唤 + fyi 否决锚）直接消费本刀接口。

## 背景

P2b 要做的夜间审视是**非确定性进程**：开一个 LLM 会话读当日 recorded belief 清单、逐条核对原文并迁移状态。非确定性带来两个治理问题（otter-memory-design v4 §4.4「治量结构 > 内容」）：

1. **判重**：LLM 重跑两次，产出（迁移了哪些 belief、建了哪些边、把哪些 reject 掉）必不同。崩溃/停机重跑若没有存档点，要么重复审视（重复迁移/重复建边），要么丢审（该核实的没核实）。
2. **连败治理**：审视中途挂了，重跑从哪继续？连败若绑定「单个失败点」，水位每前移一次就重新撞同一批失败；「区间不是点」的语义是：连败绑定 `[after, through]` 区间，换区间计数清零，重跑只重做这个区间。

## 方案

### 1. 实体与幂等键（consolidation-state.ts）

- `buildReviewKey(date, taskId)` → `review:{date}:{taskId}`：date 必须 YYYY-MM-DD（fail-closed），taskId 必须非空（防空 taskId 让不同任务撞上同一份「原结果」）。
- `parseReviewKey(key)` 回解：date 与 taskId（taskId 可含冒号），非法返回 null。
- `newConsolidationState(key, now)`：空白档（failures=0、无失败区间、无结果）。
- `MAX_CONSECUTIVE_FAILURES = 3`：同区间连败达阈值判定跳过。

### 2. consolidation_state 表（schema.ts）

```sql
CREATE TABLE IF NOT EXISTS consolidation_state (
  review_key TEXT PRIMARY KEY,
  failed_after TEXT,
  failed_through TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((failed_after IS NULL) = (failed_through IS NULL))
);
```

- `review_key` 主键：一行一档。
- `failed_after`/`failed_through`：失败区间（区间不是点，两端同空或同非空——CHECK 兜底「半空区间」这类写入错误）。
- `failures`：绑定当前失败区间的连败计数。
- `result_json`：上次成功变更集（JSON 序列化）。非空 = 已 settle。

新表只写 schema.ts 一处（#506：bootstrap 无条件幂等 `initSchema`，老库自动补建，无需 migration.ts 誊抄）。

### 3. usecase（manage-consolidation-state.ts）

`ManageConsolidationState` 只回答三个问题：

| 方法 | 语义 |
|---|---|
| `claim(reviewKey)` | 建档或取档。`settled = resultJson !== null`——撞键直接返原结果，不重跑；未 settle 时返回 `failingRange`（上次失败区间）与 `failures`（连败数），编排侧据此决定从哪继续。 |
| `complete(reviewKey, resultJson)` | 写存档点 + 清零失败区间/连败。该档自此 settle。 |
| `recordFailure(reviewKey, after, through)` | 同区间（after/through 与上次一致）连败 +1；异区间重置为 1。返回 `{ failures, shouldSkip }`，`shouldSkip = failures >= MAX_CONSECUTIVE_FAILURES`。 |

读改写都在单实体上做（read → mutate → save），SQLite 单写者下无并发窗口。

### 4. belief 区间查询（listBeliefsByStatus）

`MemoryReader`/`MemoryRepository` 新增：

```ts
listBeliefsByStatus(status: BeliefStatus, after: string, through: string): Promise<MemoryEntry[]>
```

- 状态在 metadata JSON 内，用 `json_extract(metadata, '$.status')` 匹配；
- 时间闭区间 `[after, through]`，`created_at` 升序（按现场时间先后审视）。

这是 P2b2 夜审任务「读当日 recorded 清单」的精确数据源（对比 search_memory 的 FTS 近似语义，本方法 exact-match）。

## 设计取舍

1. **治量状态只做「archive 点」不做「任务状态机」**：任务执行的 running/completed 归 scheduled-task 执行记录管，consolidation_state 只存「这次审视的变更集存档 + 失败区间水位」，职责不重叠。若把执行生命周期也塞进来，幂等键会被 running 态污染（撞键时无法区分「还在跑」与「已成功」）。
2. **区间连败 vs 单点连败**：失败绑定区间。夜审是 batch 进程，失败通常不是单条 belief 的问题，而是某个时间段一片数据的问题；绑定单点会让重跑反复撞同一点。绑定区间后水位前移即清零。
3. **result_json 非空 = 已 settle**：不另设 status 列。错误状态的数量越少，状态机越不容易出现非法组合；「有结果 = 完成」是单一直值。
4. **幂等键含 taskId**：同一天可能有多个审视任务（同一任务重跑、不同任务复盘）。date 维度隔离「哪天」，taskId 维度隔离「哪个任务」，二者组合才是完整幂等域。

### 设计取舍（mechanism-addition 四问）

> 审-1943 首轮 S1：新增持久化存储机制需答复四问（谁需要 / 失败后果 / 后续机制 / 退役条件）。

1. **谁需要它？** P2b2 夜间审视调度编排。没有存档点，非确定性 LLM 会话重跑必重复迁移/重复建边或丢审——这是夜间审视能否被信任的前提。
2. **失败后果？** 本刀被跳过（P2b2 永不接入），consolidation_state 成为死表（零写入零消费），夜间审视无从判重——但主链路（检索/记录/迁移工具）零影响，最坏只是 P2b2 无法开工。
3. **后续机制？** P2b2 编排消费 claim/complete/recordFailure；同区间连败达 MAX_CONSECUTIVE_FAILURES → 跳过 + 报 healing（编排侧）；停机错过 → 打开后按旧水位补跑（#814 迟到补跑对账）。
4. **退役条件？** 夜间审视整体下线时，consolidation_state 与 otter_configs 的 night-reviewer 档案一起退役；表无 FK 入边、无索引依赖，可整体 DROP，无需迁移任何数据。

## 验证

- 单测共 31 项（实体 9 + usecase 12 + repo 4 + 读口 6），全部通过（在 worktree 内跑）。
- `npx eslint`（改动文件）、`lint-schema-ddl`、`lint-tests`、`npx tsc --noEmit` 全绿。
- `tests/frameworks/db/memory/` + `tests/usecases/memory/` 全量 343 项通过（无回归）。