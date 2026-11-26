---
id: F20261126mvhyg
title: memory_vec 孤儿索引审计、安全清理与健康观测
summary: 为 memory_vec 增加无正文只读审计、默认 dry-run 且 apply 前 SQLite 一致性备份的清理工具，补正常删除路径的全卫星回归，并把 total/live/orphan/orphanRatio 接入既有 RHI 快照与日报 overview；不执行真实活库清理。
change_type: feature
doc_type: feature
created_at: 2026-11-26
created_in_conversation: f4402db8-9dee-4979-82b9-f0d46ed4f195
capability_test: "n/a: 纯 A 类 SQLite 运维脚本、删除一致性与健康指标行为，由真实 vec0、临时文件库和全栈 HTTP 测试验证，不新增 LLM 自由行为"
tags: [memory, vector, sqlite, observability, maintenance, safety]
modules:
  - src/frameworks/db/memory/memory-vec-hygiene.ts
  - scripts/audit-memory-vec.mjs
  - scripts/cleanup-memory-vec.mjs
  - src/usecases/health/rhi-scan-worker.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
  - src/app.ts
  - api-contract/api/rhi.ts
intent:
  problem: "memory_vec 中存在大量 memory_entries 已不存在的孤儿向量，但现有投影审计不单独给出该口径，缺少只删孤儿、可备份复验的维护工具和删除路径全卫星回归，日报也无法直接读取孤儿率。"
  expected_effect: "只读审计稳定输出 total/live/orphan/orphanRatio；dry-run 不写库，显式 apply 先完成含 WAL 的一致性备份并在事务内复审 orphan=0；正常 entry 删除不遗留 FTS/Vec/weights 等卫星；RHI 每小时快照与 /api/health/overview 提供四项 vec 卫生指标。"
  verify_by:
    type: behavior_check
    rollback: "revert 本 PR 即可撤回脚本、装配和新增指标；无 schema 迁移。历史 health_snapshots 行可保留。若未来另经批准执行过 apply，数据回滚必须恢复当时备份，代码 revert 不代替数据恢复。"
    risk_note: "真实主库只允许只读审计；本 PR 的 apply 验证仅限 /tmp 临时库。清理不承诺文件缩小或固定延迟收益，历史成因与检索参数调整不在本 PR。"
---

# memory_vec 孤儿索引审计、安全清理与健康观测

## 背景与实施基线

- 实施基线为 `origin/main@5e9bf565`；`F20261124mvcas` 的提交 `e5ed5232` 已是当前 HEAD 祖先，代际 sidecar 与 CAS 代码在基线内，不需要重复实现或错开在途文件。
- 2026-11-26 08:38（Asia/Shanghai）对主库执行新工具的只读审计：`total=153101`、`live=69865`、`orphan=83236`、`orphanRatio=0.5436672523366928`。活库持续变化，这些数字只代表该次查询快照。
- 既有 `audit-memory-projection.mjs` / `cleanup-memory-projection.mjs` 处理 entries→memory 的投影政策、缺失与正文纠偏；`cleanup-memory-pollution.mjs` 清理污染记忆本体。它们都不等同于「只清 memory_vec 中主 entry 已不存在的行」。

## 目标与非目标

### 目标

1. 加载 sqlite-vec 后，以 `memory_vec.memory_entry_id` 在 `memory_entries.id` 中不存在为唯一孤儿口径，输出 `total/live/orphan/orphanRatio`，不输出正文。
2. 默认 dry-run 只读；只有显式 `--apply` 才写。apply 前用 `better-sqlite3 db.backup()` 做 SQLite 一致性备份，单事务删除并复审孤儿为零。
3. 锁定正常删除路径的 FTS、Vec、weights、代际 sidecar、任务和关系边一致性，保留无关 entry。
4. 复用既有 RHI 小时扫描、`health_snapshots` 和 `/api/health/overview`，让现有日报直接取得孤儿率，不新增调度。

### 非目标

