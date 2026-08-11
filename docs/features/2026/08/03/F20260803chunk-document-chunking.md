---
id: F20260803chun
title: document-chunking
doc_type: feature

summary: |
  文档正文分段索引（chunking）：将整文档 body entry 升级为按标题结构切分的多 chunk entry（feature_chunk/research_chunk），解决整 body 单 entry 的 embedding 截断、BM25 稀释、无法定位 section、多命中信号丢失四局限。
  承接 F20260803fbit 的 body 独立 entry + replaceEntryBySource + body_hash 基础设施，分段在原始 markdown 上按 H2/H3 切（保留标题边界），逐 chunk 独立清理后索引。body_hash 加版本前缀触发全量 reindex。
  聚合策略 dedupBySource 升级为 dedupAndBoostBySource：同源多 chunk 命中取最高分 + additive boost。经两轮对抗审视定稿。

causal_links:
  from:
    - F20260803fbit   # feature-body-index：body 独立 entry + body_hash + replaceEntryBySource content_type 过滤基础设施
    - F20260803mval   # memory-validator：upsert + replaceBySource 基础设施
    - F20260803emlo   # embedding 本地加载（PR #130，chunk embedding 收益依赖）

status: design
change_type: feature
tags: [memory, document-sync, fts, search, chunking, embedding, full-text-index]
modules:
  - src/usecases/document/markdown-chunker.ts
  - src/entities/memory/memory-entry.ts
  - src/usecases/document/sync-documents.ts
  - src/usecases/conversation/memory-index-gateway.ts
  - src/usecases/memory/store-memory.ts
  - src/usecases/memory/memory-repository.ts
  - src/usecases/memory/search-memory.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/migration.ts
  - src/main.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - web/src/pages/memory/index.tsx

created_at: 2026-08-03
---

# F20260803chunk 文档分段索引

## 背景

### 问题

F20260803fbit（PR #129）把特性文档 body 作为独立 memory_entry 索引（`feature_body`/`research_body`），实现了"正文可搜"的基本闭环。但整 body 单 entry 有四局限：

1. **embedding 截断**：bge-m3 上限 8192 tokens，`StoreMemory.truncateForEmbed` 截到 6000 字符。长文档（最长 53,113 字符）尾部内容不进向量索引，语义召回缺失后半部分
2. **BM25 doc length 归一化粗糙**：整文档作为一个 FTS doc，短查询词在长文档里的 term frequency 被 doc length 稀释
3. **无法精确定位 section**：搜索命中后 snippet 从整 body 截取，无法直接跳转到匹配的 section
4. **多 chunk 命中信号丢失**：同文档多处匹配查询（强相关信号）在整 body 单 entry 模型下只产生一次命中

F20260803fbit 评论 issue #124 已建议另开专属 issue：chunking 是体验层优化，成本数量级上升（分段策略/元数据/聚合/增量同步），但 Task B 的"独立 entry + body_hash + replaceEntryBySource content_type 过滤"基础设施已为其铺路。本 F 即该遗留问题的设计文档。

### F20260803fbit 已建立的基础设施（chunking 复用）

1. **body 作为独立 entry**（`contentType=feature_body`/`research_body`，`granularity=coarse`）：chunking 将其升级为多 chunk entry
2. **replaceEntryBySource**（`sqlite-memory-repository.ts:114-162`）：单事务内按 (source_table, source_id, content_type) 删旧+插新，1:1 原子替换。chunking 扩展为 1:N（`replaceEntriesBySource`）
3. **搜索去重**（`search-memory.ts:324-334` `dedupBySource`）：按 (sourceTable, sourceId) 分组留高分。chunking 升级为分组 + 多命中加分
4. **body_hash 指纹**（`sync-documents.ts:34-38` `featureFingerprint`）：驱动文档级 reindex。chunking 加版本前缀触发全量重切
5. **markdown 噪声清理**（`markdown-noise-cleaner.ts` `cleanMarkdownForFts`）：chunking 对每个 chunk 独立调用
6. **contentType filter**（`SearchFilters.contentType` 数组，`searchFTS`/`searchVec` SQL IN 过滤）：chunking 扩展枚举值
7. **embedding 截断**（`store-memory.ts:32-36` `truncateForEmbed`）：chunking 后 chunk 长度可控，截断几乎不触发，保留作兜底
8. **MemoryIndexGateway.indexFeatureBody/indexResearchBody**：chunking 改为 `indexFeatureChunks`/`indexResearchChunks`

### 文档结构分析结果（91 个文档实测）

| 维度 | 数据 |
|------|------|
| 文档总数 | 91（88 feature + 3 research） |
| 平均 body 长度 | 11,417 字符 |
| 最长 body | 53,113 字符（F20260709p4q7） |
| 有 H2 标题的文档 | 100%（零文档无标题） |
| frontmatter 后有前言段落的文档 | 0 个（全部 frontmatter → 标题） |
| section <2000 字符占比 | 97.8% |
| section <3000 字符占比 | 99.3% |
| 超 3000 字符的 section | 18 个（0.7%），集中在 12 个文档，主因大代码块 |
| 代码块总数 | 469，平均 645 字符，最长 9,499 字符 |

**关键结论**："按标题分段 + 超长 section 兜底切分"策略数据支持度极高。绝大多数 section 天然适合单 chunk，仅 0.7% 需要兜底。

### 设计目标

- **精确定位**：chunk 元数据携带 heading_path，搜索结果可定位到 section
- **BM25 排序提升**：短 chunk 让 doc length 归一化更精细
- **embedding 质量提升**：bge-m3 对短文本注意力更集中，全覆盖文档内容（无截断）
- **multi-hit 信号**：同文档多 chunk 命中加权，真正相关的文档排名更高
- **RAG 就绪**：chunk 颗粒度直接填 context
- **零回归**：summary 索引行为不变；改 body 触发全量重切 chunk

## 变更

### 1. 新建 markdown-chunker.ts（分段算法纯函数）

