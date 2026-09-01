---
id: F20260901dsyn
title: doc-sync id 漂移 UNIQUE 报错修复
doc_type: feature

summary: |
  修复 #637：F20260731multi-model-routing 文档 frontmatter id（F20260731mmr0）
  与 DB 存量记录 id（F20260731mmr）不一致，导致每次 sync_docs 撞 file_path
  唯一索引报 UNIQUE constraint failed（自 8/16 持续）。方案：文档 id 对齐 DB
  （mmr0→mmr，含 2 个文件的 4 处引用）+ sync 在 insert 前做 id 漂移结构化诊断
  （报「ID drift: 磁盘 id vs DB id + 修复指引」而非裸 SQLite 文本）。

causal_links:
  from:
    - F20260811url0   # 文档 ID 格式规范化（mmr→mmr0 的引入方，未迁 DB 的源头）
    - F20260804dcnv   # 磁盘 ID 扫描共享逻辑（本修复的观测思路沿袭）
    - F20260803mval   # upsert + 内容指纹机制（对齐后走 update 分支的保证）

status: implemented
change_type: fix
tags: [memory, doc-sync, id-drift, unique-constraint, observability]
modules: [src/usecases/document/sync-documents.ts, src/usecases/document/feature-repository.ts, src/usecases/document/research-repository.ts, src/frameworks/db/document/sqlite-feature-repository.ts, src/frameworks/db/document/sqlite-research-repository.ts]

created_at: 2026-09-01
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260901dsyn doc-sync id 漂移 UNIQUE 报错修复

## 背景

### 现象（#637）

每次 `sync_docs` 报 `errors: 1`：`UNIQUE constraint failed: features.file_path`，
文件 `docs/features/2026/07/31/F20260731-multi-model-routing.md`，自 2026-08-16 起每日复发。

### 根因考古（比 issue 记录更深一层）

- **id 漂移的引入方是 F20260811url0**（8/11 的文档 ID 格式规范化）：它把 14 个
  3 位后缀的文档 id 补齐为 4 位（`mmr`→`mmr0`），**只改了磁盘，没有迁移 DB 存量记录**。
- **为什么 14 个案例只有 mmr 报错**：其余 13 个文档的**文件名含 id**，url0 修复时
  同步重命名了文件 → file_path 变化 → 下次 sync 以新 id 静默 insert，旧 id 记录被
  `archiveDeletedDocuments` 归档——错误被「文件重命名逃逸」机制无意中化解。
  DB 中 cap/cap0、ctx/ctx0、hq1/hq10、dsp/dsp0 成对存在即此证据（旧记录 status=archived）。
- **mmr 文件名不含 id**（`F20260731-multi-model-routing.md`，缺 slug——lint 长期警告的那个）
  → 未重命名 → file_path 不变 → `findById(mmr0)` 落空走 insert → 撞 file_path 唯一索引。
- **为什么 reconcileGaps 没兜住**：DB 存量 mmr 记录 status=archived，
  `reconcileType` 的 dbIds 过滤 archived（只看活跃记录），漂移静默。

### 决策依据（方向选择）

大獭预拍板「方案 1：改文档对齐 DB」，理由是文档是新引入方。**实查后时间线修正**：
mmr0 确实是 8/11 url0 引入的，但选择改文档方向依然成立且成本最小：

1. DB 侧 mmr 记录是 7/31 首次入库的先存方，mmr0 是 8/11 的漂移方——改文档是「回归先存 id」
2. 引用面实测（live DB 只读查询）：`memory_entries` 无以 mmr/mmr0 为 id 的条目、
   `memory_edges` 两端引用 mmr 系 = 0 条、80 条 content 引用中 1 条是 rtpr 的
   feature_chunk（改文档后随 fingerprint 变化自动 reindex）+ 79 条 RHI 信号噪音
   （本 bug 的下游症状快照，见「非目标」）
3. 方案 2（改 DB）需迁移 features.id + feature summary entry 的 source_id，
   风险面大且方向倒挂（DB 对齐漂移方）

## 变更内容

### 1. 文档 id 对齐（mmr0 → mmr，2 文件 4 处）

- `docs/features/2026/07/31/F20260731-multi-model-routing.md`：frontmatter id + 正文标题（2 处）
- `docs/features/2026/08/04/F20260804rtpr-runtime-provider-registration.md`：正文引用（2 处）

对齐后 sync 语义：`findById(mmr)` 命中 DB 存量记录 → fingerprint 不同
（status: archived→proposed 等）→ 走 `updateContent` upsert 分支，DB 记录被拉回
与文档一致（status=proposed、body_hash 重建）。这正是 upsert 机制的设计行为。

**历史文档不可变铁律的适用性（F20260831dgim）**：两个被改文件均在 main 出现过
（PR #375 引入），本次 M 修改带 `BYPASS_HISTORICAL_DOC_LINT=1` 提交。理由：
改的是 frontmatter id（结构化标识字段，与 DB 对齐的数据一致性修复），非文档
内容/特性语义变更；铁律保护的是交付快照的语义不可变，id 纠错不属此列，且
不改则 sync 无法修复（sync 按 frontmatter id 机械执行）。变更过程由本文档完整记录。

