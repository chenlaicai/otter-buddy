---
id: F20260803mval
title: memory-validator-link-integrity
doc_type: feature

summary: |
  从理想状态重构记忆系统文档校验全链路。三层防线同步放宽：validator 移除枚举白名单（只留结构校验）、DB 移除 features/research 表的 CHECK 约束（表重建迁移）、known-values.ts 作单一真相源驱动类型/校验/前端。sync 从 insert-only 改 upsert（内容指纹变则 update）解决"文档改了内容 DB 不更新"的漂移断裂。reconcileSync 正向对账比 ID+内容指纹。embedding worker error 重置 ready 修健康判定不可信。失败可见性双通道：搜索 API 内联 degraded 标志（搜时即感知"结果可能不完整"）+ 独立健康端点（完整诊断）。起因：用户搜"提示词优化"无果，排查发现 validator/DB CHECK 双层拒收 41 文档、正文不索引、embedding 静默降级、无对账四重断裂。经两轮独立 agent 对抗审视，命中 DB CHECK 与内容漂移两个阻断级遗漏。

causal_links:
  from:
    - F20260713m5q3   # domain-memory：记忆系统基础，校验链路是它的入口防线
    - F20260721qh74   # document-data-model：文档数据模型，validator 守护其完整性
    - F20260724skch   # skill-tool-channel-consolidation：信道分层--硬规则 vs 软约定的分层同构
    - F20260730heal   # self-healing-system：对账 + 健康可见性是 self-heal 思想在记忆链路的应用
    - F20260728htar   # html-card-dual-speak-format：表重建迁移的先例（messages_fts rebuild）

status: development
change_type: fix
tags: [memory, validator, document-sync, observability, link-integrity, db-migration, upsert, health-endpoint]
modules:
  - src/entities/document/known-values.ts
  - src/entities/document/feature.ts
  - src/entities/document/research.ts
  - src/entities/document/frontmatter-validator.ts
  - src/usecases/document/frontmatter-parse.ts
  - src/usecases/document/sync-documents.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - src/frameworks/embedding/embedding-service.ts
  - src/interface-adapters/http/controllers/health-controller.ts
  - src/interface-adapters/http/router.ts
  - src/usecases/memory/search-memory.ts
  - web/src/pages/memory/index.tsx

created_at: 2026-08-03
---

# F20260803mval 记忆系统校验链路完整性

## 背景

### 问题

用户在 web 记忆页用《提示词优化》搜索，零结果；用《罗密欧》能搜到对话消息。排查后确认是记忆系统"文档 -> 记忆 -> 搜索"链路的**四重断裂**叠加：

```
磁盘 .md
  -> 解析 frontmatter
  -> validator 校验        ← 断点1: 枚举过期，41/85 文档静默跳过
  -> DB CHECK 约束         ← 断点1b: 第三道关卡，validator 放行 DB 照样拒（对抗审视命中）
  -> features 表
  -> memory_entries/fts    ← 断点2: 只索引 summary，正文不进 fts
  -> (异步) memory_vec     ← 断点3: embedding fetch failed，vec 路永远空
  -> 搜索                   ← 断点4: 无正向对账，断裂不可见
                            ← 断点5: 幂等 skip，文档改内容 DB 不更新（对抗审视命中）
```

| 断点 | 表现 | 性质 |
|------|------|------|
| 1. validator 硬卡过期枚举 | 41 个文档静默跳过 | 校验过严 + 枚举与工作流脱节 |
| 1b. DB CHECK 约束 | validator 放行后 DB INSERT 仍拒收 | 第三道关卡，与 validator 同步过期 |
| 2. indexFeature 只传 summary | 正文不进 fts | 索引不完整（本 F 不修，健康端点让其可见） |
| 3. embedding fetch failed | vec 路永远空 | 静默降级（本 F 不修，健康端点让其可见） |
| 4. 无正向对账 | 只检测"DB 有文件无"归档 | 断裂不可见 |
| 5. 幂等 skip 内容漂移 | 文档改内容 DB 不更新，对账只比 ID 不比内容 | "搜不到新内容"的隐形断裂 |