`src/usecases/document/markdown-chunker.ts`：

```ts
export interface MarkdownChunk {
  content: string;        // 原始 markdown（未清理），含标题标记
  headingPath: string[];  // 标题路径，如 ["背景", "问题"]
  charCount: number;      // 原始 markdown 字符数
}

const CHUNK_THRESHOLD = 3000;
const MIN_CHUNK_SIZE = 50;

export function chunkMarkdown(body: string): MarkdownChunk[]
```

**算法**：
1. 空/全空白 body → 返回 `[]`（不索引任何 chunk）
2. `body.length < CHUNK_THRESHOLD` → 单 chunk，`headingPath=[]`
3. 按 H2（`/^## (?!#)/m`）分割为 sections，每个 section 含 H2 标题行 + 后续内容直到下一个 H2
4. H2 section 超阈值 → 按 H3 切分。**M5 修正**：H2 标题与首个 H3 之间的"前言段落"（若 >= MIN_CHUNK_SIZE）归入 `headingPath=[H2 标题]` 的独立 chunk；H3 section headingPath = [H2 标题, H3 标题]
5. H3 section 仍超阈值 → 按段落（双换行）+ 代码块兜底切分，代码块原子化（见变更 2）。段落兜底切分的 chunk **继承所属 H3 的 headingPath**
6. **M13 修正**（导航型标题精确定义）：section 去除所有子标题行（H3+）后，非空白内容 < 30 字符 → 视为导航型标题，合并到第一个子 section（不单独成 chunk）
7. 短 chunk（charCount < MIN_CHUNK_SIZE）→ 合并到相邻 chunk（非末尾合并到下一个，末尾合并到前一个）
8. H1 标题忽略（文档标题已在 frontmatter.title，不参与分段）；H4/H5/H6 不单独分段，作为 H3 内容保留

**headingPath 维护**：分段时维护标题路径栈，每个 emit 的 chunk 携带当前栈快照。

### 2. 代码块状态机原子化

H3 section 兜底切分时，代码块（``` ... ```）是不可分割的原子单元。用**状态机**而非正则提取代码块（正则难处理嵌套围栏、缩进围栏、未闭合围栏）：

```ts
interface Block { type: "paragraph" | "codeblock"; text: string; }

/** M2 修正：同时识别 ``` 和 ~~~ 围栏（CommonMark 两种合法 fenced code block） */
function isFenceLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function splitIntoAtomicBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let current: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (isFenceLine(line)) {
      if (inCode) {
        current.push(line);
        blocks.push({ type: "codeblock", text: current.join("\n") });
        current = [];
        inCode = false;
      } else {
        if (current.length > 0) {
          blocks.push({ type: "paragraph", text: current.join("\n") });
          current = [];
        }
        current.push(line);
        inCode = true;
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push({ type: inCode ? "codeblock" : "paragraph", text: current.join("\n") });
  }
  return blocks;
}
```

累积原子单元直到接近 CHUNK_THRESHOLD：加入下一个单元不超阈值则累积；超阈值则 emit 当前累积；单个单元超阈值（大代码块）则单独 emit（原子化不截断）。

**M4 修正**（未闭合代码块兜底）：tail flush 时若单个 codeblock 超 `CHUNK_THRESHOLD * 2`（6000 字符），按行强制切分（每 CHUNK_THRESHOLD 一段），在 chunk metadata 标注 `truncated: true`。防未闭合围栏导致文档后半全部成单个超大 chunk。

### 3. MemoryContentType 枚举变更

`src/entities/memory/memory-entry.ts`：

```ts
// 旧
export type MemoryContentType =
  | "message" | "fact" | "linked_resource"
  | "feature" | "feature_body"
  | "research" | "research_body";
// 新
export type MemoryContentType =
  | "message" | "fact" | "linked_resource"
  | "feature" | "feature_chunk"
  | "research" | "research_chunk";
```

`feature_body`/`research_body` 被 `feature_chunk`/`research_chunk` 取代（决策 D1）。

### 4. MemoryIndexGateway 接口变更

`src/usecases/conversation/memory-index-gateway.ts`：

```ts
export interface ChunkData {
  content: string;        // 原始 markdown（未清理）
  headingPath: string[];
  charCount: number;
}

