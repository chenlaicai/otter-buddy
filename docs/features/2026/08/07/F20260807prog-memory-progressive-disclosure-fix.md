---
id: F20260807prog
title: memory-progressive-disclosure-fix
doc_type: feature

summary: |
  修复 search_memory 工具 detail_level 渐进式披露完全失效的缺陷。
  根因是 buildSnippet 只追加 snippet 字段、不裁剪 content，导致 summary/snippet 模式下 LLM 仍收到完整记忆文本，上下文暴涨。

causal_links:
  from:
    - F20260807snip
  to: []

status: development
change_type: fix
tags: [memory, progressive-disclosure, context-bloat, detail-level]
modules:
  - src/usecases/memory/search-memory.ts
  - src/interface-adapters/http/dto/memory-dto.ts
  - src/interface-adapters/http/controllers/memory-controller.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260807prog: 记忆召回 detail_level 渐进式披露失效修复

## 背景

用户发现记忆召回完全不可用——`search_memory` 工具的 `detail_level` 参数（summary/snippet/full）形同虚设，每次召回都一次性返回全文，导致 LLM 上下文直接暴涨。渐进式披露机制（先 summary 定位、再 snippet 确认、最后 full 深入）从未真正生效。

## 前因后果

### 设计意图

记忆模块设计了两层渐进式披露：

1. **工具层**：`search_memory`（轻量检索）→ `get_memory_detail`（按 ID 深入）
2. **内容层**：`detail_level` 参数控制返回粒度
   - `summary`：ID + 首句 + 分数
   - `snippet`：ID + 匹配片段 + 分数 + 元数据（默认）
   - `full`：完整内容 + 元数据

LLM 应先用 summary/snippet 定位相关条目，再用 `get_memory_detail` 获取需要的全文。

### 实际行为

| detail_level | content 字段 | snippet 字段 | 实际效果 |
|---|---|---|---|
| `"summary"` | **全文** | 首句 | 全文暴涨上下文 |
| `"snippet"` | **全文** | FTS 高亮片段 | 全文暴涨上下文 |
| `"full"` | 全文 | 无 | 全文（正确） |

LLM 拿到的 JSON 中 `content` 始终是完整文本。`snippet` 字段形同虚设——LLM 不会只看 `snippet` 而忽略 `content`。`get_memory_detail` 第二阶段工具完全多余。

## 根因分析

### 排查路径

1. 用户报告"记忆召回导致上下文暴涨"
2. 审视 `search_memory` 工具定义（`tool-factory.ts:158-205`）：参数设计正确，`detail_level` 支持 summary/snippet/full
3. 审视 `SearchMemory.search()`（`search-memory.ts:63`）：路由逻辑正确，`detailLevel` 正确传递
4. 审视 `buildSnippet()`（`search-memory.ts:417-437`）：**发现问题**——返回类型是 `{ snippet?: string }`，只追加 `snippet` 字段，从不修改 `content`
5. 审视 `rerankAndReturn()`（`search-memory.ts:319-326`）：**确认根因**

### 根因

`rerankAndReturn` 的返回值组装：

```typescript
return {
  ...h.entry,           // ← 展开 MemoryEntry 所有字段，包括完整的 content
  metadata: meta,
  score: h.finalScore,
  source: h.source,
  userFlagged: ...,
  ...this.buildSnippet(h.entry, detailLevel, snippetMap),  // ← 只追加 snippet 字段
};
```

`buildSnippet` 返回 `{ snippet?: string }`，**从不裁剪 `content`**。由于 `...h.entry` 在前，`content` 始终是 MemoryEntry 中的全文。`buildSnippet` 追加的 `snippet` 字段是冗余的附加信息，不会覆盖 `content`。

同一条问题在 HTTP 端点也存在：`toMemoryEntryDTO`（`memory-dto.ts:25`）硬编码 `content: entry.content`。

### 影响范围

- Agent 工具路径：`search_memory` 返回的 JSON 中 `content` 始终为全文
- HTTP 端点：Web 前端记忆搜索结果 `content` 始终为全文
- `get_memory_detail` 工具：设计为第二阶段深入手段，但因第一阶段已灌入全文而完全多余

