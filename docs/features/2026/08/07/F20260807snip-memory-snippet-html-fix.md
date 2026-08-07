---
id: F20260807snip
title: memory-snippet-html-fix
doc_type: feature

summary: |
  修复 search_memory 工具返回大量 <b> HTML 标签导致 mimo 模型退化的问题。
  根因是记忆模块在 snippet 中嵌入了 Web 渲染专用的高亮标签，违反职责分离原则。
  将高亮渲染职责从记忆模块移至 Web 后端，记忆模块返回纯文本 snippet。

causal_links:
  from:
    - F20260805f146
  to:
    - F20260806dgrf

status: development
change_type: fix
tags: [memory, snippet, html, degenerate, mimo]
modules:
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/interface-adapters/http/controllers/memory-controller.ts
  - tests/usecases/memory/search-memory.test.ts
---

# F20260807snip: 记忆召回返回纯文本 snippet，高亮渲染移至 Web 后端

## 背景

用户报告对话《大獭创建出了大獭的bug》中，重启后立马又出现了 `[系统] 检测到输出异常重复，正在自我纠正`。这两天针对异常中断问题修复了多次。

## 根因分析

### 排除法验证

通过排除法定位根因：

| 测试条件 | 退化? | Max Window |
|---------|-------|------------|
| 干净 session | ❌ | 5 |
| **完整 session（原样）** | **✅** | **50+** |
| 去掉 search_memory | ❌ | 3 |
| 只保留 search_memory | ❌ | 3 |
| **去掉 `<b>` HTML 标签** | **❌** | 6 |

### 根因

`sqlite-memory-repository.ts` 的 `searchFTSWithHighlight()` 方法在返回 snippet 时使用了 `<b>` HTML 标签高亮匹配关键词。

**问题链路**：
1. jieba 分词产生大量短词（"对话"、"列表"等）
2. 每个短词在内容中频繁出现
3. 每次出现都被 `<b>` 标签包裹
4. snippet 中产生大量密集的 `<b>` 标签

**数据**：
- Line 8: 45KB 内容，5294 个 `<b>` 标签（11.5%）
- Line 9: 82KB 内容，13250 个 `<b>` 标签（16.0%）

### 退化内容

案发现场退化内容：
```
Let me look at the compaction module and settings to understand the defaults.
Let me look at the compaction module and settings to understand the defaults.
...（重复 39 次）
```

测试复现退化内容：
```
Let me look at the `_checkCompaction` method to understand the threshold...
Let me look at the `_checkCompaction` method to understand the threshold...
...（重复 50 次）
```

两者都是"Let me look at..."开头的规划/分析句子的无限循环。

## 修复方案

### 核心原则

- 后端记忆模块返回纯文本数据，不嵌入任何渲染逻辑
- Web 后端负责数据格式转换
- Web 前端直接渲染 HTML

### 修改文件

#### 1. 记忆模块：去掉 `<b>` 标签

**文件**：`src/frameworks/db/memory/sqlite-memory-repository.ts`

修改 `searchFTSWithHighlight()` 方法，返回纯文本 snippet：

```typescript
// 修改前：
highlighted = highlighted.replaceAll(escapedToken, `<b>${escapedToken}</b>`);

// 修改后：
return rows.map(row => {
  const content = row.content || '';
  return {
    entryId: row.id,
    ftsRank: row.bm25_score,
    entry: rowToMemoryEntry(row),
    snippet: content,  // 纯文本
  };
});
```

#### 2. Web 后端：添加高亮函数

**文件**：`src/interface-adapters/http/controllers/memory-controller.ts`

添加 `highlightSnippet()` 函数，在返回 DTO 前对 snippet 进行高亮：

```typescript
function highlightSnippet(snippet: string, query: string): string {
  if (!snippet || !query) return snippet;

  const tokens = query.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return snippet;

  // 转义 HTML 特殊字符（XSS 防护）
  let highlighted = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // 对每个搜索词进行高亮
  for (const token of tokens) {
    const escapedToken = token
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    highlighted = highlighted.replaceAll(escapedToken, `<b>${escapedToken}</b>`);
  }

  return highlighted;
}
```

在 `search()` 方法中使用：

```typescript
entries: result.entries.map((e) => {
  const snippet = e.snippet ? highlightSnippet(e.snippet, query) : e.snippet;
  return toMemoryEntryDTO(e, e.score, e.source, snippet);
}),
```

#### 3. 更新测试

**文件**：`tests/usecases/memory/search-memory.test.ts`

更新断言，确保 snippet 不包含 `<b>` 标签：

```typescript
// 修改前：
expect(first.snippet).toContain("<b>");

// 修改后：
expect(first.snippet).not.toContain("<b>");
expect(first.snippet).not.toContain("</b>");
```

## 验证

1. **单元测试**：所有测试通过（980 个测试）
2. **集成测试**：用案发现场的 session 文件测试，确认不退化
3. **Web 前端**：手动测试记忆搜索页面，确认高亮显示正常
4. **LLM 测试**：用 search_memory 工具测试，确认返回纯文本

### 验证结果

| 测试条件 | 退化? | Max Window |
|---------|-------|------------|
| 案发现场完整 session（修复前） | ✅ | 50+ |
| 案发现场完整 session（修复后） | ❌ | 1 |

## 相关文档

- F20260805f146: degenerate_output 梯度介入
- F20260806dgrf: degenerate_output 重试修复
- project_mimo_degenerate_tendency: mimo 模型 repeat_window 退化倾向
