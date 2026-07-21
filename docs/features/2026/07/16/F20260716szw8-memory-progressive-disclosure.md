---
id: F20260716szw8
title: memory-progressive-disclosure
doc_type: feature

# 记忆索引
summary: |
  > 本文档设计记忆系统的渐进式披露召回机制。基于用户提出的"渐进式披露"原则，改进当前记忆系统的召回阶段，避免上下文爆炸，提升检索效率和用户体验。 > **设计共识**：渐进式披露是检索行为的交互模式，不是数据存储的粒度。通过 detail_level 参数控制返回内容的详细程度，让 AI 能...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260713m5q3
    - F20260709m2n8


# 元数据
status: locked
change_type: feature
tags: [design, memory, progressive-disclosure, retrieval, granularity]
modules: [domain/memory, interface-adapters/agent-runtime]

# 时间
created_at: 2026-07-16
---


# F20260716szw8 [memory] 记忆系统渐进式披露召回机制

## [design-time]

> 本文档设计记忆系统的渐进式披露召回机制。基于用户提出的"渐进式披露"原则，改进当前记忆系统的召回阶段，避免上下文爆炸，提升检索效率和用户体验。
>
> **设计共识**：渐进式披露是检索行为的交互模式，不是数据存储的粒度。通过 detail_level 参数控制返回内容的详细程度，让 AI 能够主动筛选和决策。

## 背景 [required]

用户提出记忆系统在召回阶段应贯彻"渐进式披露"原则：先找到关键线索位置（AI 可做有限信息筛选），再进一步查看该位置的更多内容（进一步筛选），最后获取完整内容。而不是通过关键字找到后直接返回所有可能相关处的全文，导致上下文爆炸。

### 约束输入

- F20260713m5q3: domain/memory 模块已实现（FTS5 + vec0 + RRF + 权重重排）
- F20260709m2n8: S2 架构设计已定义多粒度索引和渐进式检索概念
- 当前实现：granularity 字段已定义但未使用，所有检索直接返回完整内容
- 当前实现：conversation_summary 内容类型存在但无创建路径
- 当前实现：refine/expand 操作设计文档明确说"out of scope"

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| 渐进式披露原则 | 用户明确要求，必须纳入 | 用户指令 |
| 渐进式披露本质 | 检索行为的交互模式，不是数据存储的粒度 | 架构师-1 + 架构师-2 共识 |
| 核心机制 | detail_level 参数控制返回内容的详细程度 | 架构师-1 + 架构师-2 共识 |
| 工具设计 | 两个工具：search_memory（改造） + get_memory_detail（新增） | 架构师-2 建议，架构师-1 接受 |
| snippet 生成 | 使用 FTS5 highlight() 函数，降级时截取前 200 字符 | 架构师-2 建议，架构师-1 接受 |
| 默认 detail_level | snippet | 架构师-2 建议，架构师-1 接受 |
| 向后兼容 | 完全兼容，无需数据迁移 | 架构师-2 分析，架构师-1 确认 |

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前讨论 | 渐进式披露。我认为记忆系统在召回阶段，主要贯彻这个基本原则 | 原则：渐进式披露；阶段：召回阶段 | 记忆系统召回必须遵循渐进式披露原则 |
| UA-2 | 当前讨论 | 先找到关键线索位置（此时ai可以做 有限信息的筛选） | 顺序：先；目标：关键线索位置；动作：有限信息筛选 | 第一阶段返回线索，AI 可基于线索筛选 |
| UA-3 | 当前讨论 | 然后再进一步查看该位置的更多内容（此时又可以再做进一步筛选） | 顺序：然后；目标：更多内容；动作：进一步筛选 | 第二阶段返回更多上下文，AI 可再次筛选 |
| UA-4 | 当前讨论 | 然后再完整内容 | 顺序：再然后；目标：完整内容 | 第三阶段返回完整内容 |
| UA-5 | 当前讨论 | 而不是通过关键字找到之后就直接将所有的可能相关处的全文全都返回，这只会导致上下文爆炸 | 否定：直接返回全文；后果：上下文爆炸 | 必须避免一次性返回所有全文 |

## 目标 [required]

### P1 - 渐进式披露召回机制

实现记忆系统的渐进式披露召回机制，包含：
- detail_level 参数：控制返回内容的详细程度（summary/snippet/full）
- 两个 AI Agent 工具：search_memory（改造） + get_memory_detail（新增）
- snippet 生成：使用 FTS5 highlight() 函数返回匹配片段

### P2 - 避免上下文爆炸

- 检索时默认返回 snippet（匹配片段），而非完整内容
- AI 可基于 snippet 主动筛选需要深入查看的条目
- 按需获取完整内容，减少不必要的上下文传输

### P3 - 可独立验证

通过集成测试验证：
- detail_level 参数功能
- snippet 生成（FTS5 highlight）
- 两个工具的调用流程
- 向后兼容性