- 不对真实主库执行 `--apply`，不删除任何原始消息、事实、文档或仍存活的 memory entry。
- 不修改检索排序、Vec 池深、模型、embedding 并发、定时任务或 scheduled prompt。
- 不在线 VACUUM，不承诺空间回收或固定毫秒收益；不实施 Phase B/C/D。
- 不凭当前数据反推历史根因，不重写正常 writer，不新增守护进程、自动清理或自动 issue。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 审计/清理共用口径 | 一个小型 `memory-vec-hygiene` 模块，两个薄 CLI 入口 | 扩写投影污染清理或复制两份 SQL | 清理对象不同，避免把 vec 卫生混入正文投影政策；同一函数保证 dry-run、apply、RHI 口径一致 |
| 备份 | apply 前 `db.backup()`，拒绝覆盖已有备份 | `cp` 活库主文件 | SQLite 在线备份包含 WAL 中已提交数据；临时库实测备份含 WAL-only entry 和清理前孤儿 |
| 删除 | 单事务集合删除，同事务前后审计，after.orphan 非零即回滚 | 逐 ID 调 repository 级联 | 主 entry 已不存在，无需逐条级联其它卫星；集合操作避免 N+1，且只写 memory_vec |
| 健康观测 | 在既有 RHI scanOnce 中采集并落四行快照，overview 增加四个只读键 | 每次 `/api/health/memory` 请求都实时全扫 vec0 | 日报已经读取 overview；复用小时扫描避免 HTTP 请求路径重复 O(total) 审计，不新增 timer |
| 阈值 | ratio 行 metadata 记录 warning=5%、alert=20% | 新增信号、自动立案或自动清理 | 当前只提供观测事实，阈值是日报判读初值，不替搭档做处置决策 |
| 防复发 | 正常删除回归 + 持续指标 | 宣称一次性清理已根治 | 历史成因未查明；测试防正常删除回退，指标用于发现复发，二者都不证明所有历史路径已穷尽 |

### 机制判定

本变更触及新的显式运维入口和指标字段，但没有新增自动决策、持久化 schema、调度器、writer 分支或运行时检索语义；它是在既有投影维护与 RHI 传感器语义内补 vec 对账，因此 `Modification-Class: narrow-fix`。清理只能由人显式执行，观测只降低信息成本，决策归属不变。

### 最简实现检查

已过最简实现阶梯：复用已安装的 better-sqlite3、sqlite-vec、现有 `RhiScanWorker`、`HealthSnapshotRepository`、overview 序列化和 `createTestDb`；没有新依赖、新表、新 worker、新配置或通用清理框架。既有 projection cleanup 的对象与事务语义不同，复用它会扩大其职责，故只共享底层数据库惯例而不强行合并且前不相同的政策。

## 删除一致性覆盖与防复发边界

- 既有 `tests/frameworks/db/memory-projection-maintenance.test.ts` 已覆盖 `deleteEntryProjection` 对 external entry 的 entries/FTS/Vec/weights/task/edge 联动清理，本 PR 不重复添加同路径用例。
- 新增 `tests/frameworks/db/memory/delete-consistency.test.ts` 覆盖公开正常路径 `deleteBySource`：目标 entry 的 entries、FTS、Vec、weights、`memory_vec_generations`、embedding task 和 edge 全部消失，另一 source 的 entry 与各卫星保留。
- `SqliteMemoryRepository` 当前正常删除路径统一经过 `cascadeDeleteSatellites`；本 PR 没有改写该实现，因为新增回归在当前代码上通过，不能把历史孤儿直接归因于它。
- **历史成因待查**：旧批量路径、历史降级/晚到回调等是否贡献过孤儿，需要独立 git 历史与数据代际调查。本 PR 的防复发边界是「正常删除回归 + 既有日报观测」，不是根因结案，也不是反复自动删除托底。

## 健康指标契约

RHI 每次扫描在 vec 审计可用时追加 `metric_type=memory_vec` 的四行：

| metric_key | overview camelCase | 含义 |
|---|---|---|
| `memory_vec_total` | `memoryVecTotal` | vec 总行数 |
| `memory_vec_live` | `memoryVecLive` | 有对应 entry 的行数 |
| `memory_vec_orphan` | `memoryVecOrphan` | 无对应 entry 的行数 |
| `memory_vec_orphan_ratio` | `memoryVecOrphanRatio` | orphan / total；total=0 时为 0 |

审计失败只缺席本轮四项指标并记录 warn，其它健康快照继续。指标是小时级快照而非实时计数；既有手工 HealthReport CLI 不采集本项，如它在 RHI 后覆盖同日全量行，本项会等下一次 RHI 扫描恢复，这是复用现有快照所有权的已知时效边界。

## 影响与风险

| 风险/代价 | 处置 |
|---|---|
| 审计是 O(total vec) 的主键对账 | 只挂在既有小时扫描和显式 CLI，不放在每次健康 HTTP 请求中 |
| apply 与活跃 writer 并发可能再次出现孤儿 | 工具保证事务结束复审为 0，不承诺之后永为 0；真实执行仍需另批维护窗口，复发先查因 |
| 备份占用额外磁盘 | 默认带时间戳、拒绝覆盖；实际执行前另查磁盘并保留恢复文件 |
| 观测不等于告警处置 | 阈值仅作元数据，日报读取后按既有分级处理，不自动立案 |
| 清理收益随数据与查询变化 | 只声明移除无效扫描；性能前后测量留待固定快照评测，不外推固定提速 |