## 修复方案

### 1. `search-memory.ts`：buildSnippet 返回裁剪后的 content

`buildSnippet` 返回类型从 `{ snippet? }` 改为 `{ content, snippet? }`。非 `full` 模式下 `content` 被裁剪为 snippet 值：

```typescript
private buildSnippet(
  entry: MemoryEntry,
  detailLevel?: DetailLevel,
  snippetMap?: Map<string, string | undefined>,
): { content: string; snippet?: string } {
  if (!detailLevel || detailLevel === "full") {
    return { content: entry.content };
  }

  const ftsSnippet = snippetMap?.get(entry.id);
  const snippet = ftsSnippet ?? entry.content.slice(0, SNIPPET_FALLBACK_LENGTH);

  if (detailLevel === "summary") {
    const firstSentence = snippet.match(/^[^\n。.！!？?]*[。.！!？?\n]?/)?.[0] ?? snippet;
    return { content: firstSentence, snippet: firstSentence };
  }

  return { content: snippet, snippet };
}
```

由于 `rerankAndReturn` 中展开顺序 `...h.entry`（前）→ `...this.buildSnippet(...)`（后），`content` 被正确覆盖。

### 2. `memory-dto.ts`：toMemoryEntryDTO 新增 detailLevel 参数

```typescript
export function toMemoryEntryDTO(
  entry: MemoryEntry & { userFlagged?: boolean },
  score?: number,
  source?: RetrievalSource,
  snippet?: string,
  detailLevel?: DetailLevel,  // 新增
): MemoryEntryDTO {
  const content = detailLevel && detailLevel !== "full" && snippet
    ? snippet
    : entry.content;
  // ...
}
```

### 3. `memory-controller.ts`：传入 detailLevel

```typescript
return toMemoryEntryDTO(e, e.score, e.source, snippet, detailLevel);
```

### 4. `tool-factory.ts`：工具描述加入渐进式披露操作规则

原有描述只说了"渐进式披露"这个概念，没告诉 LLM 具体怎么做。修改后：

- `search_memory` 描述：明确四步工作流（summary 扫描 → get_memory_detail 深入 → snippet 看上下文 → full 全文）
- `detail_level` 参数描述：每个值标注使用场景（"推荐首选"、"看上下文"、"仅需全文时用"）
- 默认值从 `"snippet"` 改为 `"summary"`（渐进式披露的第一步应该是最轻量的）
- `get_memory_detail` 描述：明确标注为"渐进式披露第二阶段"，不要跳过 search_memory 直接使用

### 5. `SKILL.md`：补充记忆检索渐进式披露工作流

原有指引只写了"用 `search_memory`"，补充为三步操作：
1. `search_memory(detail_level="summary")` 快速扫描
2. `get_memory_detail(ids=[...])` 获取全文
3. 不要跳过步骤 1 直接用 full 模式灌入全文

## 修复后行为

| detail_level | content 返回 | snippet 返回 |
|---|---|---|
| `"summary"` | 首句 | 首句（高亮） |
| `"snippet"` | FTS 高亮片段 / 200 字降级 | 同左（高亮） |
| `"full"` | 全文 | 无 |

## 测试覆盖补充

原有测试的漏洞：只断言 `snippet` 字段，从未检查 `content` 是否被裁剪。

| 测试文件 | 补充内容 |
|---|---|
| `search-memory.test.ts` | 6 个现有测试增加 `content == snippet` 断言；新增 2 个针对性测试 |
| `memory.test.ts` | 新增 3 个 HTTP API 测试：summary/snippet/full 模式下 content 裁剪行为 |

新增测试用例：
- `渐进式披露核心：snippet/summary 的 content 等于 snippet，full 保持全文`
- `detail_level 未传时 content 也不应返回全文（默认 snippet 行为）`
- `detail_level=summary 时 content 被裁剪为 snippet`（API）
- `detail_level=snippet 时 content 被裁剪为 snippet`（API）
- `detail_level=full 时 content 保留全文`（API）

## 验证

1. **编译**：`npm run build` 通过
2. **单元测试**：998 个测试全部通过（新增 16 个断言）
3. **CI**：PR #186 通过