**根本病因**：每一跳失败都没有向上可见，只能靠人翻日志发现。枚举值（validator 的 `["feature","refactor","fix"]` / DB CHECK 的同款 / `feature.ts` 类型定义）是工作流状态的投影，工作流天然演进（凭空多了 `prompt/bugfix/feature-update`、`final/implemented/design/proposed`），三处硬编码必然同步过期。

### 设计目标

- **全链路不断裂**：文档到搜索每一跳要么全成功，要么失败可见。
- **校验不挡合法演进**：工作流状态新增不该触发代码/DB 改动。
- **失败可观测**：同步错误、embedding 降级、内容漂移进健康端点 + 搜索降级标志，不靠人翻日志。
- **单一真相源**：枚举值定义一处（known-values.ts），类型/校验/前端全引用，DB 不再做枚举约束。

## 变更

### 1. 移除 DB CHECK 约束（表重建迁移）

`schema.ts:413-414` 的 `CHECK(change_type IN (...))` 和 `CHECK(status IN (...))` 是第三道关卡，与 validator 同步过期。SQLite 不支持 `ALTER TABLE DROP CHECK`，必须重建表。

迁移逻辑加到 `migration.ts`，幂等键用 settings 表 `features_check_dropped=done` / `research_check_dropped=done`：
```
CREATE TABLE features_new（同结构但无 CHECK 约束）
INSERT INTO features_new SELECT * FROM features
DROP TABLE features
ALTER TABLE features_new RENAME TO features
重建索引
```

research 表同法。参照 F20260728htar 的 `rebuildMessagesFtsStripped` 先例（单事务 + settings 幂等键）。

**为什么移除而非改为新枚举**：DB CHECK 与应用层枚举同步是长期维护负担--每次加值都要重建表迁移，成本极高且易错。移除后 known-values.ts 成为真正单一真相源，应用层校验足够。

### 2. validator 移除枚举白名单校验

`ValidationResult` 接口升级：
```typescript
export interface ValidationResult {
  valid: boolean;
  errors: string[];      // 结构校验，阻断入库
  warnings: string[];    // 未知枚举值等，不阻断但上报
}
```

- **结构校验（硬，errors）**：id 格式、title/summary 非空且 trim 后非空、summary 长度 [1,500]、文件路径与 ID 日期一致、frontmatter 存在。
- **语义校验（移除白名单，改为上报）**：change_type/status 不在 KNOWN_* 列表时，写入 `warnings` 但 `valid=true`。warnings 不进 logger 黑洞，而是进 SyncResult 持久化到健康端点（见变更 7）。

**为什么移除白名单而非 warn 不 block**：warn 不 block + 没人看 = 虚假安全感（对抗审视命中）。让 unknown 值通过 SyncResult.warnings 进健康端点暴露，才有真实可见出口。

### 3. 单一真相源 known-values.ts

新建 `src/entities/document/known-values.ts`：
```typescript
export const KNOWN_CHANGE_TYPES = ["feature","refactor","fix","prompt","feature-update"] as const;
export const KNOWN_FEATURE_STATUSES = ["draft","proposed","design","development","locked","final","implemented","archived"] as const;
export const KNOWN_RESEARCH_STATUSES = KNOWN_FEATURE_STATUSES;
export const KNOWN_EXPLORATION_TYPES = ["technical","market","user-research"] as const;
export type ChangeType = typeof KNOWN_CHANGE_TYPES[number];
export type FeatureStatus = typeof KNOWN_FEATURE_STATUSES[number];
```

`feature.ts`/`research.ts` 类型改为从这里派生。validator 引用 KNOWN_* 做"是否未知值"判定（写 warnings）。前端展示引用同一常量。

### 4. ID 正则 {3,8}