## 回滚

- 代码：revert 本 PR，无 schema 或数据迁移；历史 `health_snapshots` 可保留，后续 RHI 不再新增本项。
- 数据：本 PR 未对真实主库 apply，无生产数据回滚动作。未来另经批准的真实 apply 若需撤销，必须在维护窗口恢复该次 `backupPath`，不能用代码 revert 冒充数据恢复。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 只读审计 | 对含 live/orphan 的 `/tmp` vec0 DB 运行 audit CLI | JSON 仅含模式、路径和四项计数；比例正确、无正文、孤儿保留 |
| dry-run 零写入 | 对同一 DB 运行 cleanup 默认模式 | 输出 `mode=dry-run`，源库行不变，不创建备份 |
| apply 参数护栏 | 分别触发 `--backup` 无 apply、backup=源库、备份已存在 | 三种调用均非零退出；源库 live/orphan 不变，已有备份正文不被覆盖 |
| 一致性备份与 apply | WAL 中写入 live entry 后，指定 `/tmp` backup 运行 `--apply` | 备份含 WAL-only entry 与清理前孤儿；源库 `after.orphan=0`，live entry/vec 全保留 |
| 幂等 | 对已无孤儿 DB 再调清理函数 | `deleted=0`，after 与之前一致 |
| 正常删除 | 经 `deleteBySource` 删除带全卫星的 entry | 目标全卫星消失，无关 entry/FTS/Vec/weights/sidecar 保留 |
| 日报可获取 | 全栈触发既有 RHI scan，再 GET `/api/health/overview` | metrics 含四个 camelCase 键；空库值为 0 |

## Verification

### 当前机器证据

- `npx tsc --noEmit`：通过。
- `npm run build`：通过；首次因 worktree 未安装 `@earendil-works/pi-durable` 停在依赖检查，补齐 worktree 依赖后同一命令完整通过，含 connector closure/package。
- `npx vitest run tests/frameworks/db/memory/memory-vec-hygiene.test.ts tests/frameworks/db/memory/delete-consistency.test.ts tests/frameworks/db/memory-projection-maintenance.test.ts`：3 文件、5 用例通过。
- `npx vitest run tests/usecases/health/rhi-scan-worker.test.ts`：12 用例通过。
- `npx vitest run tests/scripts/memory-vec-hygiene.test.ts tests/app/build-app.test.ts`：首轮 2 文件、11 用例通过；含真实子进程、`/tmp` 文件库、WAL 备份和全栈 overview 断言。
- 对抗审视补强三条 apply 参数护栏后，`npx vitest run tests/scripts/memory-vec-hygiene.test.ts`：**5 用例通过**，逐项覆盖 `--backup` 无 apply、backup=源库、拒绝覆盖已有备份，并回读源库不变及已有备份正文不变；该文件 ESLint 通过。
- 主库只读命令 `node scripts/audit-memory-vec.mjs --db=/Users/orca/ai/otter-buddy/data/otter-buddy.db` 成功返回上述 153101/69865/83236 快照；未运行主库 apply。
- `npx vitest run`：全量 **545 文件 / 6941 用例通过**，命令退出码 0；完整输出见对话工作区 `evidence/mvhg-full-test.log`。
- `npm run lint`、`lint:intent`、`lint:schema`、`lint:tests`、`lint:docs`、`lint:capability`、`git diff --check` 均通过；部分 lint 有警告输出但退出码为 0，本项只声明命令通过，不据此判断警告归属。完整 ESLint 与 intent 输出见 `evidence/mvhg-lint.log`、`evidence/mvhg-lint-intent.log`。
- Golden Gate：n/a（纯 A 类确定性代码，无 prompt/skill/tool description 行为变更）。

### 负面向验收

- 没有改动 `search-memory.ts`、`search-engine.ts`、Vec 池深、模型或 worker 并发；没有改变定时任务和 scheduled prompt。
- 没有破坏旧契约：RHI 原有键和行保持不变，未注入 vec audit 的调用方仍产原行集；正常删除仍走原 repository 事务。
- 没有绕过保护：dry-run 使用 readonly；apply 必须先备份；备份路径不得等于源库或覆盖既有文件；清理事务复审失败会回滚。
- 没有新增旧文件/配置退役，无废弃资源需要清理；lockfile 最终无变更。

## 未执行事项

- 未对真实主库执行清理、VACUUM 或任何写删；实际 apply 仍需搭档明确批准与维护窗口。
- 未做 k=10/20/50 或端到端检索测速，未改任何检索参数；这些属于后续固定快照评测。
- 未宣称历史根因已查明，未实施 Phase B/C/D。
