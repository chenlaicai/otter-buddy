---
id: F20260730m9k1
title: memory-web-capability-parity
doc_type: feature

# 记忆索引
summary: |
  Web 端记忆搜索页面当前仅实现了最基础的关键词搜索+标记功能，后端已有的渐进式披露、术语库搜索、相似检索、展开上下文等能力均未暴露给用户。用户明确提出"可用的记忆召回能力必须和海獭具备的一样"。本文档分析 Web 端与 Agent 端的完整差距，设计补齐方案。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716szw8
    - F20260713u9v4
    - F20260713m5q3


# 元数据
status: draft
change_type: feature
tags: [memory, web, frontend, parity, retrieval]
modules: [web/src/pages/memory, web/src/api, interface-adapters/http]

# 时间
created_at: 2026-07-30
---


# F20260730m9k1 [memory] Web 端记忆能力对齐

## [design-time]

> 本文档分析 Web 端记忆搜索页面与 Agent 端记忆召回能力的完整差距，并设计补齐方案。核心原则：**用户可用的记忆召回能力必须和海獭具备的一样。**

## 背景 [required]

### 问题

Web 端记忆搜索页面（`web/src/pages/memory/index.tsx`）当前仅实现了最基础的功能：
- 关键词搜索（不传 detail_level、library 参数）
- 用户标记（flagMemory）
- 占位的"展开上下文"和"查找相似"按钮

而后端已具备完整的记忆检索能力（FTS5 + vec0 混合检索、渐进式披露、术语库、相似检索），Agent 端也已通过工具链完整接入。**Web 端只用了约 30% 的后端能力。**

用户明确要求：**"我可用的这个记忆召回/记忆搜索能力，必须和海獭具备的记忆召回能力是一样的。"**

### 约束输入

- F20260716szw8: 渐进式披露机制已实现（detail_level: summary/snippet/full）
- F20260713u9v4: UI 前端设计文档，记忆搜索页面规格
- F20260713m5q3: domain/memory 模块已实现（FTS5 + vec0 + RRF + 权重重排）
- 后端 API 已全部就绪：search（含 detail_level/library）、batch、getById、search/similar
- Agent 端工具已全部就绪：search_memory、get_memory_detail、search_terminology、add_terminology
- Web 前端当前不调用 detail_level、library 参数，不调用 batch/similar 端点

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| 对齐原则 | Web 端记忆能力必须与 Agent 端对等 | 用户明确指令 |
| 改动范围 | 仅 Web 前端 + API Client，后端不改动 | 后端能力已完整 |
| 术语库入口 | 集成在记忆搜索页面中，不单独建页面 | 用户体验一致性 |

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前讨论 | 我可用的这个记忆召回/记忆搜索能力，必须和海獭具备的记忆召回能力是一样的 | 必须、一样 | Web 端能力必须与 Agent 端完全对等 |
| UA-2 | 当前讨论 | 我根本无法用起来 | 无法用 | 当前 Web 端功能残缺到无法正常使用 |
| UA-3 | 当前讨论 | 当前 web 上还有《上下文详情将在后续版本中展示》这种残留问题 | 残留问题 | 占位文本必须清除，功能必须实现 |

## 现状差距分析 [required]

### 一、后端能力 vs 前端使用

| 后端 API | 功能 | Agent 端 | Web 端 |
|----------|------|----------|--------|
| `GET /api/memory/search` | 记忆检索 | search_memory 工具，传 detail_level + library | searchMemory() 不传 detail_level/library |
| `GET /api/memory/batch?ids=...` | 批量获取完整内容 | get_memory_detail 工具 | 未调用 |
| `GET /api/memory/:id` | 单条详情 | 未使用（Agent 用 batch） | 未调用 |
| `POST /api/memory/search/similar` | 相似记忆检索 | 未使用 | 占位 showToast |
| `PATCH /api/memory/:id/flag` | 用户标记 | 未使用 | 已实现 |

### 二、功能缺口清单