## 非目标 [required]

- 不修改已有的混合检索引擎（FTS5 + vec0 + RRF + 权重重排）
- 不修改已有的权重系统
- 不实现 tree_path 相关功能（已移除）
- 不修改数据库 schema（使用现有字段）

## 设计 [required]

### 核心概念

#### 渐进式披露本质

渐进式披露是**检索行为的交互模式**，不是数据存储的粒度。核心思想是：
1. 检索时返回轻量级线索（snippet），让 AI 能够主动筛选
2. AI 基于线索决策是否需要查看完整内容
3. 按需获取完整内容，避免一次性返回过多上下文

#### detail_level 参数

| level | 返回内容 | 用途 |
|-------|---------|------|
| `summary` | ID + 首句 + 分数 + layer | 快速浏览，大量筛选 |
| `snippet` | ID + 匹配片段（高亮） + 分数 + layer + contentType | 理解上下文，精准筛选（**默认值**） |
| `full` | 完整内容 + 元数据 + 分数 + layer + contentType | 深入分析 |

#### snippet 生成策略

使用 FTS5 的 `highlight()` 函数：
```sql
SELECT memory_entry_id, highlight(memory_fts, 1, '<b>', '</b>') as snippet
FROM memory_fts
WHERE content MATCH ?
```

**降级方案**：当 FTS5 不可用时（如使用 vec0 检索），从 `content` 中截取前 200 字符作为 snippet。

### 接口设计

#### 1. AI Agent 工具

```typescript
// 工具 1: search_memory（改造现有工具）
{
  name: "search_memory",
  description: "检索记忆。返回匹配的记忆条目，支持不同详细程度",
  parameters: {
    query: { type: "string", required: true, description: "搜索关键词" },
    limit: { type: "number", default: 10, description: "最大结果数" },
    detail_level: {
      type: "string",
      enum: ["summary", "snippet", "full"],
      default: "snippet",
      description: "返回内容的详细程度：summary（ID+首句+分数）、snippet（ID+匹配片段+分数+元数据）、full（完整内容+元数据）"
    }
  }
}

// 工具 2: get_memory_detail（新增工具）
{
  name: "get_memory_detail",
  description: "获取指定记忆条目的完整内容。用于在 search_memory 后深入查看特定条目",
  parameters: {
    ids: {
      type: "array",
      items: { type: "string" },
      required: true,
      description: "记忆条目 ID 列表（从 search_memory 返回结果中获取）"
    }
  }
}
```

#### 2. 检索流程

```
用户查询
  |
  +-> search_memory(query, detail_level="snippet")
  |     -> 返回匹配片段（高亮显示） + 分数 + 元数据
  |     -> AI 基于片段筛选需要深入查看的条目
  |
  +-> get_memory_detail(ids=[选中的条目ID])
        -> 返回完整内容 + 所有元数据
        -> AI 分析、引用、回复用户
```

#### 3. MemoryPort 扩展

```typescript
interface MemoryPort {
  // 现有方法...

  /** 渐进式检索 - 根据 detail_level 返回不同详细程度的结果 */
  searchProgressive(query: SearchQuery & { detail_level?: 'summary' | 'snippet' | 'full' }): Promise<RetrievalResult>;

  /** 获取指定条目的完整内容 */
  getDetails(ids: string[]): Promise<MemoryEntry[]>;
}

interface RetrievalResult {
  entries: Array<{
    id: string;
    content: string;  // 根据 detail_level 返回不同内容
    snippet?: string;  // detail_level="snippet" 时返回匹配片段
    score: number;
    source: RetrievalSource;
    layer: MemoryLayer;
    contentType: MemoryContentType;
  }>;
  total: number;
}
```

### 实现方案

#### 推荐方案：基于 detail_level 的渐进式检索

**核心思路**：不存储两份数据，而是在检索时根据 `detail_level` 返回不同详细程度的内容。

**优点**：
1. 不存储两份数据，无冗余和一致性问题
2. 两个工具更简洁
3. AI 主动控制 detail_level
4. 向后兼容，现有数据无需迁移
5. snippet 使用 FTS5 highlight() 函数，性能优秀

**实现细节**：

1. **改造 search_memory 工具**：
   - 增加 `detail_level` 参数
   - 根据参数返回不同格式的结果
   - `snippet` 级别使用 FTS5 `highlight()` 函数生成匹配片段

2. **新增 get_memory_detail 工具**：
   - 接收 ID 列表，返回完整内容
   - 用于 AI 在筛选后深入查看特定条目

3. **向后兼容**：
   - 现有数据无需迁移
   - FTS5 highlight() 函数支持已有数据
   - 默认 detail_level="snippet"，提供足够的筛选信息

## 偏差记录 [required]

### D-PD-1: 渐进式披露原则纳入