### 2. sync 报错观测性增强（id 漂移结构化诊断）

issue 分类点出「sync 对 id 漂移无自愈」——本次不实现自愈（策略决策），但让根因可读：

- `FeatureRepository` / `ResearchRepository` 新增 `findByFilePath(filePath)`（两个
  Sqlite 实现同步实现，单条 SELECT，走既有 file_path 唯一索引）
- `SyncDocuments.syncFeatureDoc` / `syncResearchDoc` 在 insert 前查同 file_path 记录，
  命中且 id 不同则报结构化错误并跳过 insert（避免半写状态）：

  ```
  ID drift: frontmatter id F20260731mmr0 != DB record id F20260731mmr at same file_path docs/...
  Insert would violate file_path unique index.
  Fix: align frontmatter id with DB id (recommended, see F20260901dsyn #637),
  or migrate the DB record id (requires memory_entries source_id migration).
  ```

- 下次同类漂移（不管哪方向）的报错从「裸 SQLite 文本 + 根因反推」变为
  「两端 id + 修复指引」直达。

## 非目标

- **不做 sync 自动修复 DB id**：改 DB id 涉及 memory_entries.source_id 迁移，
  是策略决策不是 sync 职责（报错文案已引导两个修复方向）
- **不重构 upsert 算法**：按任务边界约定，只加诊断不改语义
- **不改文件名加 slug**（lint 长期警告）：改名会触发 file_path 变化 + 全链路归档/重插，
  扩大爆炸半径，范围控制不修。留给既有 lint 警告跟踪（ratchet 基线内，不阻断）
- **不清理 79 条 RHI 信号噪音 fact**：它们引用 mmr0 是历史观测快照（「特性链滞留」
  信号正是本 bug 的下游症状），改写观测数据有伪造历史之嫌；修复后新信号自然停止产生

## 影响范围

- `src/usecases/document/sync-documents.ts`：+2 处 insert 前诊断（feature/research 各一）
- `src/usecases/document/feature-repository.ts` / `research-repository.ts`：接口 +1 方法
- `src/frameworks/db/document/sqlite-feature-repository.ts` / `sqlite-research-repository.ts`：+1 查询
- `tests/usecases/document/sync-documents.test.ts`：mock 补 `findByFilePath`；
  `makeFs` 修复 fixture 瑕疵（docs/research 与 docs/features 指向同一文件树导致
  F 文档被 research 扫描器重复解析——旧测试不断言 errors 才没暴露）；+2 测试
- `tests/interface-adapters/health-controller.test.ts`：mock 补 `findByFilePath`
- 运行时行为变化：仅报错文案与 insert 跳过（漂移场景），正常路径零变化

## 验证

### 单元测试

- 新增 2 例：漂移场景报结构化错误不 insert；id 对齐后走 update 分支不报错
- `tests/usecases/document/` + `tests/frameworks/db/` + `tests/interface-adapters/`
  全量 58 文件 611 测试通过（2026-09-01）
- `npm run build`（lint + tsc）通过（5 个 warning 为存量 pre-existing，非本次引入）

### 端到端（live DB 副本）

复制 live DB（`data/otter-buddy.db`）到 /tmp，用编译后的修复版 SyncDocuments +
真实 Sqlite repo 跑全量 sync（memory index 用 no-op，vec 链路不在本次范围）：

```
同步前: mmr = { id: 'F20260731mmr', status: 'archived', file_path: '...multi-model-routing.md' }
结果:   errors: [], reconcileGaps: [], synced: 2, updated: 7, skipped: 366
同步后: mmr = { id: 'F20260731mmr', status: 'proposed', has_hash: 1 }
```

- `errors: []`：UNIQUE 报错消失（本次修复目标）
- mmr 记录 status archived→proposed：upsert update 分支按文档状态拉回（设计行为）
- `updated: 7` 含 rtpr（其正文引用 mmr0→mmr 触发 fingerprint 变化）：
  live 重启 sync 时 `indexFeatureChunks` 会原子替换其 chunk entry，
  memory_entries 中唯一的 mmr0 chunk 引用随之更新（由 F20260803chunk 既有机制保证）
- `npm run lint:docs`：375 docs OK，271 warnings 持平 ratchet 基线（id 改动零新警告）

### live 生效路径

PR 合入 main 后服务重启，bootstrap 的 `syncDocuments` 自动执行本次修复的路径
（live DB 的 mmr 记录随 update 分支对齐），无需手动数据迁移。

## 关联

- 修复 issue：#637
- 引入漂移的历史：F20260811url0（8/11 文档 ID 格式规范化，未迁 DB）
- 同批 13 个「逃逸」案例的成对记录（cap/cap0 等）保持现状：它们已稳定收敛
  （旧 archived + 新 active），不产生报错，不属本次范围