```typescript
// 旧：/^F\d{8}[a-z0-9]{4}$/   恰好 4 字符
// 新：/^[FR]\d{8}[a-z0-9]{3,8}$/
```

数据支撑：实际范围 3-5（`mmr`=3、`guard`=5）。下界 3 覆盖最小实例，上界 8 留余量但不放纵。

### 5. 边界 case 修复

- **BOM strip**：`frontmatter-parse.ts` 入口 `content.replace(/^\uFEFF/, "")`，防 UTF-8 BOM 导致 "Missing frontmatter"。
- **title trim 校验**：`title: "   "` 纯空格不再通过，与 summary 一致做 trim 非空。
- **supersedes 引用检查**：reconcileSync 阶段检查 supersedes 引用的 ID 是否在 dbIds，不在则 warning。
- **buildFeatureDocument 未知值 fallback**：未知 change_type 不直接 `as ChangeType` 强转，fallback 到 `"feature"` 并记 warning，防类型安全形同虚设。

### 6. sync 改 upsert 解决内容漂移

当前 `sync-documents.ts:111` ID 存在就 skip，不比内容。改为：
```
existing = findById(id)
若不存在：insert
若存在但内容指纹(hash of summary+title+changeType+tags+modules) 变了：update + 重新 indexFeature
若存在且指纹相同：skip（真幂等）
```

**为什么纳入本 F**：不修则"文档改内容后搜不到新内容"的断裂仍在，validator/DB 放宽后文档能首次入库，但后续修改永远不更新，根因不除。

### 7. SyncResult 持久化 + 健康端点

SyncResult 持久化到 settings 表（JSON 序列化，key=`last_sync_result`）。健康端点 `GET /api/health/memory` 聚合：
```json
{
  "documentsOnDisk": 85, "documentsInDb": 46,
  "lastSyncErrors": 0, "lastSyncWarnings": 3,
  "lastSyncErrorFiles": ["F...", ...],
  "embeddingAvailable": false, "embeddingModel": "Xenova/bge-m3",
  "vecRowCount": 0, "memoryEntryCount": 145,
  "reconcileGaps": 0, "staleDocuments": 2
}
```

健康端点自身有 try-catch 兜底，DB 查询失败也返回 `{"healthy":false,"error":"..."}` 而非 500。

**为什么 settings 表 JSON**：简单；sync 成功才能写 settings，失败时健康端点读不到=显示"未知"也是合理降级。

### 8. 搜索 API 内联 degraded 标志

搜索结果 `total === 0` 或 reconcileGaps > 0 时，响应附 `degraded: true` + `degradedReason`（如"部分文档未索引/语义检索不可用"）。用户搜索时刻即感知"结果可能不完整"，不需额外请求。

**为什么内联 + 端点双通道**：独立端点让降级与搜索分离，用户搜时看到有结果返回会误以为系统正常（"看起来可用但结果不完整"最危险）。内联让用户在决策时刻就感知。

### 9. embedding worker error 重置 ready

`embedding-service.ts` worker `on('error')` 当前清空 pendingRequests 但不重置 `readyState.ready`。改为重置 `ready=false`，健康端点的 `embeddingAvailable` 配合最近一次 embed 请求成功/失败交叉验证，避免 worker 崩溃后 ready 仍 true 的误报。

### 10. reconcileSync 正向对账

`SyncDocuments.execute` 中，在 `archiveDeletedDocuments` **之前**执行（共享一次 findAll() 结果避免重复全表扫描）：
```
diskIds = 扫描磁盘得 ID 集合
dbDocs = findAll()（非 archived）
missingInDb = diskIds - dbIds          // 同步失败，上报
staleDocuments = 内容指纹不一致的       // 漂移，upsert 应已修复，此处兜底上报
supersedes 悬空引用                      // 引用不存在的 ID，warning
```

### 11. bugfix -> fix 统一

sed 批量改 16+ 文档 `change_type: bugfix` 为 `change_type: fix`。DB CHECK 下 bugfix 本就进不了库，"保留两者合法"是空话。统一消除下游歧义。