**偏差对象**：F20260713m5q3 非目标"不实现 refine()"

| 项目 | 原设计 | 本文档设计 |
|------|--------|-----------|
| refine() | 不在 MemoryPort，app/agent-runtime 组合 | 通过 detail_level 参数实现渐进式检索 |

**依据**：
1. 用户明确要求"渐进式披露"原则
2. 渐进式检索是用户核心需求，必须纳入
3. 通过改造现有工具实现，不新增独立工具集

**影响**：需要改造 search_memory 工具，增加 detail_level 参数。

### D-PD-2: 渐进式披露实现方式

**偏差对象**：F20260713m5q3 存储设计

| 项目 | 原设计 | 本文档设计 |
|------|--------|-----------|
| 渐进式披露 | 未实现 | 基于 detail_level 参数的检索行为交互模式 |

**依据**：
1. 架构师-2 指出：渐进式披露是检索行为的交互模式，不是数据存储的粒度
2. 存储两条记录会导致冗余、一致性和关联问题
3. detail_level 方案更简洁，无数据迁移成本

**影响**：需要实现 snippet 生成逻辑（FTS5 highlight）和两个工具。

## 硬约束 [required]

- 不修改数据库 schema（使用现有字段）
- 不修改已有的混合检索引擎
- 不修改已有的权重系统
- 向后兼容现有数据，无需数据迁移
- snippet 使用 FTS5 highlight() 函数生成，降级时截取前 200 字符

## 实现指引

### snippet 生成策略

使用 FTS5 的 `highlight()` 函数：
```sql
SELECT memory_entry_id, highlight(memory_fts, 1, '<b>', '</b>') as snippet
FROM memory_fts
WHERE content MATCH ?
```

**降级方案**：当 FTS5 不可用时（如使用 vec0 检索），从 `content` 中截取前 200 字符作为 snippet。

### detail_level 默认值

默认使用 `snippet`：
- 提供足够的信息让 AI 进行筛选
- 不会返回过多内容，符合渐进式披露原则
- 比 `summary` 提供更多上下文，比 `full` 更轻量

### AI Agent 工具设计

1. **search_memory**（改造）：增加 `detail_level` 参数
2. **get_memory_detail**（新增）：返回指定条目的完整内容
3. 工具返回结构化数据，便于 AI 解析和决策

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 渐进式披露实现方式 | 基于 detail_level 参数的检索行为交互 | 存储两条记录（coarse/fine） | 无冗余、无一致性问题、无数据迁移成本 |
| snippet 生成 | FTS5 highlight() 函数 | 简单截取前 100 字符 | 高亮匹配关键词，提供更精准的上下文 |
| 工具接口设计 | 改造 search_memory + 新增 get_memory_detail | 三个独立工具 | 更简洁，减少 AI 选择成本 |
| 默认 detail_level | snippet | summary | 提供足够的筛选信息，符合渐进式披露原则 |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/usecases/memory/search-memory.ts` | 修改 | 实现 detail_level 参数和 snippet 生成逻辑 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | 改造 search_memory 工具，新增 get_memory_detail 工具 |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现 FTS5 highlight() 查询 |
| `tests/domain/memory/search-memory.test.ts` | 修改 | 新增 detail_level 和 snippet 测试 |

## 验收标准 [required]

- [ ] `npm run check` 通过（lint + build）
- [ ] `npm run test` 通过
- [ ] search_memory 工具支持 detail_level 参数
- [ ] detail_level="summary"：返回 ID + 首句 + 分数 + layer
- [ ] detail_level="snippet"：返回 ID + 匹配片段（高亮） + 分数 + layer + contentType
- [ ] detail_level="full"：返回完整内容 + 元数据 + 分数 + layer + contentType
- [ ] get_memory_detail 工具：返回指定条目的完整内容
- [ ] snippet 使用 FTS5 highlight() 函数生成
- [ ] 降级方案：FTS5 不可用时截取前 200 字符
- [ ] 向后兼容：现有数据可正常检索，无需迁移

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-PD-1 | 当用户查询记忆时 | 系统默认返回 snippet（匹配片段），AI 可基于片段筛选 | ← UA-1, UA-2 |
| B-PD-2 | 当 AI 需要快速浏览时 | 系统返回 summary（ID + 首句 + 分数），便于大量筛选 | ← UA-2 |
| B-PD-3 | 当 AI 选择查看特定记忆时 | 系统返回完整内容，AI 可分析、引用、回复用户 | ← UA-3, UA-4 |
| B-PD-4 | 当检索结果较多时 | 系统避免一次性返回所有全文，防止上下文爆炸 | ← UA-5 |

## 关联 [required]

- **F20260713m5q3**: domain/memory 模块实现
- **F20260709m2n8**: S2 能力模块架构设计
- **用户指令**: 渐进式披露原则
