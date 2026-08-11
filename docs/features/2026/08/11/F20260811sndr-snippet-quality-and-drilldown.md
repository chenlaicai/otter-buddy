---
id: F20260811sndr
title: snippet-quality-and-drilldown
doc_type: feature
summary: |
  合并优化点：①修复 jieba 表 highlight 返回全文导致 snippet 不含匹配词的问题（应用层后处理高亮）；②给 RetrievalResultEntry 加 drillDown 字段，告诉 agent 用什么工具拿全文。
  根因：searchFTSWithHighlight 命名暗示返回 highlight 片段，实际返回 row.content 全文（sqlite-memory-repository.ts:399），agent 在 snippet 模式下看不到匹配证据；且没有 drillDown hint，agent 不知道用什么工具继续下钻全文。
  主机制：tokenizeQuery 分词结果在 content 里正则定位，前后各 100 字符截取作为 snippet；同时为非 full 模式注入 drillDown { tool, params }。

causal_links:
  from:
    - R20260811rclo

status: draft
change_type: feature
tags: [memory, retrieval, snippet, drilldown, contract]
modules:
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/usecases/memory/search-memory.ts
  - src/entities/memory/memory-entry.ts
  - api-contract/api/memory.ts
capability_test: "n/a: 纯契约+数据层改动（A 类）。drillDown hint 是字段提示，agent 是否调用 get_memory_detail 不强制——属于信息驱动而非 prompt 驱动"
---

# F20260811sndr: Snippet 质量与下钻路径

## 背景与需求

### 问题描述

otter 召回有三档 `detail_level`：`summary / snippet / full`（`memory-entry.ts:60`）。但当前 snippet 模式有两个痛点：

1. **snippet 不含匹配词**：`searchFTSWithHighlight`（`sqlite-memory-repository.ts:366-407`）名字暗示返回 FTS5 `highlight()` 片段，**实际返回 `row.content` 全文**（`:399`）。代码注释（`:367`）说明这是有意设计——"搜索走 jieba 表，高亮走原始内容（避免分词碎片化）"。但代价是：
   - agent 在 snippet 模式下看不到匹配证据，难判断相关性
   - 让下钻提示的价值打折——用户看到一大段文本，不知道其中哪部分触发了召回

2. **无下钻 hint**：agent 在 snippet 看到有用内容后，**不知道用什么工具拿全文**。当前 `RetrievalResultEntry` 没有"提示调用方下一步该用什么工具"的字段。靠 agent 自己猜。

### 根因分析

| # | 根因 | 代码证据 |
|---|------|---------|
| R1 | jieba tokenizer 不支持 FTS5 内置 `highlight()` | 这是 jieba 表的设计限制，应用层分词无法走 FTS5 高亮函数 |
| R2 | 当前实现选择全文返回作为 fallback | `sqlite-memory-repository.ts:367, 399`——注释明示"避免分词碎片化" |
| R3 | 没有应用层后处理高亮 | `tokenizeQuery` 已返回 jieba 分词结果，但未被用于定位匹配位置 |
| R4 | DTO 无下钻字段 | `RetrievalResultEntry`（`search-memory.ts:40-47`）只有 `score/source/snippet/userFlagged`，没有 `drillDown` |

### 数据实锤

- `sqlite-memory-repository.ts:399`：`const content = row.content || '';` + `:404` `snippet: content` — 确实返回全文
- `search-memory.ts:buildSnippet`（`:425-450`）：消费 snippet 时已经会做"取首句"等处理，但输入的 snippet 是全文，处理后仍可能丢失匹配上下文
- `memory-controller.ts:95` 先例：响应字段扩展不破坏现有契约

---

## 方案设计

### 技术方案

#### 一、应用层后处理高亮（snippet 含匹配片段）

**思路**：`tokenizeQuery(query)` 已返回 jieba 分词后的 token 数组（`jieba-tokenizer.ts:tokenizeQuery`）。在 `searchFTSWithHighlight` 拿到 FTS 命中后，**用 token 数组在 content 里正则定位匹配位置，截取窗口（前后各 100 字符）作为 snippet**。

**实现伪代码**（`sqlite-memory-repository.ts:366-407` 重写）：