## 设计决策

1. **移除 DB CHECK 而非改为新枚举**（审视调整）：原设计未考虑 DB CHECK。审视命中后，改为移除让 known-values.ts 真正单一源。代价：表重建迁移，但参照 F20260728htar 先例可控。

2. **validator 移除枚举白名单，unknown 进 SyncResult 上报**（审视调整）：原设计"分层 warn 不 block"。审视指出 warn 没人看=虚假安全感。改为移除白名单 + unknown 值进 SyncResult.warnings 持久化到健康端点，才有真实可见出口。

3. **upsert 纳入本 F**（审视调整）：原设计 insert-only。审视命中内容漂移断裂。不修则根因不除。

4. **ID 正则 {3,8}**（审视调整）：原设计 {2,10} 拍脑袋。审视统计实际范围 3-5，改为 {3,8} 有数据支撑。

5. **bugfix/fix 统一为 fix**（审视调整）：原设计保留两者合法。审视指出 sed 成本极低 + DB CHECK 下 bugfix 进不了库。统一消除下游歧义。

6. **降级可见性双通道**（审视调整）：原设计独立健康端点。审视指出降级与搜索分离会误导用户。改为搜索 API 内联 degraded（搜时即感知）+ 健康端点（完整诊断）双通道。

7. **reconcileSync 在 archiveDeleted 之前 + 共享 findAll + 比 ID+内容指纹**（审视调整）：原设计末尾执行只比 ID。审视指出内容漂移盲区 + 重复扫描。改为前置 + 共享查询 + 指纹比对。

8. **embedding worker error 重置 ready**（审视新增）：原设计未考虑。审视指出 worker 崩溃后 ready 仍 true 不可信。

9. **SyncResult 持久化 settings 表 JSON**（审视补全）：原设计悬置"settings 表或独立 health 表"。审视指出不能悬置。定为 settings 表 JSON。

10. **正文索引/embedding 不在本 F**：本 F 聚焦 validator + 链路可见性。正文索引（Task B）与 embedding 离线（Task C）是独立变更，在各自 PR 创建 F 文档，Issue #124 作跟踪锚点。健康端点让这俩断裂可见，即使暂不修也能暴露。

## 对抗审视记录

本设计经两轮独立 agent 对抗审视，命中两个阻断级遗漏（已纳入变更）：

- **阻断1：DB CHECK 约束**（schema.ts:413-414）--validator 放行后 DB INSERT 仍拒收，核心承诺空转。两 agent 独立命中。调整：变更 1 移除 DB CHECK + 表重建迁移。
- **阻断2：幂等 skip 内容漂移**--sync ID 存在就 skip 不比内容，reconcileSync 只比 ID 不比指纹。调整：变更 6 改 upsert + 变更 10 对账比指纹。

其余审视意见（warn 静默、健康端点元问题、embeddingAvailable 不可信、BOM、title trim、supersedes 悬空、ID 范围、bugfix/fix 统一）已分别纳入对应变更/决策。

## PR 代码评审落地差异（第三轮审视）

PR #128 经代码评审 agent 审视，命中 4 个真 bug（已修）+ 若干设计偏差（据此回写）。

**真 bug（已修）**：
- C2 `deleteBySource` 无条件删 memory_vec，vec 扩展不可用时炸 → 删除前检查 `this.hasVec`
- C3 embedding worker error 重置 ready 但未设 loadError，`waitForReady` 永久挂起 + waiters 泄漏 → 补设 loadError + 拒绝 waiters
- C1 `buildFeatureDocument` 未知 change_type 仍 `as` 强转 → 改 `isKnownChangeType` 检查后 fallback "feature"
- S1 健康端点 catch 返回 500 → 改 200 + `healthy:false`