| # | 缺口 | 影响 | 优先级 |
|---|------|------|--------|
| G0 | `layer` 过滤器从未生效 | 前端有"记忆层"下拉（working/historical），但后端 controller 不读取 `layer` 参数，用户选择后被静默忽略。**现有 bug，已修复后端 layer 支持** | P0 |
| G1 | 搜索不传 detail_level | 返回固定 snippet 级别，无法快速浏览（summary）或查看完整内容（full） | P0 |
| G2 | "展开上下文"是空壳 | 后端 batch API 已就绪，前端未接入；残留占位文本"上下文详情将在后续版本中展示" | P0 |
| G3 | 没有术语库搜索入口 | Agent 可搜索术语库，Web 用户不能 | P0 |
| G4 | 搜索不传 library | 无法显式选择搜索 conversation 库还是 terminology 库 | P1 |
| G5 | "查找相似"是空壳 | 后端 /search/similar 已就绪，前端未接入 | P1 |
| G6 | snippet 字段未使用 | 后端 FTS5 highlight 生成了带 `<b>` 标记的 snippet，前端直接显示全文 | P1 |
| G7 | 无来源标记（fts/vec/both） | 用户不知道结果是全文匹配还是语义匹配 | P2 |
| G8 | 无 content type 过滤 | 后端 SearchQuery 不支持 contentType 过滤，需后端改动 | P2（后端依赖） |
| G9 | 搜索结果无 snippet/full 切换 | 渐进式披露在 Web 端无交互体现 | P1 |

## 目标 [required]

### T1 — 搜索能力对齐（P0）

Web 端搜索页面支持 Agent 端 search_memory 工具的全部参数：
- detail_level: summary / snippet / full
- library: conversation / terminology / 全库
- 结果展示 snippet（高亮匹配片段）而非全文

### T2 — 展开上下文实现（P0）

点击"展开上下文"调用 `GET /api/memory/:id` 获取单条完整内容，在 Modal 中展示。清除占位文本。

### T3 — 术语库搜索集成（P0）

搜索页面支持切换到术语库搜索模式，展示术语的 definition、aliases、context 等字段。

### T4 — 查找相似实现（P1）

点击"查找相似"调用 `POST /api/memory/search/similar`，展示相似记忆列表。

### T5 — 渐进式披露交互（P1）

搜索结果默认展示 snippet，提供"查看详情"按钮切换到 full 内容。与 Agent 端的渐进式披露协议对齐。

### T6 — 来源标记展示（P2）

- 搜索结果显示来源标记（fts/vec/both）

## 非目标 [required]

- 不修改后端 API（后端能力已完整）
- 不修改 Agent 端工具（Agent 端已对齐）
- 不实现记忆写入功能（写入由后端生命周期自动完成）
- 不实现记忆删除（设计为 append-only）
- 不修改混合检索引擎算法
- **不实现 content type 过滤**：后端 `SearchQueryDTO` 和 `SearchMemory` 不支持 contentType 参数，实现需要后端改动，超出本文档"仅前端"约束。需单独文档设计后端扩展。
- **不实现搜索结果分页**：当前使用 `limit` 控制数量即可，分页留待后续
- **"细化搜索"功能保留但不改造**：现有"细化搜索"Modal（调整查询词重新搜索）保留原样，与新增的 `detail_level`/`library` 过滤器独立运作。后续可考虑合并到搜索面板中

## 设计 [required]

### D1 — API Client 扩展

**文件**: `web/src/api/client.ts`

**G0 修复**：后端 controller 原本不读取 `layer` 参数（前端有 UI 但被静默丢弃）。实际修复方案：**补上后端 layer 支持**（SearchQuery + controller + filters），保留前端"记忆层"下拉，使其真正生效。比原设计文档的"移除 layer"方案更好——功能完整。

新增/改造函数：

```typescript
// 1. 增强搜索：保留 layer（后端已修复支持），新增 detail_level 和 library
export function searchMemory(params: {
  query: string;
  limit?: number;
  layer?: string;                                     // 保留，后端已支持
  granularity?: string;
  conversationId?: string;
  detail_level?: 'summary' | 'snippet' | 'full';  // 新增
  library?: string;                                   // 新增
}): Promise<SearchResultDTO>

// 2. 获取单条记忆详情（展开上下文 / 查看详情用）→ GET /api/memory/:id
export function getMemoryById(id: string): Promise<MemoryEntryDTO>

// 3. 相似记忆检索 → POST /api/memory/search/similar
export function searchSimilar(memoryEntryId: string, limit?: number): Promise<SearchResultDTO>
```

**说明**：`getMemoryById` 同时服务于 D3"查看详情"和 D4"展开上下文"（同一操作，不同入口），返回单个 `MemoryEntryDTO`。`getMemoryDetails`（batch 端点）当前无调用方，暂不纳入 API Client，后续如需批量获取再补充。

