---
id: F20260803fbit
title: feature-body-index
doc_type: feature

summary: |
  修复特性/研究文档正文（body）不进 FTS 索引的问题（Issue #124 Task B）。
  根因三处叠加：syncFile 解析 frontmatter 时丢弃 body；indexFeature 签名只收 summary；内容指纹不含 body 导致改 body 不触发 reindex。
  body 作为独立 memory_entry（contentType=feature_body/research_body）与 summary entry 并存；通过 body_hash 列驱动指纹比较、replaceEntryBySource 加 content_type 过滤实现原子替换；并配套 markdown 噪声清理、embedding 截断、搜索结果去重、后端 contentType filter。

causal_links:
  from:
    - F20260803mval   # memory-validator-link-integrity：A 提供 upsert + replaceBySource 基础设施，B 在其上扩 body 索引
    - F20260713m5q3   # domain-memory：记忆系统基础，body 索引是 document layer 的扩展
    - F20260721qh74   # document-data-model：文档数据模型，body 是文档完整性的最后一环

status: design
change_type: feature
tags: [memory, document-sync, fts, search, full-text-index, feature-body]
modules:
  - src/entities/memory/memory-entry.ts
  - src/entities/document/feature.ts
  - src/entities/document/research.ts
  - src/usecases/document/sync-documents.ts
  - src/usecases/conversation/memory-index-gateway.ts
  - src/usecases/memory/store-memory.ts
  - src/usecases/memory/memory-repository.ts
  - src/usecases/memory/search-memory.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - src/main.ts
  - web/src/pages/memory/index.tsx

created_at: 2026-08-03
---

# F20260803fbit 特性文档正文索引

## 背景

### 问题

Issue #124 Task B：用户在 web 记忆页搜《提示词优化》零结果，该词出现在 F20260727b3ka 正文第 70 行，但搜索系统查不到。排查确认是 `indexFeature` 只把 `doc.summary`（≤500 字）灌进 `memory_fts`，**正文（body）完全不索引**。

Task A（F20260803mval，PR #128）已合入，修复了 validator 枚举、DB CHECK、内容漂移、健康端点等链路断裂。A 在设计决策 10 明确："正文索引（Task B）与 embedding 离线（Task C）是独立变更，在各自 PR 创建 F 文档，Issue #124 作跟踪锚点。" 本 F 即 Task B 的设计文档。

### A 已建立的基础设施（B 复用）

1. **upsert sync**（`sync-documents.ts:135-181`）：`syncFeatureDoc` 三分支——新增 / 内容指纹变 update / 真幂等 skip。`indexFeature` 调用在 new + updated 两分支。
2. **`replaceEntryBySource`**（`sqlite-memory-repository.ts:113-161`）：单事务内删旧+插新，`MemoryIndexAdapter.indexFeature` 已改用此原子路径（`main.ts:129-141`）。
3. **`StoreMemory.replaceBySource`**（`store-memory.ts:67-96`）：usecase 层封装。
4. **`SyncResult.warnings`** + 健康端点：链路可观测性就位。

### 根因（三处叠加）

```
磁盘 .md
  -> parseFrontmatterFromContent(content)
     ↑ 断点1: syncFile:111 只解构 frontmatter，丢弃 body
  -> buildFeatureDocument(fm)  [只用 frontmatter 字段]
  -> featureRepo.upsert(doc)
  -> memoryIndex.indexFeature(id, summary, meta)
     ↑ 断点2: 签名只收 summary，body 无传递口
  -> StoreMemory.replaceBySource(content=summary)
  -> memory_fts(content=summary)  ← 只有 ≤500 字进 FTS

  另：featureFingerprint(doc)   ← 断点3: 指纹不含 body，改 body 不触发 reindex
```

### 设计目标

- **正文可搜**：搜正文任意关键词能命中对应特性/研究文档
- **零回归**：summary 索引行为不变；改 body 触发 reindex（与 A 的"内容漂移"承诺对齐）
- **为 chunking 演进铺路**：每文档多 entry 模型天然通向未来分段索引
- **不破坏 A 的基础设施语义**：replaceEntryBySource 升级对 A 既有调用向后兼容

## 变更

### 1. syncFile 接住 body

`sync-documents.ts:111`：
```ts
// 旧
const { frontmatter } = parseFrontmatterFromContent(content);
// 新
const { frontmatter, content: body } = parseFrontmatterFromContent(content);
```

**body 参数传递链**（第二轮审视要求明确）：
```
syncFile 解构 body
  -> syncFeatureDoc(fm, filePath, body, result)    // 新增 body 形参
       -> buildFeatureDocument(fm, filePath, body)  // 算 bodyHash
       -> memoryIndex.indexFeatureBody(doc.id, body, meta)
  -> syncResearchDoc(fm, filePath, body, result)   // 对称
```
当前 `syncFeatureDoc(fm, filePath, result)` 签名要在 `result` 前插入 `body`。