```typescript
async searchFTSWithHighlight(query: string, filters: SearchFilters): Promise<SnippetHit[]> {
  const tokenizedQuery = tokenizeQuery(query);
  if (tokenizedQuery.length === 0) return [];

  // 1. FTS 查询（不变）
  const rows = this.db.prepare(`...`).all(...) as FtsHighlightRow[];

  // 2. 应用层后处理：用 tokenizeQuery 结果在 content 里定位
  return rows.map(row => {
    const snippet = this.extractSnippet(row.content || '', tokenizedQuery);
    return {
      entryId: row.id,
      ftsRank: row.bm25_score,
      entry: rowToMemoryEntry(row),
      snippet,  // 不再是全文，是含匹配 token 的窗口片段
    };
  });
}

private extractSnippet(content: string, tokens: string[], windowSize = 100): string {
  if (!content) return '';
  // 1. 找第一个匹配的 token 位置
  let firstMatchPos = -1;
  for (const token of tokens.slice(0, 10)) {  // 限制扫描 token 数防 O(n²)
    const idx = content.indexOf(token);
    if (idx >= 0) {
      firstMatchPos = idx;
      break;
    }
  }
  if (firstMatchPos < 0) {
    // 没匹配上（分词差异），fallback 到前 200 字符
    return content.slice(0, 200);
  }
  // 2. 截取窗口
  const start = Math.max(0, firstMatchPos - windowSize);
  const end = Math.min(content.length, firstMatchPos + windowSize);
  return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
}
```

**性能保护**：
- `tokens.slice(0, 10)` 限制扫描 token 数，避免长查询的 O(n×m) 字符串扫描爆炸
- 正则特殊字符：`indexOf` 不需要转义（与正则匹配不同），更安全更快

**替代方案对比**（R 文档第三轮审视已评估）：
- 方案 B：搜索走 jieba 表，highlight 走 trigram 表（`memory_fts` 支持 FTS5 highlight）——复杂度高（双表 join），trigram 分词粒度与 jieba 不一致导致 highlight 错位。**不采纳**。
- 方案 C：用 FTS5 `highlight()` 函数 + 改 jieba 表为 trigram——丢失 jieba 中文分词能力。**不采纳**。

#### 二、Drill-Down Hint（下钻提示字段）

`RetrievalResultEntry` 新增 `drillDown?` 字段：

```typescript
export interface RetrievalResultEntry extends MemoryEntry {
  score: number;
  source: RetrievalSource;
  snippet?: string;
  userFlagged?: boolean;
  /** 新增：detail_level != "full" 时填充 */
  drillDown?: {
    tool: string;                      // MCP 工具名
    params: Record<string, unknown>;   // 调用参数
  };
}
```

**填充策略**（在 `search-memory.ts:rerankAndReturn`）：

```typescript
const drillDown = detailLevel !== "full" ? {
  tool: "get_memory_detail",
  params: { id: h.entryId },
} : undefined;
```

**MCP 工具描述更新**（`search_memory` 工具）：

> 返回结果含 `drillDown` 字段时，表示当前 snippet/summary 不完整。如果想看完整内容，调用 `drillDown.tool` 工具，传入 `drillDown.params`。

### 目标

- T1: snippet 模式下返回的 snippet 含至少一个匹配 token（除非分词差异 fallback）
- T2: `RetrievalResultEntry.drillDown` 字段在 detail_level != "full" 时填充
- T3: MCP 工具描述告知 agent 如何使用 drillDown
- T4: 不破坏现有契约（drillDown 可选字段，旧客户端忽略即可）

### 成功标准

- 同一查询同一文档，snippet 模式返回的 snippet 不再是全文，而是含匹配 token 的 ~200 字符窗口
- agent 收到 `drillDown` 后能直接调用 `get_memory_detail(id=...)` 拿全文
- 所有现有测试不破坏

---

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1 snippet 含匹配 | 索引一段文本，搜其中一个词 | snippet 包含该词，长度 ~200 字符，前后有 `...` 省略号 |
| AT-2 | T1 fallback 行为 | 索引中文文本，搜一个 jieba 分不出来的词 | fallback 返回前 200 字符，不报错 |
| AT-3 | T1 性能保护 | 构造 100 个 token 的查询 | `extractSnippet` 只扫前 10 个 token，响应时间 < 100ms |
| AT-4 | T2 drillDown 填充 | 调 search（detail_level=snippet） | 每个 entry 含 `drillDown: { tool: "get_memory_detail", params: { id } }` |
| AT-5 | T2 full 模式不填 | 调 search（detail_level=full） | entries 不含 `drillDown` 字段 |
| AT-6 | T3 MCP 工具描述 | 看 search_memory 工具定义 | 描述中提到 drillDown 字段的用法 |
| AT-7 | T4 向后兼容 | 用旧客户端（不认 drillDown）调 search | 旧客户端正常工作，忽略 drillDown 字段 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 ~ AT-7 | n/a（A 类纯契约+数据层改动，单元测试覆盖） |