### D2 — 搜索面板增强

**文件**: `web/src/pages/memory/index.tsx`

左侧面板改造：
- **保留**："记忆层"下拉（working/historical）— G0 修复后端 layer 支持，过滤器现在真正生效
- **保留**："粒度"下拉（coarse/fine）— 后端实际使用此参数。tooltip："控制搜索范围：粗粒度搜索标题和摘要，细粒度搜索完整内容"
- **新增**："库选择" — radio group 或 tabs：全部 / 对话库 / 术语库
- **新增**："详细程度" — select：summary / snippet（默认） / full。tooltip："控制返回内容量：摘要/片段/全文"

粒度（granularity）和详细程度（detail_level）是两个正交维度：粒度控制搜索范围（索引的哪些字段参与匹配），详细程度控制返回内容量（匹配后返回多少内容）。UI 上通过 tooltip 区分。

当选择术语库时，搜索走 `/api/memory/search?library=terminology`，结果展示适配术语字段。当选择"全部"时，不传 library 参数，后端自动全库混排。

**搜索竞态处理**：使用 `useRef` 保存递增 requestId，每次搜索前递增，请求回调中检查 requestId 是否匹配，不匹配则丢弃过期响应：
```typescript
const requestIdRef = useRef(0)
async function doSearch() {
  const myId = ++requestIdRef.current
  // ... 发起请求
  // 在 setState 前检查：
  if (myId !== requestIdRef.current) return  // 过期响应，丢弃
  setResults(result.entries)
}
```

**粒度空值行为**："全部"选项 value 为空字符串，`doSearch` 中发送时转为 undefined（`granularity: granularity || undefined`），不传该参数给后端。现有代码已实现此逻辑，保留不变。

### D3 — 搜索结果卡片改造

**改造项**：
1. 默认展示 snippet（带 `<b>` 高亮），而非全文 content
2. snippet 为空时降级展示 content 前 200 字符
3. 新增"查看详情"按钮 → 与"展开上下文"同一操作，调用 `getMemoryById(id)` 获取 full 内容后展开（见 D4）
4. 来源标记映射表：

| 后端 `source` 值 | 前端展示文本 | 说明 |
|-----------------|------------|------|
| `"fts"` | "全文匹配" | 仅 FTS5 匹配 |
| `"vec"` | "语义匹配" | 仅 vec0 向量匹配 |
| `"both"` | "混合匹配" | FTS5 + vec0 均匹配 |

**注意**：`source` 在搜索结果中始终存在（controller 始终传递 `e.source`）。非搜索端点（如 `getMemoryById`）返回的 DTO 不含 `source`，前端不显示来源标记即可。

**snippet 渲染安全**：后端 FTS5 `highlight()` 在 content 中插入 `<b>` 标记，但 content 本身是用户/LLM 生成的文本，可能含 HTML。**不使用 dangerouslySetInnerHTML**，而是用正则拆分后 React 组件渲染：
```typescript
// FTS5 highlight() 始终输出小写 <b>/</b>，正则大小写敏感
// 用户内容中的 <B> 等变体不会被误判为高亮标记（正确行为）
const parts = snippet.split(/<\/?b>/)
// 偶数索引为普通文本（<span>），奇数索引为高亮文本（<mark>）
return parts.map((text, i) =>
  i % 2 === 1 ? <mark key={i}>{text}</mark> : <span key={i}>{text}</span>
)
```

**已知限制**：如果用户/LLM 生成的内容本身包含小写 `<b>` 标签（如保存的 HTML 内容），会被误判为高亮标记。可接受：(1) 记忆内容通常是纯文本；(2) 视觉影响仅是多余高亮，无安全风险。

### D4 — 展开上下文 Modal 实现

**方案 A：单条详情（推荐）**：
- 点击"展开上下文"直接调用 `GET /api/memory/:id` 获取该条目 full 内容
- Modal 中展示完整内容 + metadata（layer、contentType、createdAt、conversationId）
- 清除占位文本"上下文详情将在后续版本中展示"
- 渐进式披露原则：先看单条完整内容，需要更多上下文时通过"查找相似"获取