export interface MemoryIndexGateway {
  // ... 既有 indexFeature/indexResearch 不变 ...
  /** 移除 indexFeatureBody / indexResearchBody */
  /** 索引 Feature 文档 chunks（N 个独立 entry，原子替换旧 chunks） */
  indexFeatureChunks(id: string, chunks: ChunkData[], metadata: Record<string, unknown>): Promise<void>;
  /** 索引 Research 文档 chunks */
  indexResearchChunks(id: string, chunks: ChunkData[], metadata: Record<string, unknown>): Promise<void>;
}
```

### 5. MemoryRepository 新增 replaceEntriesBySource（1:N 原子替换）

`src/usecases/memory/memory-repository.ts` 接口加：

```ts
/** 按 source 原子替换多条 entry（1:N，单事务删旧全部+插新 N 条） */
replaceEntriesBySource(entries: MemoryEntry[]): Promise<void>;
```

`src/frameworks/db/memory/sqlite-memory-repository.ts` 实现：

```ts
async replaceEntriesBySource(entries: MemoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const { sourceTable, sourceId, contentType } = entries[0];
  // M1 校验：所有 entries 必须同 (sourceTable, sourceId, contentType)
  for (const e of entries) {
    if (e.sourceTable !== sourceTable || e.sourceId !== sourceId || e.contentType !== contentType) {
      throw new Error(`replaceEntriesBySource requires homogeneous source, got mixed: ${e.sourceTable}/${e.sourceId}/${e.contentType}`);
    }
  }
  this.db.exec("BEGIN");
  try {
    // 删旧（同 source + 同 contentType 的全部 entry）
    const oldRows = this.db
      .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?")
      .all(sourceTable, sourceId, contentType) as Array<{ id: string }>;
    for (const row of oldRows) {
      this.db.prepare("DELETE FROM memory_fts WHERE memory_entry_id = ?").run(row.id);
      if (this.hasVec) {
        this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
      }
      this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
    }
    this.db.prepare(
      "DELETE FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?"
    ).run(sourceTable, sourceId, contentType);

    // 插新（N 条 entry）
    for (const entry of entries) {
      // INSERT memory_entries + memory_fts + memory_weights（同 storeEntry 逻辑）
    }
    this.db.exec("COMMIT");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

**与现有方法的关系**：
- `storeEntry(entry)`：单条插入，message/linked_resource 首次索引
- `replaceEntryBySource(entry)`：1:1 原子替换，summary entry reindex
- `replaceEntriesBySource(entries)`：1:N 原子替换，chunk entries reindex（本变更新增）
- `deleteBySource(table, id)`：按源全删，文档归档清理（删 summary + 所有 chunk）

三者复用相同的 DELETE WHERE content_type 模式。`replaceEntryBySource` 保留不动（summary entry 仍用 1:1）。

### 6. StoreMemory 新增 replaceChunksBySource

`src/usecases/memory/store-memory.ts`：

```ts
async replaceChunksBySource(inputs: MemoryEntryInput[]): Promise<string[]> {
  const entries: MemoryEntry[] = inputs.map(input => ({
    id: crypto.randomUUID(),
    ...input,
    conversationId: input.conversationId ?? null,
    metadata: input.metadata ?? null,
    createdAt: new Date().toISOString(),
  }));
  await this.repo.replaceEntriesBySource(entries);
  // 异步 fire-and-forget embedding（每 chunk 独立）
  for (const entry of entries) {
    this.embeddingGateway
      .embed(this.truncateForEmbed(entry.content))
      .then((emb) => {
        this.repo.storeEmbedding(entry.id, emb).catch((err) => {
          this.logger.warn(`Failed to store embedding for ${entry.id}: ${err}`);
        });
      })
      .catch((err) => {
        this.logger.debug(`Embedding generation failed for ${entry.id}: ${err}`);
      });
  }
  return entries.map(e => e.id);
}
```

chunk 长度通常 <3000，`truncateForEmbed`（6000 截断）几乎不触发，保留作兜底。

### 7. sync-documents 改用 chunkMarkdown + 逐 chunk cleanMarkdownForFts

`src/usecases/document/sync-documents.ts`：

**(a) syncFile 调用链重构（B1 修正，关键）**：

现有 `syncFile:142` 已执行 `const body = cleanMarkdownForFts(rawBody)`，传给 syncFeatureDoc 的 body 标题井号已删。必须改为同时传递 rawBody 和 cleanedBody：

```ts
private async syncFile(rootDir, file, type, result): Promise<void> {
  const content = await this.fs.readFile(file);
  const { frontmatter, content: rawBody } = parseFrontmatterFromContent(content);
  // ... validation 不变 ...
  const cleanedBody = cleanMarkdownForFts(rawBody);  // 保留：hash + buildDocument 用
  if (type === "feature") {
    await this.syncFeatureDoc(frontmatter, relativePath, rawBody, cleanedBody, result);
  } else {
    await this.syncResearchDoc(frontmatter, relativePath, rawBody, cleanedBody, result);
  }
}
```

`syncFeatureDoc` / `syncResearchDoc` 签名改为 `(fm, filePath, rawBody, cleanedBody, result)`。

**(b) computeBodyHash 加版本前缀**（决策 D3，触发全量 reindex）：
```ts
const CHUNKING_VERSION = "chunk-v1";
function computeBodyHash(cleanedBody: string): string | null {
  if (!cleanedBody) return null;
  return createHash("sha256").update(`${CHUNKING_VERSION}|${cleanedBody}`).digest("hex").slice(0, 16);
}
```

**(c) syncFeatureDoc 调用链**：
```ts
private async syncFeatureDoc(fm, filePath, rawBody, cleanedBody, result): Promise<void> {
  const doc = this.buildFeatureDocument(fm, filePath, cleanedBody);
  const existing = await this.featureRepo.findById(doc.id);
  const meta = { doc_type: "feature", title: doc.title, change_type: doc.changeType, tags: doc.tags,
                 modules: doc.modules, from: doc.causalLinksFrom, supersedes: doc.supersedes };
  if (!existing || featureFingerprint(doc) !== featureFingerprint(existing)) {
    // 分段：在原始 rawBody 上切（保留标题结构），逐 chunk 清理在 indexFeatureChunks 内做（决策 D2）
    const rawChunks = chunkMarkdown(rawBody);
    if (!existing) { await this.featureRepo.insert(doc); result.synced++; }
    else { await this.featureRepo.updateContent(doc); result.updated++; }
    await this.memoryIndex.indexFeature(doc.id, doc.summary, meta);
    await this.memoryIndex.indexFeatureChunks(doc.id, rawChunks, meta);
    result.chunkEntriesIndexed += rawChunks.length;
  } else {
    result.skipped++;
  }
}
```

**关键顺序**（决策 D2）：`chunkMarkdown(rawBody)` 在**原始 body**上切（保留标题井号），每个 chunk 的 content 在 `indexFeatureChunks` 实现里再经 `cleanMarkdownForFts` 清理。body_hash 用整体 `cleanedBody` 算（与 fbit 一致，保证清理策略改了触发 reindex）。注意：清理策略改了 → cleanedBody 变 → body_hash 变 → reindex → 重新切 chunk（rawBody 没变但重新清理每个 chunk）。这正确：清理策略改了需要重新索引清理后的 chunk 内容。

**(d) SyncResult 字段重命名**：`bodyEntriesIndexed` → `chunkEntriesIndexed`，日志同时输出文档数和 chunk 总数。**全局排查**（M9）：grep `bodyEntriesIndexed` 所有引用（健康端点 / API 暴露 / 测试断言），确保全部更新。

### 8. MemoryIndexAdapter 实现 indexFeatureChunks/indexResearchChunks

`src/main.ts`：

```ts
async indexFeatureChunks(id: string, chunks: ChunkData[], metadata: Record<string, unknown>): Promise<void> {
  // M17：空 chunks（body 全空白）时不索引，记录 warning。91 个文档实测都有内容，此为边界防御。
  // 不调 replaceChunksBySource（空数组无法取 source 做 DELETE），旧 chunk 保留（文档从有内容变空属异常，可接受）
  if (chunks.length === 0) return;
  const inputs: MemoryEntryInput[] = chunks.map((c, i) => ({
    layer: "document",
    contentType: "feature_chunk",
    sourceId: id,
    sourceTable: "features",
    conversationId: undefined,
    granularity: "fine",   // 决策 D4：chunk 是细粒度
    content: cleanMarkdownForFts(c.content),   // 每个 chunk 独立清理（D2 关键顺序）
    metadata: { ...metadata, doc_title: metadata.title, part: "chunk",
                chunk_index: i, chunk_total: chunks.length,
                heading_path: c.headingPath, char_count: c.charCount },
  }));
  await this.storeMemory.replaceChunksBySource(inputs);
}
```

**M10 修正**：metadata 加 `doc_title`（从传入的 metadata.title 获取，syncFeatureDoc 构造 meta 时加入 `title: doc.title`），供前端展示"来自 [文档标题] > heading_path"。

**M19 修正**（indexResearchChunks 关键差异）：与 indexFeatureChunks 对称，但 contentType=`"research_chunk"`、sourceTable=`"research"`。metadata 含 `exploration_type`/`conclusion`（而非 `change_type`/`modules`）。

### 9. dedupBySource → dedupAndBoostBySource（多命中加分）

`src/usecases/memory/search-memory.ts`：

**S2 修正**（boost 数值校准）：rrfK=60，RRF score 实际范围 0.016-0.033（rank 0 单源 1/61=0.0164，双源 0.0328）。原设计 boost 0.15 是此范围的 5-10 倍，过强。**降为 0.01/hit 封顶 0.05**：

```ts
const MULTI_HIT_BOOST = 0.01;
const MAX_MULTI_HIT_BOOST_COUNT = 5;

private dedupAndBoostBySource(scored: ScoredHit[]): ScoredHit[] {
  const groups = new Map<string, ScoredHit[]>();
  for (const hit of scored) {
    const key = `${hit.entry.sourceTable}|${hit.entry.sourceId}`;
    const group = groups.get(key);
    if (group) group.push(hit);
    else groups.set(key, [hit]);
  }
  const result: ScoredHit[] = [];
  for (const group of groups.values()) {
    // S8：tie-breaker 按 chunk_index 保证确定性（finalScore 相同时）
    group.sort((a, b) =>
      b.finalScore !== a.finalScore
        ? b.finalScore - a.finalScore
        : (a.entry.metadata?.chunk_index ?? 0) - (b.entry.metadata?.chunk_index ?? 0)
    );
    const best = group[0];
    const extraHits = Math.min(group.length - 1, MAX_MULTI_HIT_BOOST_COUNT);
    // M15：创建新对象而非原地修改（避免 mutation 风险）
    result.push({
      ...best,
      finalScore: best.finalScore + MULTI_HIT_BOOST * extraHits,
      multiHitCount: group.length,   // ScoredHit 新增可选字段
    });
  }
  return result;
}
```

`rerankAndReturn` 返回映射：**M12 修正**——检查 `multiHitCount > 1` 才注入 `multi_hit_count`（undefined 时不注入）。

**M6 修正**（FTS limit 防 chunk 霸占）：DEFAULT_FTS_LIMIT=50，长文档（53K 字符 × 19 chunk）可能占满 limit。在 `searchConversationInternal` 的 FTS 结果进 RRF fusion **前**做预聚合：每 (sourceTable, sourceId) 最多保留 top-3 chunk（按 ftsRank）。新增 helper `preAggregateFtsBySource(ftsHits: FTSHit[]): FTSHit[]`。这样 50 条 FTS 结果预聚合后保证 source diversity。vec 路径不受限（k=limit 参数控制）。

**数值合理性**（校准后）：单 chunk score=0.016 vs 3 chunk 最高 score=0.016+0.02=0.036 vs 10 chunk score=0.016+0.05=0.066。boost 是合理相对提升，不压倒高分单 chunk。

**覆盖范围**：仅 `rerankAndReturn` 的 `dedup=true` 路径（searchConversationInternal）。`searchSimilar` 保持 `dedup=false`（同源多 chunk 是合法相似结果）。

### 10. 迁移：清理旧 feature_body/research_body entries（B2+B3 修正）

`src/frameworks/db/migration.ts` 新增 **export 独立函数**（B7：不嵌入 migrateDatabase 函数体，因 migrateDatabase 在 sync 之前执行）。**关键**（B3）：迁移在 sync **之后**执行（main.ts 顺序：initSchema → syncDocuments → migrateFeatureBodyToChunks）。sync 先通过 body_hash 版本前缀触发 updated 分支生成 feature_chunk，迁移再清理旧 feature_body/research_body。若 sync 失败，旧 feature_body 仍在不丢数据。

**M14 修正**：迁移加 `syncErrors` 参数，仅当 sync 无错误时执行清理。防 sync 部分失败时迁移清掉 feature_body 导致失败文档正文索引永久消失。

**B2 修正**：用内联 SQL 模式（参照 `rebuildMessagesFtsStripped` 的写法），不使用不存在的 getSetting/setSetting 辅助函数：

```ts
/** B7：独立 export，不加入 migrateDatabase 函数体（migrateDatabase 在 sync 之前执行） */
export function migrateFeatureBodyToChunks(db: Database.Database, logger: Logger, syncErrors: number): void {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'chunking_v1_migrated'")
    .get() as { value: string } | undefined;
  if (done?.value === 'done') return;
  // M14：sync 有错误时不执行清理（防失败文档正文索引永久消失）
  if (syncErrors > 0) {
    logger.warn(`Skipping chunking migration: sync had ${syncErrors} errors`);
    return;
  }

  const migrate = db.transaction(() => {
    const types = ["feature_body", "research_body"];
    for (const ct of types) {
      const rows = db.prepare("SELECT id FROM memory_entries WHERE content_type = ?").all(ct) as Array<{id:string}>;
      for (const row of rows) {
        db.prepare("DELETE FROM memory_fts WHERE memory_entry_id = ?").run(row.id);
        // vec0 虚拟表可能不存在（D22 降级），try-catch 兜底（S3：迁移无法访问实例 hasVec）
        try { db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id); } catch {}
        db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
      }
      db.prepare("DELETE FROM memory_entries WHERE content_type = ?").run(ct);
    }
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('chunking_v1_migrated', 'done', datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = datetime('now')",
    ).run();
  });
  migrate();
  logger.info('Migrated feature_body/research_body entries to chunk model (chunking_v1_migrated=done)');
}
```

幂等 settings key `chunking_v1_migrated`（参照 `rebuildMessagesFtsStripped` 的 settings 幂等先例）。

**main.ts 调整**（B7）：迁移调用点移到 `syncDocuments.execute()` **之后**单独调用，不嵌入 migrateDatabase：

```ts
// main.ts（简化示意）
const syncResult = await syncDocuments.execute(rootDir);  // 先 sync，生成 feature_chunk
migrateFeatureBodyToChunks(db, logger, syncResult.errors.length);  // 后 migrate，清理旧 feature_body（M14：仅 sync 无错时执行）
```

**S10 修正**：迁移的 `DELETE FROM memory_vec` 的空 catch 改为 log warn（参照 checkVecTable 模式），防吞非 "table not found" 的错误。

### 11. agent 工具 contentType enum + description 文本更新

`src/interface-adapters/agent-runtime/tools/tool-factory.ts`：search_memory 工具参数的 contentType enum 移除 `feature_body`/`research_body`，加 `feature_chunk`/`research_chunk`。**A4 修正**：工具 description 的中文说明文本也含 `feature_body`（如"文档正文"），同步更新为 `feature_chunk`/`research_chunk` 并调整说明（如"文档分段片段"），让 agent 知道可传的新值。

### 12. 前端 icon 映射 + heading_path 展示

`web/src/pages/memory/index.tsx`：
- `typeIconComponents` 移除 `feature_body`/`research_body`，加 `feature_chunk`/`research_chunk`（FileText 图标）
- 搜索结果展示 `heading_path`（如有）：显示 "来自 [文档标题] > heading1 > heading2"

## 设计决策

### D1. feature_chunk 取代 feature_body（不并存）

曾考虑并存方案（feature_body 整 body + feature_chunk 分段共存）。**选定取代**。

理由：
1. feature_body 是整文档单 entry，正是 chunking 要改进的对象。并存致同一文档两套索引，FTS 双命中、embedding 重复浪费
2. feature_chunk 对短文档（<3000 字符）退化为单 chunk，语义等价 feature_body，无信息损失
3. 并存增加聚合复杂度：dedupBySource 需处理 feature + feature_body + feature_chunk 三路命中
4. 迁移简单：迁移脚本一次性删除旧 feature_body/research_body entries（变更 10）

### D2. 先分段再清理（关键顺序）

`cleanMarkdownForFts` 会删除标题井号（`### ` → 标题文本）。若先清理再分段，标题边界丢失，无法按 H2/H3 切分。

**选定先分段**：`chunkMarkdown(rawBody)` 在原始 markdown 上切分（保留标题结构），每个 chunk 的 content 在索引时再经 `cleanMarkdownForFts` 独立清理。body_hash 仍用整体 `cleanMarkdownForFts(body)` 算（与 fbit 一致）。

### D3. body_hash 加版本前缀触发全量 reindex

`featureFingerprint` 两端都经同一函数计算，body_hash 不变则指纹等，所有文档走 skip 分支。必须改变 body_hash 计算方式才能触发 reindex。

**选定加版本前缀** `"chunk-v1|"`：版本前缀变化导致所有文档 body_hash 变化 → 指纹不等 → updated 分支 → 生成 chunk。无需额外 schema 列或迁移脚本驱动 reindex。

### D4. chunk granularity="fine"

summary entry granularity="coarse"（概要粒度）。chunk 是更细检索单元，**选定 granularity="fine"**。影响 SearchFilters.granularity 过滤行为：用户可按 coarse（只搜 summary）或 fine（搜 chunk）过滤。

### D5. 多命中 additive boost（非 multiplicative）

曾考虑 multiplicative boost（finalScore × (1 + 0.1 × extraHits)）。**选定 additive**（finalScore + 0.03 × min(extraHits, 5)）。

理由：
1. 数值可控（封顶 +0.15），不会让长文档（50 chunk）无限霸占
2. additive 对高低分段一视同仁；multiplicative 在低分时 boost 小、高分时 boost 大，放大马太效应
3. RRF score 范围 [0.01, 0.5]，+0.15 是显著但不压倒性的提升

### D6. 不做 chunk 级 hash diff

曾考虑 chunk 级 hash（每 chunk 独立 hash，只更新变化的 chunk）。**选定不做**。

理由：
1. body_hash 变了就全量重切 chunk（replaceEntriesBySource 原子替换），语义清晰
2. chunk 级 diff 复杂度高（chunk 顺序变化、边界漂移、insert/delete/update 混合）
3. 全量重切的成本：~91 文档 × ~6 chunk = ~546 entry replace，单事务毫秒级，可接受
4. 增量同步优化作为 follow-up

### D7. embedding 不改批量接口

当前 `EmbeddingGateway.embed(text): Promise<Float32Array>` 单文本单向量。曾考虑改批量接口。**选定不改**。

理由：
1. 接口改动牵连大（EmbeddingGateway + 实现 + worker + 所有调用方）
2. fire-and-forget 异步不阻塞 sync 返回
3. ~546 embedding × ~50ms = ~27s，首次部署可接受（FTS 立即生效，向量检索逐步生效）
4. 批量优化作为 follow-up

### D8. FTS 查询后、RRF fusion 前做 source 预聚合（M6 修正）

DEFAULT_FTS_LIMIT=50。长文档（53K 字符 × 19 chunk）的泛查询可能让 FTS 返回 50 条中大量来自同一文档，挤掉其他文档。**选定在 FTS 结果进 RRF fusion 前做预聚合**：每 (sourceTable, sourceId) 最多保留 top-3 chunk（按 ftsRank）。

理由：
1. 在 fusion 前预聚合保证 source diversity，50 条预聚合后最多 ~17 个 source
2. top-3 而非 top-1：多 chunk 命中是正信号，保留 top-3 让 RRF fusion 能体现多命中加成（3 个 chunk 各贡献 rrfScore）
3. vec 路径不受限（k=limit 参数控制，不硬编码 50）
4. 替代方案（增大 FTS limit 到 200）治标不治本，且增加查询开销

### D9. 全库搜索路径 boost 表现为排名位移（M7 分析）

`searchAllLibraries` 拿到 `searchConversationInternal` 结果后用 `normalizedScore = 1.0 / (1 + rank)` 重新归一化。dedupAndBoostBySource 的 additive boost（+0.05）被转换为排名位移：boost 提升排名后 normalizedScore 变大。

**选定接受现状**：boost 在全库搜索路径表现为排名位移而非绝对值加成，效果弱于对话库路径但方向正确。全库搜索混排的是不同 library（conversation + terminology），chunk 的 multi-hit boost 主要在 conversation 库内排序起作用，跨库混排由 libraryPriority 主导。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/usecases/document/markdown-chunker.ts` | **新建**：chunkMarkdown 纯函数 + MarkdownChunk 接口 + 代码块状态机 |
| `src/usecases/document/markdown-noise-cleaner.ts` | **B6 补**：cleanMarkdownForFts 加 ~~~ 围栏清理规则（与 ``` 对称），防 ~~~ 围栏行残留成 trigram 噪声 |
| `src/entities/memory/memory-entry.ts` | MemoryContentType 加 feature_chunk/research_chunk，移除 feature_body/research_body |
| `src/usecases/conversation/memory-index-gateway.ts` | 移除 indexFeatureBody/indexResearchBody；新增 indexFeatureChunks/indexResearchChunks + ChunkData 接口 |
| `src/usecases/memory/memory-repository.ts` | MemoryRepository 接口加 replaceEntriesBySource(entries) |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 实现 replaceEntriesBySource（1:N 原子替换） |
| `src/usecases/memory/store-memory.ts` | 新增 replaceChunksBySource(inputs)，每 chunk 独立 fire-and-forget embedding |
| `src/usecases/document/sync-documents.ts` | computeBodyHash 加版本前缀；syncFeatureDoc/syncResearchDoc 改用 chunkMarkdown + indexFeatureChunks；SyncResult bodyEntriesIndexed → chunkEntriesIndexed |
| `src/usecases/memory/search-memory.ts` | dedupBySource → dedupAndBoostBySource；ScoredHit 加 multiHitCount?；返回映射注入 multi_hit_count |
| `src/frameworks/db/migration.ts` | 新增 migrateFeatureBodyToChunks（清理旧 feature_body/research_body entries，幂等） |
| `src/main.ts` | MemoryIndexAdapter 实现 indexFeatureChunks/indexResearchChunks（含 cleanMarkdownForFts 每 chunk 清理） |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | search_memory contentType enum 更新 |
| `web/src/pages/memory/index.tsx` | icon 映射 + heading_path 展示 |
| `tests/usecases/document/markdown-chunker.test.ts` | **新建**：分段算法全分支测试 |
| `tests/usecases/document/sync-documents.test.ts` | mock 加 indexFeatureChunks/indexResearchChunks；fixture 加多 H2/H3 body；断言 chunk 数 |
| `tests/usecases/memory/store-memory.test.ts` | 新增 replaceChunksBySource 测试 |
| `tests/usecases/memory/search-memory.test.ts` | 新增多 chunk 命中聚合 + boost 测试 |
| `tests/frameworks/db/migration.test.ts` | 新增 migrateFeatureBodyToChunks 幂等测试 |
| `tests/api/memory.test.ts` | **M8 补**：contentType 断言 feature_body → feature_chunk 更新 |
| `tests/usecases/conversation/send-message.test.ts` | **M8 补**：mock indexFeatureBody → indexFeatureChunks（含 indexResearchChunks）；两处 mock 对象更新 |

## 验收

- TypeScript 编译通过（MemoryContentType 枚举变更生效）
- 启动同步日志：`chunkEntriesIndexed` 数 ≈ 文档数 × 平均 chunk 数（~546）；首次启动所有文档走 updated 分支（body_hash 版本前缀触发）
- 搜正文关键词命中对应 chunk，snippet 精确到 section
- 搜 heading_path 中的标题词命中对应 chunk
- 同文档多 chunk 命中，搜索结果只出现 1 条，metadata 有 multi_hit_count
- `contentType=feature_chunk` filter 只返回 chunk entry
- `contentType=feature,feature_chunk` 返回 summary + chunk 混排（去重后）
- 迁移后 memory_entries 表无 feature_body/research_body 记录
- 改文档 body 再 sync：旧 chunk 全删 + 新 chunk 全插（replaceEntriesBySource 原子替换）
- 不改 body 再 sync：skip 分支，不调 indexFeatureChunks
- 前端展示 chunk 的 heading_path
- summary 仍可搜（不回归）
- searchSimilar 同源多 chunk 多条返回（dedup=false 不变）

## 测试

### 单元

- `chunkMarkdown`：空 body / 全空白 / 短文档单 chunk / 多 H2 每 chunk / H2 超阈值下沉 H3 / H3 超阈值代码块原子化 / 超长代码块（>10000）单独成 chunk / 导航型标题合并子 section / 短 chunk（<50）合并相邻 / 无标题纯文本单 chunk / 连续 H2 无内容空 section 不生成 chunk / H4 不分段 / H1 忽略
- `splitIntoAtomicBlocks`：正常代码块 / 未闭合代码块 / 缩进围栏 / 连续代码块 / 代码块内含 ``` 字符
- `replaceChunksBySource`：3 entry 原子替换 / 空 inputs 不调 repo / embedding 各 chunk 独立生成 / embedding 失败不影响其他 chunk
- `dedupAndBoostBySource`：同源 3 chunk 命中 multi_hit_count=3 / 同源 1 chunk 无 boost / 同源 10 chunk boost 封顶 5 / 不同源各 1 chunk 无 boost
- `computeBodyHash`：版本前缀变化触发 hash 变化
- `migrateFeatureBodyToChunks`：幂等 / 删除联动 FTS/vec/weights

### 集成

- 首次 sync 短文档：1 个 feature_chunk entry
- 首次 sync 长文档（多 H2）：N 个 feature_chunk entries，chunk_index 连续
- 改 body 再 sync：replaceEntriesBySource 删旧全 + 插新全
- 不改 body 再 sync：skip 分支
- contentType filter：feature_chunk 只返回 chunk；feature,feature_chunk 混排
- 迁移：旧 feature_body entry 迁移后删除；幂等

### 端到端

- 搜正文关键词命中 chunk，snippet 精确
- 同文档多 chunk 命中只出现 1 条 + multi_hit_count
- 前端展示 heading_path
- 健康端点 `/api/health/memory` 不退化

## 对抗审视记录

### 第一轮（已回写）

经一轮独立 Plan agent 对抗审视，命中 4 个阻断 + 13 个重要级 + 5 个建议级。全部采纳：

**阻断**：

- **B1 syncFeatureDoc 收到的 body 已经是清理过的——chunkMarkdown 无法在原始 body 上切**：现有 `syncFile:142` 已执行 `const body = cleanMarkdownForFts(rawBody)`，传给 syncFeatureDoc 的 body 标题井号已删，H2/H3 正则切分失效。调整：变更 7 重构 syncFile 调用链，syncFeatureDoc 同时接收 `rawBody`（给 chunkMarkdown）和 `cleanedBody`（给 computeBodyHash + buildDocument）。
- **B2 getSetting/setSetting 函数不存在**：迁移代码用了不存在的辅助函数。调整：变更 10 改用内联 SQL 模式（参照 `rebuildMessagesFtsStripped` 的 `db.prepare("SELECT value FROM settings WHERE key = ...")` + `INSERT INTO settings ... ON CONFLICT DO UPDATE`）。
- **B3 迁移和 sync 执行顺序导致窗口期数据丢失**：迁移先删旧 feature_body，若 sync 失败则正文从索引消失。调整：变更 10 迁移移到 sync **之后**执行（main.ts 顺序：initSchema → syncDocuments → migrateFeatureBodyToChunks）。sync 先生成 chunk，迁移再清理旧 feature_body；sync 失败则旧 feature_body 还在不丢数据。
- **B4 枚举破坏性变更——残留 feature_body 数据的运行时处理**：迁移同步执行先于 API，正常流程无风险。但为健壮性，`rowToMemoryEntry` 出站不做 isMemoryContentType 检查（只入站校验），残留数据可正常返回。迁移保证完整清理。调整：保留设计，决策 D1 补充说明。

**重要**：

- **M1 replaceEntriesBySource 无 source 一致性校验**：调整：变更 5 加运行时断言，遍历验证 sourceTable/sourceId/contentType 一致，不一致抛异常。
- **M2 代码块状态机漏 ~~~ 围栏**：调整：变更 2 状态机同时检测 ``` 和 ~~~ 围栏。
- **M4 未闭合代码块产生超大 chunk**：调整：变更 2 状态机 tail flush 时若单 codeblock 超 CHUNK_THRESHOLD × 2，按行强制切分。
- **M5 H2 下沉 H3 时前言段落 headingPath 歧义**：调整：变更 1 明确——H2 与首个 H3 之间的前言段落归入 H2 headingPath 的独立 chunk（若 >= MIN_CHUNK_SIZE）；段落兜底切分继承所属 H3 的 headingPath。
- **M6 FTS limit 50 可能被同文档 chunk 占满**：调整：新增决策 D8 + 变更 13——dedupAndBoostBySource 上推到 FTS 查询后、RRF fusion 前做组内预聚合（每 source 最多保留 top-3 chunk 进 fusion），防单文档霸占 limit。
- **M7 全库搜索路径 boost 被 normalizedScore 覆盖**：调整：在文档中分析（决策 D9），boost 在全库搜索路径表现为排名位移，效果与对话库路径不同但可接受。
- **M8 涉及文件表遗漏 2 个测试文件**：调整：涉及文件表补充 `tests/api/memory.test.ts`（contentType 断言）和 `tests/usecases/conversation/send-message.test.ts`（mock indexFeatureBody → indexFeatureChunks）。
- **M9 bodyEntriesIndexed 重命名需全局排查引用**：调整：涉及文件表补注 grep `bodyEntriesIndexed` 全部引用（含健康端点/API 暴露）。
- **M10 metadata 缺 doc_title，前端无法展示文档标题**：调整：变更 8 metadata 加 `doc_title`（从 doc.title 获取）。
- **M11 逐 chunk cleanMarkdownForFts 对代码围栏边界的影响**：调整：测试章节补"chunk 以代码块开头/结尾"场景。
- **M12 ScoredHit 加 multiHitCount 需处理 undefined**：调整：变更 9 明确 rerankAndReturn 返回映射检查 multiHitCount > 1 才注入。
- **M13 导航型标题定义不精确**：调整：变更 1 明确定义——去除所有子标题行后非空白内容 < 30 字符视为导航型。

**建议**：

- **S1 ~~ 删除线未被 cleanMarkdownForFts 处理**：留 follow-up（噪声清理增强，独立 PR）。
- **S2 boost 数值在低 RRF K 值下可能过强**：调整：决策 D5 补充——确认 SearchEngineConfig.rrfK 实际值，若 K=60 则 boost 0.15 相对 RRF score（0.016-0.033）过强，降为 0.01/hit 封顶 0.05。
- **S3/S4/S5**：统一 hasVec 模式；标注 embedding 最终一致性窗口；明确 heading_path 不直接参与 FTS 索引。

### 第二轮（已回写）

第二轮独立 Plan agent 对修正后方案审视，命中 3 个阻断 + 7 个重要级 + 5 个建议级 + 4 个对抗性新扫描。全部采纳：

**阻断**：

- **B5 metadata.title 不存在导致 doc_title 恒为 undefined**：M10 修正声称"meta 加 title: doc.title"，但变更 7(c) 代码示例的 meta 构造不含 title。调整：变更 7(c) meta 构造加 `title: doc.title`（feature/research 对称）。
- **B6 cleanMarkdownForFts 不处理 ~~~ 围栏——与 chunkMarkdown 不一致**：M2 让 chunkMarkdown 识别 ~~~ 围栏，但 cleanMarkdownForFts 只清理 ``` 围栏。~~~ 围栏行残留进 FTS 成 trigram 噪声。调整：涉及文件表加 `markdown-noise-cleaner.ts`（加 ~~~ 围栏清理规则，与 ``` 对称）。
- **B7 迁移函数调用位置不明确**：migrateDatabase 在 sync 之前执行，若 migrateFeatureBodyToChunks 被嵌入 migrateDatabase 函数体则违反 B3。调整：变更 10 明确——migrateFeatureBodyToChunks 是独立 export 函数，在 main.ts 中 `syncDocuments.execute()` 之后单独调用，**不加入 migrateDatabase 函数体**。

**重要**：

- **M14 首次启动 sync 失败导致 feature_body 永久残留**：迁移幂等（settings 标记 done 后不再跑），若首次 sync 有 errors，迁移仍执行清掉 feature_body，sync 失败的文档正文索引消失。调整：变更 10 迁移加 `syncErrors: number` 参数，仅当 `syncErrors === 0` 时执行清理。
- **M15 ScoredHit.finalScore 被原地修改——可变性风险**：dedupAndBoostBySource 直接 `best.finalScore += boost` 是 mutation。调整：变更 9 改为创建新对象 `{ ...best, finalScore: best.finalScore + boost, multiHitCount: group.length }`。
- **M16 N 个 chunk embedding 排队阻塞 query embedding**：bge-m3 worker 串行处理，sync 后 546 embedding 排队，实时搜索的 query embed 会阻塞 ~27s。调整：Follow-up 补充"embedding 优先级队列或批量接口"，变更 6 加注释说明此限制。FTS 不受影响。
- **M17 chunkMarkdown 返回空数组时 replaceEntriesBySource 不删旧 chunk**：replaceEntriesBySource 的 `if (entries.length === 0) return` guard 跳过 DELETE。调整：变更 5 移除空数组 return guard（空数组仍执行 DELETE 删旧，不 INSERT），或在 indexFeatureChunks 中空 chunks 时调 deleteBySource。
- **M19 indexResearchChunks 对称性未展示**：调整：变更 8 补充 indexResearchChunks 关键差异（contentType: "research_chunk", sourceTable: "research"）。
- **M20 bodyEntriesIndexed 重命名 API 兼容性**：grep 确认无外部消费者，SyncResult 未暴露 API。确认安全。
- **A4 tool description 文本也要更新**：变更 11 只说 enum 更新，但 tool-factory.ts 的 description 中文说明也含 feature_body。调整：变更 11 明确 description 文本同步更新（feature_body→feature_chunk 等）。

**建议**：

- **S6 charCount 是原始字符数非 FTS 索引字符数**：调整：MarkdownChunk.charCount 注释标注。
- **S8 dedupAndBoostBySource group.sort 稳定性**：调整：加 tie-breaker（按 chunk_index）。
- **S9 前端 heading_path 读取路径**：调整：变更 12 明确 `entry.metadata?.doc_title` 和 `entry.metadata?.heading_path`。
- **S10 迁移 DELETE memory_vec 的空 catch 吞错误**：调整：catch 中 log warn（参照 checkVecTable 模式）。
- **S7 heading_path 在 FTS 中可搜性**：确认 chunk content 含标题文本（清理后保留），验收标准正确。

**第一轮修正确认无新问题**：B1 rawBody/cleanedBody 分离自洽；M6 FTS 预聚合不影响 RRF fusion rank 分布；S2 boost 在 rerank 后 additive 符合 D5。但 S2 boost 0.01/hit 在 RRF 低分区间（0.016）仍是数倍相对提升，审视建议进一步降为 0.005/hit——**保留 0.01/hit 但在测试中验证排序合理性**（见测试章节）。

## Follow-up（明确不在本 PR）

- **chunk 级 hash diff**（D6）：增量同步优化，仅更新变化的 chunk
- **embedding 批量接口**（D7）：减少 worker 往返开销
- **web UI contentType 筛选器**：前端筛选器 UI，后端已就绪
- **chunk overlap**：段落重叠提升检索连续性
- **Task C（PR #130）合并**：chunking 的 embedding 收益依赖 PR #130（F20260803emlo）合并。PR #130 合并前 chunking 的 FTS 部分独立生效，embedding 降级 silent skip；PR #130 合并后自动获得向量检索能力

## 关联

- Issue #124 记忆搜索系统（Task B 遗留的 chunking 问题，本 F 处理）
- F20260803fbit（feature-body-index，基础设施提供者）
- F20260803mval（memory-validator，upsert + replaceBySource 基础设施）
- PR #130（F20260803emlo，embedding 本地加载，chunk embedding 收益依赖）