### 2. features/research 表加 body_hash 列

新列驱动指纹比较，避免扩 MemoryIndexGateway 读接口（详见 D6）。

**schema.ts**：features 表与 research 表各加 `body_hash TEXT`（nullable，老数据为 NULL）。

**migration.ts**：幂等迁移 `ALTER TABLE features ADD COLUMN body_hash TEXT` / `ALTER TABLE research ADD COLUMN body_hash TEXT`。SQLite 支持 ADD COLUMN，无需表重建。幂等键用 settings 表 `features_body_hash_added=done` / `research_body_hash_added=done`（参照 F20260803mval 的 settings 幂等先例）。

**feature.ts / research.ts**：FeatureDocument / ResearchDocument 加 `bodyHash?: string | null` 字段。

**buildFeatureDocument** / **buildResearchDocument** 接收 body 参数，计算 hash（建议 sha256 截前 16 字符，足够区分 + 紧凑）：
```ts
import { createHash } from "crypto";
// ...
const bodyHash = body ? createHash("sha256").update(body).digest("hex").slice(0, 16) : null;
```

**feature-mapper.ts / research-mapper.ts**：`FeatureRow` / `ResearchRow` 接口加 `body_hash: string | null` 字段；`rowToEntity` 映射到 `bodyHash`；`entityToRow` 反向映射。

**sqlite-feature-repository.ts / sqlite-research-repository.ts**：`insert` 的 INSERT 列清单加 `body_hash`、`updateContent` 的 UPDATE SET 子句加 `body_hash = ?`。**两处都要改**（第二轮审视指出原设计只提 updateContent 漏了 insert，会导致新文档走 insert 分支时 body_hash 不写库）。

### 3. 指纹改用 body_hash

`featureFingerprint` / `researchFingerprint` 把 body 全文换成 body_hash：
```ts
function featureFingerprint(doc: FeatureDocument): string {
  return [doc.title, doc.summary, doc.bodyHash, doc.changeType, doc.status,
    doc.filePath, JSON.stringify(doc.tags), JSON.stringify(doc.modules),
    JSON.stringify(doc.causalLinksFrom), JSON.stringify(doc.supersedes)].join("|");
  //              ^^^^^^^^^^^ 用 hash 而非 body 全文
}
```

**为什么用 hash 而非全文**：指纹比较两端都需要值。existing 端从 `featureRepo.findById` 来——features 表存 body_hash 列后即可读到；若存 body 全文则表膨胀严重（87 个文档 × 平均 10KB = ~1MB，且 body 与磁盘 .md 重复存储）。hash 紧凑且比较语义清晰。

**featureRepo.updateContent** 和 **featureRepo.insert** 的 SQL 都加 `body_hash = ?`（见上）。

### 4. 升级 replaceEntryBySource 的 DELETE WHERE 加 content_type 过滤

`sqlite-memory-repository.ts:117-129`：
```sql
-- 旧
SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ?
DELETE FROM memory_entries WHERE source_table = ? AND source_id = ?
-- 新
SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?
DELETE FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?
```

参数绑定新增 `entry.contentType`。

**只改 replaceEntryBySource，不改 deleteBySource**（D8 决策）。deleteBySource 语义是"按源全删"，未来归档清理需要删 summary + body 全部的 entry；加 content_type 过滤反而错误。

**向后兼容性**：A 的既有调用（`indexFeature` 传 contentType="feature"、`indexResearch` 传 contentType="research"）每个 sourceId 下只有一种 contentType，加 content_type 过滤后删的集合不变。

### 5. 扩展 MemoryContentType 枚举

`memory-entry.ts:19-24`：
```ts
// 旧
export type MemoryContentType = "message" | "fact" | "linked_resource" | "feature" | "research";
// 新
export type MemoryContentType =
  | "message" | "fact" | "linked_resource"
  | "feature" | "feature_body"
  | "research" | "research_body";
```

不加此扩展 TypeScript 编译失败（审视命中）。

### 6. MemoryIndexGateway 新增 indexFeatureBody / indexResearchBody

`memory-index-gateway.ts`：
```ts
export interface MemoryIndexGateway {
  // ... 既有方法不变 ...
  /** 索引 Feature 文档正文（独立 entry，与 summary entry 并存） */
  indexFeatureBody(id: string, body: string, metadata: Record<string, unknown>): Promise<void>;
  /** 索引 Research 文档正文 */
  indexResearchBody(id: string, body: string, metadata: Record<string, unknown>): Promise<void>;
}
```

`main.ts` 的 `MemoryIndexAdapter` 实现：
```ts
async indexFeatureBody(id: string, body: string, metadata: Record<string, unknown>): Promise<void> {
  await this.storeMemory.replaceBySource({
    layer: "document",
    contentType: "feature_body",
    sourceId: id,
    sourceTable: "features",   // 仍指向真实表，provenance 完整
    conversationId: undefined,
    granularity: "coarse",
    content: body,
    metadata: { ...metadata, part: "body" },
  });
}
// indexResearchBody 对称
```