**设计偏差（实现调整，本文档据此回写）**：
- 变更 7 SyncResult 持久化 → 实施时改为健康端点**实时查询**（磁盘 vs DB + embedding 状态），不持久化 SyncResult。理由：实时查询避开"sync 失败则持久化也失败"的共同失败模式。`lastSyncErrors` 等历史字段不提供，仅当前态。
- 变更 8 degraded 条件 → 实现为 `total===0 && !embeddingAvailable`（controller 无 reconcileGaps 数据，因 SyncResult 不持久化）。原承诺的 `reconcileGaps>0` 条件待持久化后再启。
- 变更 10 reconcileSync → `staleDocuments`（内容指纹对账）未单独实现，由变更 6 upsert 兜底（指纹变则 update）。reconcileSync 只做 missingInDb + supersedes 悬空。
- 变更 10 "共享 findAll" → 实施时 reconcileSync 与 archiveDeletedDocuments 各自 findAll（文档量小，性能可接受）。
- 涉及文件表 → degraded 标志实现在 `memory-controller.ts`（非 `search-memory.ts`）。

**追加修复（用户要求 PR 完整，不留后续）**：
- B2 upsert 非原子 → 新增 `MemoryRepository.replaceEntryBySource` + `StoreMemory.replaceBySource`，单事务内删旧+插新；`indexFeature`/`indexResearch` 改用此原子路径，`MemoryIndexAdapter` 不再注入 memoryRepo

**测试覆盖（全部补齐）**：
- migration 表重建幂等测试（3 个：移除 CHECK + 数据完整、幂等、全新库）
- sync-documents 行为测试（5 个：新文档/内容变 upsert/内容不变 skip/未知枚举 warnings/supersedes 悬空）
- health-controller 测试（4 个：healthy=true、reconcileGaps、embedding 不可用、DB 异常 200）

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/entities/document/known-values.ts` | 新增：KNOWN_* 常量 + 派生类型 |
| `src/entities/document/feature.ts` | ChangeType/FeatureStatus 从 known-values 派生 |
| `src/entities/document/research.ts` | 同上 |
| `src/entities/document/frontmatter-validator.ts` | 移除枚举白名单、ValidationResult 加 warnings、ID 正则 {3,8}、title trim |
| `src/usecases/document/frontmatter-parse.ts` | strip BOM |
| `src/usecases/document/sync-documents.ts` | upsert + reconcileSync（前置+共享 findAll+比指纹）+ warnings 上报 + SyncResult 持久化 |
| `src/frameworks/db/schema.ts` | features/research 表移除 CHECK 约束 |
| `src/frameworks/db/migration.ts` | 表重建迁移（幂等） |
| `src/frameworks/embedding/embedding-service.ts` | worker error 重置 ready |
| `src/interface-adapters/http/controllers/health-controller.ts` | 新增：memory 健康方法（try-catch 兜底） |
| `src/interface-adapters/http/router.ts` | 注册 GET /api/health/memory |
| `src/usecases/memory/search-memory.ts` | 搜索结果附 degraded 标志 |
| `web/src/pages/memory/index.tsx` | 健康度 banner |
| `docs/features/2026/08/*.md`（16+ 文档） | bugfix -> fix 批量统一 |

## 测试

- `npm run lint` 无报错
- `npm test` 全通过
- validator 单元测试：结构校验阻断、未知枚举值进 warnings 不阻断、ID 正则 {3,8}、title trim、BOM 不影响
- sync 集成测试：upsert 内容指纹变则 update、reconcileSync 检测 missingInDb/stale/supersedes 悬空
- 迁移测试：表重建幂等（跑两次不报错）、数据不丢失
- 健康端点测试：聚合字段正确、DB 异常时返回 healthy:false 而非 500
- 搜索 degraded 测试：reconcileGaps>0 时响应附 degraded
- 端到端：启动同步 errors 从 41 降至 0；features 表从 46 升至接近 85；改文档内容后重新 sync DB 更新

## 关联

- Issue #124 记忆搜索系统 4 个独立缺陷（Task B/C 在各自 PR 创建 F 文档）