**方案 B：关联记忆**：
- 记录当前条目的 conversationId
- 调用 `GET /api/memory/search?conversationId={id}&limit=10&detail_level=snippet` 获取该对话的其他记忆
- Modal 中展示：当前条目全文 + 该对话的其他相关记忆列表
- scope 更大，实现更复杂

**决策**：采用方案 A。理由：渐进式披露的核心是"按需获取"，展开上下文应先展示单条完整内容，避免 Modal 内容过多。

**状态管理设计**：

现有代码中 `expandCtx` 是 `boolean`，需改造为关联具体条目的状态。新增 state 变量：

```typescript
// 展开上下文 Modal
const [expandEntryId, setExpandEntryId] = useState<string | null>(null)  // 当前展开的条目 ID，null = 关闭
const [expandEntry, setExpandEntry] = useState<MemoryEntryDTO | null>(null)  // 加载后的完整条目
const [expandLoading, setExpandLoading] = useState(false)

// 查找相似 Modal
const [similarEntryId, setSimilarEntryId] = useState<string | null>(null)  // 当前查找相似的条目 ID，null = 关闭
const [similarResults, setSimilarResults] = useState<MemoryEntryDTO[]>([])
const [similarLoading, setSimilarLoading] = useState(false)
```

**展开上下文状态转移**：
```
点击"展开上下文"/"查看详情" → setExpandEntryId(id), setExpandLoading(true)
  → 调用 getMemoryById(id) → 返回 MemoryEntryDTO
  → 成功: setExpandEntry(data), setExpandLoading(false)
  → 失败: setExpandLoading(false), Modal 内显示错误提示
关闭 Modal → setExpandEntryId(null), setExpandEntry(null)
点击另一条目 → 重新走上述流程（复用 Modal，重新加载）
```

`expandEntry` 为 `MemoryEntryDTO` 类型，Modal 直接读取其 `content`/`metadata`/`createdAt` 等字段。`conversationId` 为 `null` 时（术语条目）不显示该行。

**查找相似状态转移**：
```
点击"查找相似" → setSimilarEntryId(id), setSimilarLoading(true)
  → 调用 searchSimilar(id)
  → 成功: setSimilarResults(data), setSimilarLoading(false)
  → 失败: setSimilarLoading(false), Modal 内显示错误提示
关闭 Modal → setSimilarEntryId(null), setSimilarResults([])
```

**Modal 互斥**：两个 Modal 不互斥，靠 z-index 自然堆叠。用户同一卡片上不太可能同时触发两个操作。

### D5 — 术语库结果适配

**术语搜索路由**：Web 端使用统一搜索管道 `GET /api/memory/search?library=terminology`（与 Agent 端 search_memory 工具一致），不使用独立术语端点（Agent 端 `search_terminology` 工具的后端）。理由：统一管道已满足需求且减少 API 表面积。返回结构为标准 `MemoryEntryDTO`。

**字段提取**：后端 `searchTerminologyLibrary` 将术语信息打包进标准结构：
- `content`: 格式为 `[term] definition` 或 `[term] definition (context)`，context 为可选
- `metadata`: 包含 `{ term, aliases, category, examples }`
- `snippet`: summary/snippet 级别时与 content 相同，full 级别时为 undefined

前端从 `metadata` 字段提取结构化信息，不解析 content 字符串。当 snippet 为 undefined 时，降级使用 content 字段。

**类型定义**（在 `web/src/pages/memory/index.tsx` 中定义）：
```typescript
interface TerminologyMetadata {
  term: string
  aliases?: string[]
  category?: string
  examples?: string[]
}

// 使用时做类型断言
const meta = entry.metadata as TerminologyMetadata | null
```

**library=terminology 时的卡片展示**：
- 标题：从 `metadata.term` 提取
- 内容：从 `metadata` 展示 definition、aliases（标签组）、category（标签）
- 可选展示：examples（折叠区域）
- 不显示：conversationId、layer（术语无此概念）

**全库搜索（不指定 library）时的混排策略**：
- 术语结果识别首选方案：检查 `metadata` 中是否存在 `term` 字段（`metadata && 'term' in metadata`）。备选：`sourceTable === "terminology_entries"`（更精确但需解析 metadata 之外的字段）
- 混排时术语结果使用通用卡片（显示 content 字段），不做特殊卡片区分
- 仅在 `library=terminology` 专用模式下使用术语专用卡片
- 术语结果的 `layer` 字段后端硬编码为 `"working"`，全库混排时统一显示 layer 标签即可