**metadata 加 `part: "body"`**：方便搜索结果后过滤区分 summary 命中还是 body 命中。

### 7. syncFeatureDoc / syncResearchDoc 调用 body 索引

```ts
private async syncFeatureDoc(fm, filePath, body, result): Promise<void> {
  const doc = this.buildFeatureDocument(fm, filePath, body);
  const existing = await this.featureRepo.findById(doc.id);
  const meta = { doc_type: "feature", change_type: doc.changeType, tags: doc.tags,
                 modules: doc.modules, from: doc.causalLinksFrom, supersedes: doc.supersedes };
  if (!existing) {
    await this.featureRepo.insert(doc);
    await this.memoryIndex.indexFeature(doc.id, doc.summary, meta);
    await this.memoryIndex.indexFeatureBody(doc.id, body, meta);
    result.synced++;
  } else if (featureFingerprint(doc) !== featureFingerprint(existing)) {
    await this.featureRepo.updateContent(doc);
    await this.memoryIndex.indexFeature(doc.id, doc.summary, meta);
    await this.memoryIndex.indexFeatureBody(doc.id, body, meta);
    result.updated++;
  } else {
    result.skipped++;
  }
}
```

指纹比较两端都有 body_hash：`doc.bodyHash`（当前文件算出）vs `existing.bodyHash`（features 表读出）。无 body 变化则指纹等，走 skip 分支不重索引——保 A 的幂等承诺。

### 8. 搜索结果按 sourceId 去重

`search-memory.ts` 的 `rerankAndReturn`（lines 277-308）当前只按 finalScore 排序截断。同一文档的 summary entry 和 body entry 是不同 entryId（不同 UUID），双命中时都会出现，挤占 limit 名额。

**去重插入点**（第二轮审视要求精确）：`rerank` 算出 finalScore 之后、`sort` + `slice` 之前。即：
```ts
const scored = this.rerank(hits, weights);   // 算出 finalScore
const deduped = dedupBySource(scored);        // 新增：按 (sourceTable, sourceId) 分组留高分
deduped.sort((a, b) => b.finalScore - a.finalScore);
return deduped.slice(0, limit);
```

按 `(sourceTable, sourceId)` 分组，同组保留 finalScore 最高者。`message` / `fact` / `linked_resource` 不受影响（sourceId 互不冲突）。

**覆盖范围**：仅 `rerankAndReturn` 路径（即 `searchConversationInternal`）。`searchAllLibraries` 全库搜索走自己的混排逻辑，当前只混排 conversation + terminology，feature_body/research_body 只在 conversation 库 FTS 命中，全库搜索无同文档双命中问题。未来若新增搜索路径索引 feature_body，需同步评估去重需求。

**为什么必在本 PR**：D1 独立 entry 的副作用就是双命中可能；不修等于把副作用留给用户感知。

### 9. embedding 调用前截断防御

`store-memory.ts` 有**两处** `embeddingGateway.embed` 调用（第二轮审视指出原设计漏了第二条路径）：
- `execute`（约 28-62 行）：通用存储路径（message、linked_resource 走此）
- `replaceBySource`（约 67-96 行）：文档 upsert 路径（indexFeature / indexFeatureBody 走此）

**两处都要加截断**。抽个 helper：
```ts
private truncateForEmbed(content: string): string {
  const EMBED_MAX_CHARS = 6000;  // bge-m3 8192 tokens 的 ~75%
  return content.length > EMBED_MAX_CHARS ? content.slice(0, EMBED_MAX_CHARS) : content;
}
// 两处调用前：
const vec = await this.embeddingGateway.embed(this.truncateForEmbed(input.content));
```

条件分支写法对短文本（message 等）只多一次 `.length` 比较，无性能影响。

**FTS 灌清理后 content（见变更 12），embedding 用截断版**——两路独立。FTS 召回不受影响（清理只去语法符号保留内容），embedding 在超长输入下不 OOM。

**为什么在 store-memory 层而非 indexFeatureBody 层**：embedding 是 StoreMemory 内部 fire-and-forget 步骤，截断应在调用点最近的层做，覆盖所有超长 content 源。未来 chunking 后每 chunk 长度可控，此截断自然成为兜底。

### 10. 前端 contentType icon 映射补齐

`web/src/pages/memory/index.tsx:317` 的 `typeIconComponents` 加 `feature_body` / `research_body` 映射，用与 feature/research 相同的图标。

**注**（第二轮审视）：当前代码（约 303 行）已有 fallback `typeIconComponents[e.contentType] || FileText`，且 feature/research 本身就用 FileText 图标——视觉上不加新映射也无差异。补映射仅是语义一致性考虑，**严重程度建议级**，但成本极低（2 行），仍做。

**后端 contentType filter**（SearchFilters 加 contentType 维度）留 follow-up issue。

### 11. sync 完成日志加 bodyEntriesIndexed 计数