单测覆盖：
- `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` — extractSnippet 逻辑
- `tests/usecases/memory/search-memory.test.ts` — drillDown 填充逻辑

---

## 实现细节

### 代码修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 重写 `searchFTSWithHighlight`（`:366-407`），新增 `extractSnippet` 私有方法 |
| `src/usecases/memory/search-memory.ts` | 修改 | `RetrievalResultEntry` 加 `drillDown?` 字段；`rerankAndReturn`（`:313-333`）按 detail_level 填充 drillDown |
| `src/entities/memory/memory-entry.ts` | 修改 | 加 `DrillDownHint` 类型定义 |
| `api-contract/api/memory.ts` | 修改 | 扩展 `MemoryEntryDTO` 加 `drillDown?` 字段（通过 `@contract/api/memory` alias 引用） |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` 或对应工具定义文件 | 修改 | 更新 `search_memory` 工具描述，提到 drillDown 字段用法 |
| `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` | 修改 | 加 extractSnippet 测试（含匹配/fallback/性能） |
| `tests/usecases/memory/search-memory.test.ts` | 修改 | 加 drillDown 填充测试 |

### 逻辑变更

1. **extractSnippet 算法**：
   - 输入：content（原文）、tokens（jieba 分词结果）、windowSize=100
   - 流程：①遍历 tokens 前 10 个，找第一个 `indexOf >= 0` 的位置 ②若找到，截取 `[pos-window, pos+window]`，加省略号 ③若没找到，fallback 前 200 字符
   - 复杂度：O(10 × content_length) 最坏情况，可控

2. **drillDown 填充时机**：在 `rerankAndReturn` 已经组装完 entry 后追加。不参与打分，纯展示层。

3. **buildSnippet 协作**（`search-memory.ts:425-450`）：
   - 现有 buildSnippet 接收 ftsSnippet（来自 searchFTSWithHighlight）做二次处理
   - 新流程：ftsSnippet 已经是 ~200 字符窗口（不再是全文），buildSnippet 的"取首句"逻辑在窗口上执行
   - summary 模式：取窗口首句（含匹配 token）
   - snippet 模式：直接用窗口

### 改动范围

| 范围 | 影响 |
|------|------|
| 契约（api-contract） | 新增 `drillDown?` 可选字段，向后兼容 |
| 数据库 | 不动 schema |
| HTTP API | search 端点响应 snippet 内容变化（更短、含匹配词），drillDown 字段新增 |
| MCP 工具 | search_memory 工具描述更新；下游可能新增 get_memory_detail 工具调用频次 |

---

## 验收结果

### 测试结果

[实现阶段填写]

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 snippet 含匹配 | 待验证 | ❓ |
| T1 fallback 正常 | 待验证 | ❓ |
| T1 性能可控 | 待验证 | ❓ |
| T2 drillDown 填充 | 待验证 | ❓ |
| T2 full 模式不填 | 待验证 | ❓ |
| T3 MCP 工具描述 | 待验证 | ❓ |
| T4 向后兼容 | 待验证 | ❓ |

---

## 对抗审视记录

完整审视见 R20260811rclo。本 F 的关键决策：

- **第三轮审视合并决策**：原 P0-2（jieba highlight）和原 P0-3（Drill-Down Hint）强耦合，合并为一个 F。理由：P0-2 先做没 P0-3，agent 拿到好 snippet 但不知怎么拿全文；P0-3 先做没 P0-2，drillDown 指向全文但全文和 snippet 差不多。
- **第四轮审视路径修正**：契约路径 `src/contract/api/memory.ts` → `api-contract/api/memory.ts`（通过 `@contract/api/memory` alias 引用）。

## 设计决策

- **应用层后处理高亮**（vs FTS5 highlight 函数）：jieba 表不支持 FTS5 内置 highlight，唯一可行路径是应用层。性能保护是限制扫描 token 数。
- **indexOf 而非正则匹配**：indexOf 不需要转义特殊字符，更安全更快。token 是 jieba 分词结果，本质是子串匹配。
- **drillDown.tool 统一为 get_memory_detail**（vs 按 library 区分）：P0 阶段先简单。后续可根据 library 区分（对话库 vs 术语库 vs F/R 文档库各自的下钻工具），但要避免过度设计。
- **detail_level=full 时不填 drillDown**：full 模式已经是完整内容，下钻没意义。