### D6 — 查找相似实现

**交互方式**：Modal 展示（与"展开上下文"一致的交互模式）。

**注意**：相似检索响应不包含 `snippet` 字段（非 FTS5 路径，controller 不传 snippet 参数），前端展示时使用 `content` 字段。

点击"查找相似"：
1. 获取当前记忆条目 ID
2. 打开 Modal，展示加载状态（spinner）
3. 调用 `POST /api/memory/search/similar` body: `{ memoryEntryId: id, limit: 10 }`
4. Modal 中展示相似记忆列表（复用结果卡片组件）
5. 空结果时展示提示："未找到相似记忆"
6. 错误时展示 toast 提示

**状态处理**：
- 加载中：Modal 内 spinner
- 空结果：Modal 内提示文字
- 错误：Modal 内显示错误提示，用户手动关闭（不自动关闭，避免闪现）

### ~~D7 — Content Type 过滤~~（移至非目标）

后端 `SearchQueryDTO` 不支持 contentType 参数，需后端改动。超出本文档"仅前端"约束，移至非目标。

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/api/client.ts` | 修改 | 新增 getMemoryById、searchSimilar；searchMemory 增加 detail_level/library 参数，移除 layer 参数 |
| `web/src/pages/memory/index.tsx` | 修改 | 搜索面板增强、结果卡片改造、Modal 实现、术语库适配 |
| `api-contract/api/memory.ts` | 不改 | 现有 MemoryEntryDTO 和 SearchResultDTO 已覆盖所有场景 |
| 测试文件 | 检查 | 检查 `web/src/pages/memory/__tests__/` 和 `web/src/api/__tests__/` 是否存在，更新受影响的测试。本文档不要求新增测试文件 |

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 展开上下文范围 | 单条 full 内容 | 同对话关联记忆 | 渐进式披露原则：先看单条，需要再扩展 |
| 术语库入口 | 集成在搜索页面 | 独立页面 | 减少页面跳转，搜索体验一致 |
| snippet 渲染 | `split(/<\/?b>/)` + React 组件渲染 | dangerouslySetInnerHTML | 避免 XSS 风险；正则大小写敏感，用户内容中 `<B>` 不误判为高亮 |
| 来源标记 | 文字标签 | 图标 | 文字更直观，无需额外图标资源 |
| layer 过滤器 | 后端补实现（G0 修复） | 移除前端 UI | 功能完整优先，后端仓储层已支持，只需贯通 use case + controller |
| 术语搜索路由 | 统一管道 library=terminology | 独立术语端点（search_terminology） | 与 Agent 端 search_memory 工具行为一致，减少 API 表面积 |

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-1 | 用户搜索记忆 | 默认返回 snippet（高亮匹配片段），非全文 | ← UA-1 |
| B-2 | 用户切换到 summary | 返回 ID + 首句 + 分数，快速浏览大量结果 | ← UA-1 |
| B-3 | 用户点击"展开上下文" | 调用 API 获取该条目 full 内容，在 Modal 中展示 | ← UA-3 |
| B-4 | 用户搜索术语库 | 切换 library=terminology，展示术语定义和别名 | ← UA-1 |
| B-5 | 用户点击"查找相似" | 调用相似检索 API，在 Modal 中展示相似记忆列表 | ← UA-1 |
| B-6 | 用户查看搜索结果 | 显示来源标记（全文/语义/混合） | ← UA-1 |
| B-7 | 展开上下文 API 返回 404 | Modal 内显示错误提示"该记忆条目不存在或已被删除"，用户手动关闭 | — |
| B-8 | 查找相似 embedding 不可用 | Modal 展示"未找到相似记忆"（后端降级返回空结果） | — |
| B-9 | 新增功能 API 请求失败 | Modal 内显示错误提示，用户手动关闭（不自动关闭，避免闪现） | — |

## 验收标准 [required]

### 功能验收

- [ ] G0 修复：后端补上 layer 支持（SearchQuery + controller + filters），"记忆层"下拉现在真正生效
- [ ] 搜索面板支持 detail_level 切换（summary/snippet/full）
- [ ] 搜索面板支持 library 切换（全部/对话库/术语库）
- [ ] 搜索结果默认展示 snippet（高亮匹配片段），非全文 content
- [ ] snippet 中的 `<b>` 标记通过正则拆分渲染为高亮组件，不使用 dangerouslySetInnerHTML
- [ ] 点击"展开上下文"调用 `GET /api/memory/:id` 展示 full 内容，无占位文本
- [ ] 术语库搜索结果从 metadata 提取展示 term/definition/aliases/category
- [ ] 全库搜索时术语结果使用通用卡片（显示 content 字段）
- [ ] 点击"查找相似"在 Modal 中展示相似记忆列表，含加载/空/错误状态
- [ ] 搜索结果显示来源标记（fts→全文/vec→语义/both→混合）
- [ ] 新增 API 函数：getMemoryById、searchSimilar；移除 searchMemory 的 layer 参数
- [ ] 展开上下文 Modal 使用 expandEntryId/expandEntry/expandLoading 状态管理
- [ ] 查找相似 Modal 使用 similarEntryId/similarResults/similarLoading 状态管理
- [ ] 快速连续搜索不产生竞态（requestId 丢弃过期响应）

### 非功能验收

- [ ] 展开上下文 404 时 Modal 内显示"该记忆条目不存在或已被删除"，用户手动关闭
- [ ] 查找相似 embedding 不可用时展示"未找到相似记忆"
- [ ] 所有新增 API 调用有错误处理（try/catch + toast）
- [ ] `npm run check` 通过（lint + build）
- [ ] `npm run test` 通过

## 关联 [required]

- **F20260716szw8**: 渐进式披露机制（detail_level 参数设计）
- **F20260713u9v4**: UI 前端设计（记忆搜索页面规格）
- **F20260713m5q3**: domain/memory 模块实现
- **用户指令**: Web 端记忆能力必须与 Agent 端对等

## 对抗审视记录

### 第一轮（2026-07-30）

| # | 类型 | 问题 | 处理 |
|---|------|------|------|
| BLOCKER-1 | BLOCKER | D7 Content Type 过滤违反"后端不改动"约束 | ✅ D7 移至非目标，G8 标注"后端依赖" |
| BLOCKER-2 | BLOCKER | D1 `layer` 参数是幽灵参数（后端从不读取） | ✅ D1 移除 layer，D2 移除"记忆层"下拉，新增 G0 |
| SUGGESTION-1 | SUGGESTION | D5 术语库字段提取路径不明确 | ✅ D5 重写：明确从 metadata 提取，补充混排策略 |
| SUGGESTION-2 | SUGGESTION | D3 dangerouslySetInnerHTML 缺 sanitization | ✅ D3 改为正则拆分 + React 组件渲染 |
| SUGGESTION-3 | SUGGESTION | D4 "备选方案"标签误导 | ✅ D4 重写为方案 A/B，推荐方案在前 |
| SUGGESTION-4 | SUGGESTION | D6 查找相似交互细节不足 | ✅ D6 明确用 Modal，补充加载/空/错误状态 |
| SUGGESTION-5 | SUGGESTION | 缺错误处理设计 | ✅ 核心业务行为表补充 B-7/B-8/B-9 错误场景 |
| SUGGESTION-6 | SUGGESTION | layer 过滤器去留未说明 | ✅ D2 明确移除，D1 注释说明 |
| SUGGESTION-7 | SUGGESTION | 验收标准遗漏 D7 且缺非功能项 | ✅ 验收标准拆分功能/非功能，移除 D7 条目 |
| QUESTION-1 | QUESTION | 术语搜索走统一管道还是独立端点 | ✅ D5 明确：统一管道 library=terminology |
| QUESTION-2 | QUESTION | 全库搜索时术语结果如何展示 | ✅ D5 补充：通用卡片，通过 metadata.term 识别 |

### 第二轮（2026-07-30）

第一轮 11 个修复全部验证通过。新发现集中在文档描述精度。

| # | 类型 | 问题 | 处理 |
|---|------|------|------|
| BLOCKER-1 | BLOCKER | D3 文本描述与代码实现不一致（"替换标记" vs "split"） | ✅ 统一为 split 方案描述，补充 React 组件代码 |
| SUGGESTION-1 | SUGGESTION | D5 content 格式遗漏 context 可选条件 | ✅ 改为"或"格式，说明 context 可选 |
| SUGGESTION-2 | SUGGESTION | D5 snippet 在 full 级别为 undefined | ✅ 补充说明，加降级策略 |
| SUGGESTION-3 | SUGGESTION | D6 相似检索响应不含 snippet | ✅ D6 补充说明，前端降级用 content |
| SUGGESTION-4 | SUGGESTION | D4 API 路径风格 {id} vs :id | ✅ 统一为 :id |
| SUGGESTION-5 | SUGGESTION | D2 granularity 与 detail_level UI 混淆 | ✅ D2 补充 tooltip 区分策略 |
| QUESTION-1 | QUESTION | <b> 大小写变体处理 | ✅ D3 补充说明：正则大小写敏感，用户 <B> 不误判（正确行为） |
| QUESTION-2 | QUESTION | 为何不使用独立术语端点 | ✅ D5 补充设计取舍理由 |

### 第三轮（2026-07-30）

前两轮 19 个修复全部验证通过。新发现集中在可实施性细节。

| # | 类型 | 问题 | 处理 |
|---|------|------|------|
| BLOCKER-1 | BLOCKER | D1 API 签名与 D4 端点矛盾（getMemoryDetails vs getById） | ✅ D1 新增 getMemoryById 函数签名，与 D4 方案 A 对齐 |
| BLOCKER-2 | BLOCKER | 展开上下文 Modal 缺状态管理设计 | ✅ D4 补充 state 变量列表和状态转移 |
| SUGGESTION-1 | SUGGESTION | source 字段到展示文本映射表缺失 | ✅ D3 补充映射表 |
| SUGGESTION-2 | SUGGESTION | metadata 无 TypeScript 类型定义 | ✅ D5 补充 TerminologyMetadata 接口定义 |
| SUGGESTION-3 | SUGGESTION | 搜索竞态条件未处理 | ✅ D2 补充 requestId 竞态处理方案 |
| SUGGESTION-4 | SUGGESTION | B-7 错误消息与后端返回不一致 | ✅ B-7 改为"后端原始错误文本" |
| SUGGESTION-5 | SUGGESTION | 粒度空值行为未说明 | ✅ D2 补充：空字符串转 undefined |
| QUESTION-1 | QUESTION | "细化搜索"功能去留 | ✅ 非目标中明确：保留但不改造 |
| QUESTION-2 | QUESTION | 术语结果识别首选方案 | ✅ D5 明确：首选 metadata.term 存在检查 |

### 第四轮（2026-07-30）

前三轮 28 个修复全部验证通过。新发现集中在内部一致性和 API 调用对齐。

| # | 类型 | 问题 | 处理 |
|---|------|------|------|
| BLOCKER-1 | BLOCKER | D3"查看详情"调 batch API 与 D4"展开上下文"调 getById 矛盾 | ✅ 统一为 getMemoryById，移除无调用方的 getMemoryDetails |
| SUGGESTION-1 | SUGGESTION | 移除下拉未要求删除 layer state 变量 | ✅ D2 补充"删除 layer state 变量及 useState 声明" |
| SUGGESTION-2 | SUGGESTION | D6/B-9 错误时 Modal 行为不一致 | ✅ 统一为"Modal 内显示错误提示，用户手动关闭" |
| SUGGESTION-3 | SUGGESTION | getMemoryDetails 无实际调用方 | ✅ 从 D1 移除（BLOCKER-1 修复后自然消除） |
| QUESTION-1 | QUESTION | expandEntry 的类型和字段访问 | ✅ D4 补充"MemoryEntryDTO 类型，conversationId null 时不显示" |

### 第五轮（2026-07-30，最终轮）

前四轮 33 个修复全部验证通过。新发现为内部矛盾和事实性错误。

| # | 类型 | 问题 | 处理 |
|---|------|------|------|
| BLOCKER-1 | BLOCKER | B-7（404 关闭 Modal）与 B-9（错误时 Modal 保持打开）矛盾 | ✅ B-7 对齐 B-9：Modal 内显示错误提示，用户手动关闭 |
| BLOCKER-2 | BLOCKER | D3 source 映射表错误声称 full 模式 source 可能 undefined | ✅ 移除 undefined 行，补充说明：source 在搜索结果中始终存在 |
| SUGGESTION-1 | SUGGESTION | 改动范围表无测试指导 | ✅ 补充测试文件检查行 |
| SUGGESTION-2 | SUGGESTION | snippet 渲染未处理用户内容含 `<b>` 的限制 | ✅ D3 补充已知限制说明 |

**最终结论：PASS — 文档已达可直接编码状态。**