`SyncResult` 加 `bodyEntriesIndexed: number`，syncFeatureDoc/syncResearchDoc 的 new + updated 分支累加。`execute` 完成日志输出此字段。运维可对照 features 表数量确认 body 索引覆盖完整。

### 12. body 灌入 FTS / embedding 前做 markdown 噪声清理

**问题**：body 是原始 markdown，含代码围栏（```）、标题井号（###）、列表符号（1. / -）、HTML 注释、加粗（**）等语法符号。trigram tokenizer 把这些切成三元组——搜 "###" 命中所有有标题的文档，搜 "```" 命中所有有代码块的文档，搜 "1." 命中所有有序列表文档。更严重的是 BM25 相关性被稀释：用户搜 `createHash`，所有有 ```ts 代码块开头的文档都部分命中，噪声文档淹没真正讨论该函数的文档。这是搜索质量问题，不是 nice-to-have。

**清理策略**：删语法符号，**保留代码内容和标题文本**（开发者搜函数名要能命中代码块，搜标题要能命中标题）。

新建 `src/usecases/document/markdown-noise-cleaner.ts`（纯函数，无 IO）：
```ts
export function cleanMarkdownForFts(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')          // HTML 注释
    .replace(/^```[^\n]*\n/gm, '')             // 代码围栏开头（保留代码内容）
    .replace(/^```\s*$/gm, '')                 // 代码围栏结尾
    .replace(/^#{1,6}\s+/gm, '')               // 标题井号（保留标题文本）
    .replace(/^\s*[-*+]\s+/gm, '')             // 无序列表符号
    .replace(/^\s*\d+\.\s+/gm, '')             // 有序列表编号
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // 粗体符号
    .replace(/__([^_]+)__/g, '$1')             // 粗体符号（下划线变体）
    .replace(/`([^`]+)`/g, '$1')               // 行内代码符号（保留内容）
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // 链接：保留锚文本去 URL
    .replace(/^\|.*\|$/gm, (m) =>              // 表格：保留内容单元格，去分隔符行
      /^\|[\s:-]+\|/.test(m) ? '' : m.replace(/\|/g, ' ').replace(/^-+$/g, ''))
    .replace(/^\s*>\s?/gm, '')                 // 引用符号
    .replace(/\n{3,}/g, '\n\n')                // 多空行合并
    .trim();
}
```

**FTS 和 embedding 都用清理后版本**：噪声更少提升两路质量。原始 body 不单独存（features 表只存 body_hash；body 全文在 .md 文件里，需要展示时从磁盘读）。

**调用点**：在 `syncFeatureDoc` / `syncResearchDoc` 算 bodyHash 和调 indexFeatureBody 之前，body 经 cleanMarkdownForFts 处理一次，清理结果同时用于算 hash 和索引（保证一致性——清理逻辑改了会触发 bodyHash 变化自然 reindex）。

**body_hash 输入是清理后 body 还是原始 body**：用**清理后**。这样未来清理策略改了（加新规则），body_hash 全部变化触发 reindex，FTS 内容自动更新。如果用原始 body 算 hash，清理逻辑改了但 hash 不变，FTS 永远是旧清理结果。

### 13. 后端 contentType filter

**问题**：当前 `SearchFilters`（`memory-repository.ts:8-12`）只有 layer/granularity/conversationId 三个维度。用户想"只在正文里搜"（如记得某段代码见过某函数名）或"只看 summary 概要"都做不到——layer="document" 强制返回 summary + body 混排。这是检索粒度基本功，不是优化。

**改动**：

`memory-repository.ts` SearchFilters 接口加：
```ts
export interface SearchFilters {
  layer?: MemoryLayer;
  granularity?: MemoryGranularity;
  conversationId?: string;
  contentType?: MemoryContentType[];   // 新增，支持多选 IN 查询
}
```

`sqlite-memory-repository.ts` 的 `searchFTS` 和 `searchVec` 的 WHERE 子句加：
```ts
if (filters.contentType?.length) {
  whereClauses.push(`me.content_type IN (${filters.contentType.map(() => '?').join(',')})`);
  params.push(...filters.contentType);
}
```

`search-memory.ts` 的 SearchQuery 接口加 `contentType?: MemoryContentType[]`，透传到 SearchFilters。

`memory-controller.ts` 接受查询参数 `contentType`（逗号分隔，如 `?contentType=feature_body,feature`），解析成数组透传。

agent 端 `tool-factory.ts` 的 search_memory 工具参数加 `contentType` 可选字段，描述说明支持 `feature` / `feature_body` / `research` / `research_body` / `message` / `fact` / `linked_resource`。

web UI 暂不加筛选器（前端工作量独立），后端就绪后前端可后续接入。

**为什么用数组而非单值**：用户可能想"feature + feature_body 都搜"（同文档双证据源混排）或"feature_body + research_body"（只搜正文不搜概要）。数组支持多选更灵活。

## 设计决策

## 设计决策

### D1. body 作为独立 entry（保留，论据修正）

曾考虑合并方案（content = summary + body，单 entry）。**选定独立**。

**修正后的核心理由**（审视指出原"BM25 doc length 归一化稀释"论据在 trigram tokenizer + phrase query 配置下不成立）：
1. **chunking 演进铺路**：每文档多 entry 模型天然通向未来分段索引；合并方案未来 chunking 要重设架构
2. **同文档双证据源**：summary + body 都命中时 RRF 融合后 ranking 更高（去重前双命中是正信号）
3. **语义清晰**：summary entry 与 body entry 各司其职，contentType 明确区分
4. **embedding 颗粒度独立**：summary 的 embedding 是高密度语义压缩，body 的 embedding 是细颗粒度覆盖，分开比合并更合理

### D2. 升级 replaceEntryBySource 加 content_type 过滤

而非伪造 sourceTable / sourceId 后缀绕开冲突。理由：
- `sourceTable` 应指向真实数据库表，伪造破坏 provenance 链
- `sourceId` 应是文档真实 ID，加后缀破坏搜索结果回溯
- 加 content_type 过滤是语义正确的修复——A 引入时只考虑单 contentType，本就是潜在 bug

### D3. 不做 chunking

验收只需"提示词优化"命中，单 body entry 已满足（FTS5 对长文档无硬限制，trigram tokenizer + phrase query 下召回与文档长度几乎无关）。chunking 引入分段策略、chunk 元数据、多 entry 管理的复杂度，是独立设计。D1 的"独立 entry"模型天然通向 chunking，无需返工。

### D4. embedding 截断在 store-memory 层做

而非 indexFeatureBody 层。embedding 是 StoreMemory 内部步骤，截断应在调用点最近的层做，覆盖所有超长 content 源。bge-m3 上限 8192 tokens（约 6000-8000 中文字符），截到 6000 字符留 75% 余量。FTS 路独立灌全量，召回不受影响。

### D5. 已有 summary-only entry 通过指纹变化自动 reindex

指纹加 body_hash 后，所有现有文档的指纹都会变（body_hash 字段从无到有），下次启动 sync 全部走 updated 分支，自然补 body 索引。零迁移脚本。174 次 replaceBySource 约 350-870ms，embedding 异步不阻塞启动，可接受。

### D6. body_hash 列方案（替代裸 body 比较）

审视指出指纹比较 existing 端的 body 来源是薄弱点：(a) MemoryIndexGateway 无 read 接口，扩接口破坏单一职责且跨 usecase 域依赖；(b) 引入额外机制；(c) 每次全量 reindex 破坏 A 的幂等承诺。

**选定 body_hash 列方案**：
- features/research 表加 `body_hash` 列，FeatureDocument/ResearchDocument 加 `bodyHash` 字段
- syncFile 读文件得 body，算 sha256 前 16 字符
- fingerprint 用 body_hash 而非 body 全文（紧凑 + 语义清晰）
- existing.bodyHash 从 featureRepo.findById 直接拿到，无需扩 gateway 读接口
- body 无变化则指纹等，走 skip 分支保幂等

代价：加一列 + 一次 ADD COLUMN 迁移（SQLite 支持，无需表重建）。远小于其他选项。

### D7. 搜索结果按 sourceId 去重

D1 独立 entry 的副作用是同文档双命中挤占 limit 名额。在 `rerankAndReturn` 排序截断前按 `(sourceTable, sourceId)` 分组，同组保留 finalScore 最高者。message/fact/linked_resource 不受影响。

### D8. deleteBySource 不改（修正原"对称修复"）

原设计曾考虑对称修复 `deleteBySource` 也加 content_type 过滤。审视指出此方法语义是"按源全删"——未来文档归档清理需要删 summary + body + (未来 chunk) 全部 entry。加 content_type 过滤反而错误。只改 replaceEntryBySource。

### D9. markdown 噪声必须清理（用户第三轮挑战纠正）

原设计把噪声清理列为 follow-up，理由"trigram 高密度 token 部分缓解 / 用户极少搜符号"。用户挑战后重新评估：这是搜索质量问题不是 nice-to-have。trigram 把 `## 标题` 切成 `"## "` / `"# 标"` / `" 标题"` 等噪声三元组，搜 `createHash` 时所有有 ```ts 代码块开头的文档都部分命中，噪声文档淹没真正相关的文档。清理策略：删语法符号保留代码内容和标题文本（变更 12）。body_hash 用清理后 body 算，清理逻辑改了自然触发 reindex。

### D10. contentType filter 必须纳入（用户第三轮挑战纠正）

原设计把 contentType filter 列为 follow-up，理由"PR 范围聚焦"。但用户明确"我没定 PR 边界，只要最终效果"。重新评估：当前 layer="document" 强制 summary+body 混排，用户想"只搜正文"或"只搜概要"做不到——这是检索粒度基本功。纳入变更 13，覆盖 SearchFilters 接口 + searchFTS/searchVec SQL + controller + agent 工具参数。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/entities/memory/memory-entry.ts` | MemoryContentType 加 feature_body / research_body |
| `src/entities/document/feature.ts` | FeatureDocument 加 bodyHash 字段 |
| `src/entities/document/research.ts` | ResearchDocument 加 bodyHash 字段 |
| `src/usecases/document/sync-documents.ts` | syncFile 解构 body；body 参数传递链；指纹用 body_hash；buildXxxDocument 接 body 算 hash；调 cleanMarkdownForFts；syncFeatureDoc/syncResearchDoc 调 body 索引；SyncResult 加 bodyEntriesIndexed |
| `src/usecases/document/markdown-noise-cleaner.ts` | 新增：cleanMarkdownForFts 纯函数 |
| `src/usecases/conversation/memory-index-gateway.ts` | 新增 indexFeatureBody / indexResearchBody 接口 |
| `src/usecases/memory/store-memory.ts` | execute + replaceBySource 两处 embedding 调用前截断 content 到 6000 字符 |
| `src/usecases/memory/memory-repository.ts` | SearchFilters 加 contentType 数组维度；接口注释更新（replaceEntryBySource 语义按 type 删） |
| `src/usecases/memory/search-memory.ts` | SearchQuery 加 contentType；rerankAndReturn 加按 (sourceTable, sourceId) 去重（rerank 后、sort+slice 前） |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | replaceEntryBySource 的 DELETE/SELECT WHERE 加 content_type（deleteBySource 不改）；searchFTS/searchVec 的 WHERE 加 contentType IN 过滤 |
| `src/frameworks/db/schema.ts` | features / research 表加 body_hash 列 |
| `src/frameworks/db/migration.ts` | ADD COLUMN 迁移（幂等） |
| `src/frameworks/db/document/feature-mapper.ts` | FeatureRow 加 body_hash；rowToEntity / entityToRow 映射 |
| `src/frameworks/db/document/research-mapper.ts` | ResearchRow 加 body_hash；rowToEntity / entityToRow 映射 |
| `src/frameworks/db/document/sqlite-feature-repository.ts` | insert 的 INSERT 列清单 + updateContent 的 UPDATE SET 加 body_hash |
| `src/frameworks/db/document/sqlite-research-repository.ts` | 同上 |
| `src/main.ts` | MemoryIndexAdapter 实现 indexFeatureBody / indexResearchBody |
| `src/interface-adapters/http/controllers/memory-controller.ts` | 接受 contentType 查询参数（逗号分隔）透传 |
| `src/interface-adapters/agent/tool-factory.ts` | search_memory 工具参数加 contentType 可选 |
| `web/src/pages/memory/index.tsx` | typeIconComponents 加 feature_body / research_body 映射 |

## 验收

- 搜"提示词优化"（F20260727b3ka 正文）能命中
- 搜文档正文中其他关键词（如某个代码块里的函数名）能命中对应特性文档
- summary 仍可搜（不回归）
- 改文档正文，重新 sync 后能搜到新内容（依赖指纹加 body_hash）
- 启动同步日志：updated 数量从 0 升至 ~46（首次启动时所有 summary-only 文档指纹变触发 reindex 补 body）；bodyEntriesIndexed 数与 features/research 表非 archived 文档数一致
- 同一文档 summary + body 同时命中，搜索结果只出现 1 条（高分者）
- TypeScript 编译通过（MemoryContentType 枚举扩展生效）
- 健康端点 `GET /api/health/memory` 不退化
- **噪声清理验收**：搜 "```" 或 "###" 不命中所有文档（命中数显著下降，仅命中正文里真有这些字符序列的文档）；搜 `createHash` 等代码符号能命中真正讨论该符号的文档，不被有 ```ts 代码块开头的噪声文档淹没
- **contentType filter 验收**：API 传 `?contentType=feature_body` 只返回 body entry；传 `?contentType=feature,feature_body` 返回 summary + body 混排（去重前）；agent search_memory 工具传 contentType 参数生效

## 测试

### 单元

- `featureFingerprint` 含 body_hash 时，body 变更（hash 变）触发 fingerprint 不等
- `parseFrontmatterFromContent` 返回的 body 内容正确（含代码块、多行 YAML 后正文、BOM strip 后的 body）
- `buildFeatureDocument` / `buildResearchDocument` 接 body 后正确计算 body_hash
- `indexFeatureBody` 调用 `replaceBySource` 时传 contentType="feature_body"、sourceTable="features"
- `MemoryContentType` 联合类型加新值后无类型错误
- `cleanMarkdownForFts` 各分支：HTML 注释 / 代码围栏（保留内容）/ 标题井号（保留文本）/ 列表符号 / 粗体 / 行内代码 / 链接（保留锚文本）/ 表格 / 引用 / 多空行合并
- `cleanMarkdownForFts` 边界：空字符串、纯 frontmatter 残留、超长 body
- `truncateForEmbed` 边界：短文本不截断、长文本截到 6000、空字符串
- 搜索 SQL contentType 过滤：单值 / 多值 / 不传

### 集成

- 首次 sync：new 分支调用 indexFeature + indexFeatureBody 各一次
- 改 body 再 sync：updated 分支触发，body entry 被 replaceBySource 原子替换
- 不改任何内容再 sync：skip 分支，不调 indexFeatureBody（body_hash 不变）
- replaceEntryBySource 加 content_type 后：indexFeature 不删 body entry，indexFeatureBody 不删 summary entry（共存验证）
- store-memory embedding 截断：content >6000 字符时 embed 收到的是截断版，FTS 收到的是清理+全量
- 搜索结果去重：构造同 sourceId 的 summary + body 双命中场景，rerankAndReturn 只返回高分者
- migration 幂等：ADD COLUMN 跑两次不报错
- 噪声清理集成：body 含代码块/标题/列表的文档，sync 后 memory_fts 里 content 不含 ``` / ### / 1. 等语法符号
- contentType filter 集成：传 `contentType=feature_body` 搜索只返回 body entry；传 `contentType=feature,feature_body` 返回混排（去重前）

### 测试基础设施更新

- `sync-documents.test.ts` 的 fixture `FEATURE_FM` 已含 body 格式（`"---\n...\n---\n# 正文\n"`），无需新加 fixture 文件
- mock 更新：`memoryIndex` mock 加 `indexFeatureBody: vi.fn()` / `indexResearchBody: vi.fn()`（实现 MemoryIndexGateway 新接口）
- mock 更新：`makeStatefulFeatureRepo` 的 `makeDoc` helper 加 `bodyHash` 字段（否则 fingerprint 两端不对齐）
- 集成测试用真实 SQLite DB 时无需改 mapper（mapper 自身被测）

### 端到端

- 搜正文关键词命中对应文档
- 搜 summary 关键词仍命中（不回归）
- 健康端点 `/api/health/memory` 返回值不退化
- 前端记忆页 feature_body / research_body 的 icon 正确显示（不 fallback）
- 搜 "```" 不命中所有有代码块的文档（噪声清理生效）
- API 传 `?contentType=feature_body` 只返回 body entry

## 对抗审视记录

### 第一轮（已回写）

经一轮独立 Plan agent 对抗审视，命中 3 个阻断 + 5 个重要级 + 2 个建议级，全部采纳：

**阻断**：
- **B1 BM25 论据错误**：原 D1 以"BM25 doc length 归一化稀释 summary 信号"为独立 entry 的核心理由。审视指出项目用 trigram tokenizer + phrase query（schema.ts:167-171、fts-utils.ts），doc length 归一化影响微乎其微。调整：保留独立 entry 决策，论据换为"chunking 铺路 + 双证据源 + 语义清晰 + embedding 颗粒度独立"。
- **B2 MemoryContentType 枚举漏改**：memory-entry.ts:19-24 的联合类型未扩展，feature_body/research_body 非合法值，TS 编译失败。调整：涉及文件表补 memory-entry.ts 改动（变更 5）。
- **B3 待审视点 E 不可行**：原设计留 (a)/(b)/(c) 三选项给指纹比较 existing.body 来源。审视指出 (a) 不可行（gateway 无读接口、跨域依赖）、(c) 语义错（破坏 A 的幂等承诺），提出第四选项 (d) features 表加 body_hash 列。调整：采用 (d)，新增变更 2（schema + migration）+ 变更 3（指纹改用 hash），撤回原待审视点 E。

**重要**：
- **B4 搜索结果无 sourceId 去重**：summary + body 双命中挤占 limit 名额。调整：新增变更 8（rerankAndReturn 去重）+ 决策 D7。
- **B5 SearchFilters 无 contentType filter**：前端 icon 映射遇新值 fallback。调整：本 PR 补前端 icon（变更 10），后端 filter 留 follow-up。
- **B6 embedding 无截断**：bge-m3 8K token 上限，超长 body 让 worker OOM/crash。调整：新增变更 9（store-memory 层截断 6000 字符）+ 决策 D4。
- **B7 deleteBySource 不应改**：原"对称修复"直觉错误，此方法语义是"按源全删"。调整：撤回对称修复，只改 replaceEntryBySource（变更 4 + 决策 D8）。
- **B8 测试策略缺失**：调整：新增测试章节。

**建议**：
- **B9 D5 全量 reindex 观测**：调整：新增变更 11（bodyEntriesIndexed 计数）。
- **B10 body markdown 噪声**：代码围栏/井号/HTML 注释进 FTS 降低信噪比。**留 follow-up**——代码块里的函数名有搜索价值，清理策略需专门设计，不混入本 PR。

### 第二轮（已回写）

第二轮独立 Plan agent 对修正后方案审视，命中 2 个重要 + 4 个建议级，全部采纳：

**重要**：
- **R1 涉及文件表漏 4 个 mapper/repository 文件**：feature-mapper.ts、research-mapper.ts、sqlite-feature-repository.ts、sqlite-research-repository.ts。`FeatureRow`/`ResearchRow` 接口、`rowToEntity`、`entityToRow`、`insert` SQL、`updateContent` SQL 都要同步加 body_hash。否则 `findById` 返回的 bodyHash 永远 undefined（指纹比较两端不匹配，每次启动全量 reindex 破坏幂等）、新文档走 insert 时 body_hash 不写库。调整：涉及文件表补 4 文件，变更 2 明确 insert SQL 也要改（撤回原只提 updateContent 的疏漏）。
- **R2 store-memory 截断两条路径**：Task A 后 store-memory.ts 有 `execute` 和 `replaceBySource` 两个方法都调 `embeddingGateway.embed`。indexFeature/indexFeatureBody 走 replaceBySource。截断只加 execute 会漏 body 索引路径。调整：变更 9 明确两处都加截断，抽 `truncateForEmbed` helper。

**建议**：
- **R3 去重位置精确化**：应在 rerank 算出 finalScore 之后、sort+slice 之前。按 rrfScore 去重可能丢掉时间衰减后本应排更高的 entry。调整：变更 8 给出精确代码位置。
- **R4 buildFeatureDocument 签名传递链**：body 参数从 syncFile → syncFeatureDoc → buildFeatureDocument 一路下传，设计文档原变更 1/2/7 没明示传递链。调整：变更 1 补传递链说明。
- **R5 测试 fixture mock 更新**：现有 `FEATURE_FM` fixture 已含 body 格式，但 mock 需更新（memoryIndex mock 加新方法、makeDoc helper 加 bodyHash 字段）。调整：测试章节补"测试基础设施更新"小节。
- **R6 前端 fallback 已存在**：当前 `typeIconComponents[e.contentType] || FileText` 已有 fallback，且 feature/research 本身用 FileText，视觉上不加映射无差异。调整：变更 10 注明严重程度建议级，但因成本极低仍做。
- **R7 searchAllLibraries 路径暂不受影响**：全库搜索只混排 conversation + terminology，feature_body 只在 conversation 库 FTS 命中，无同文档双命中问题。调整：变更 8 注明去重覆盖范围仅 rerankAndReturn 路径，未来新增搜索路径索引 feature_body 时需同步评估。

**第一轮修正确认无新问题**：body_hash ADD COLUMN 与现有 schema 无冲突；sha256 前 16 字符（64 bit）碰撞概率对 87 文档量级约 2.1e-16 可忽略；MemoryContentType 无 exhaustive switch 风险；SyncResult 加字段安全；reconcileType 泛型约束不受影响；deleteBySource 不改决策正确。

### 第三轮（用户挑战，已回写）

用户对"明确不做"清单的挑战纠正两个误判：

- **U1 markdown 噪声清理必须做**：原设计列为 follow-up，理由"trigram 高密度 token 部分缓解 / 用户极少搜符号"。用户挑战后重新评估--trigram 把 `## 标题` 切成噪声三元组，搜 `createHash` 时所有有 ```ts 代码块开头的文档都部分命中，噪声文档淹没真正相关文档。这是搜索质量问题不是 nice-to-have。调整：纳入变更 12 + 决策 D9。
- **U2 contentType filter 必须纳入**：原设计列为 follow-up，理由"PR 范围聚焦"。用户明确"我没定 PR 边界，只要最终效果"。当前 layer="document" 强制 summary+body 混排，用户想"只搜正文"或"只搜概要"做不到--检索粒度基本功。调整：纳入变更 13 + 决策 D10。
- **U3 chunking 真实收益但另开 issue**：用户认可 chunking 理想效果真实（精确定位/BM25 排序/embedding 质量/multi-hit/RAG），但成本数量级上升（分段策略/元数据/聚合/增量同步/embedding ×10）+ embedding 收益依赖 Task C。已评论 Issue #124 建议另开专属 issue，本 PR 不做但架构已铺路。

## Follow-up（明确不在本 PR）

- **chunking**：U3 决策。已评论 Issue #124 建议另开专属 issue。本 PR 的"独立 entry + body_hash + replaceEntryBySource content_type 过滤"基础设施已为其铺路，未来 chunk 只是更细颗粒度 entry。
- **Task C embedding 离线**：Issue #124 Task C，独立 PR。本 PR 的 embedding 截断防御让 Task C 修好后 body 自动获得向量检索能力。
- **web UI contentType 筛选器**：变更 13 只做后端就绪，前端筛选器 UI 工作量独立，后续接入。

## 关联

- Issue #124 记忆搜索系统 4 个独立缺陷（Task B 本 F；Task C embedding 离线待修；Task D 补 frontmatter 进行中）
- F20260803mval（Task A）合入提供 upsert + replaceBySource 基础设施
