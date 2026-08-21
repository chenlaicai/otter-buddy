---
title: "多 speak 气泡分段渲染"
doc_type: "feature"
change_type: "New Feature"
created_at: "2026-08-21"
created_in_conversation: "e2fa3ea3-3efc-43e4-ba56-2436d0ee930d"
tags: ["speak", "segment", "UI", "streaming", "frontend", "backend"]
modules:
  - "src/interface-adapters/agent-runtime/agent-invoker.ts"
  - "src/interface-adapters/agent-runtime/tools/tool-factory.ts"
  - "src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts"
  - "web/src/lib/mappers.ts"
  - "web/src/lib/use-speak-segments.ts"
  - "web/src/pages/conversation/MessageList.tsx"
  - "web/src/pages/conversation/index.tsx"
  - "api-contract/sse/events.ts"
from: ["F20260821mcp23"]
supersedes: []
---

# 多 speak 气泡分段渲染

## 问题背景

海獭在多人对话中经常多次调用 speak 工具，每次 speak 创建一个 MessageSegment。但前端 UI 将所有 segments 合并为一个大 bubble 渲染，缺乏视觉分隔，难以区分各次发言。

### 当前行为

| 层 | 行为 | 问题 |
|---|---|---|
| 后端实体 | `Message.segments[]` 已有分段 | ✅ 数据模型支持 |
| SSE 事件 | `message.complete` 发 `body: aggregateBody(segments)` | ❌ `\n\n` 拼接，边界丢失 |
| 前端流式 | `speak.intermediate` 累积进单个 `liveText` 字符串 | ❌ 无法区分各段 |
| 前端 UI | 一个大 bubble 渲染所有内容 | ❌ 多次 speak 没有视觉分隔 |

## 设计方案

### SSE 协议层

**方案**：字段增强，不新增事件。

- `speak.intermediate` 补 `segmentId` + `sequenceNum`（int）
- `message.complete` 补 `segments: [{id, body, sequenceNum}]` 数组
- 保留 `body` 字段（向后兼容，旧客户端继续用聚合文本）

**否决的备选**：
- 新增 segment.start/segment.delta 事件：过度设计——speak 落库是一次性动作，没有真增量流
- 只在 complete 发 segments：流式期间也要分段

### 前端数据模型

- `liveText: Map<messageId, string>` 保留为 fallback
- `liveSegments: Map<messageId, Map<segmentId, {body, sequenceNum}>>` 用于分段
- `speak.intermediate` handler：从「字符串追加」改为「按 segmentId upsert」——天然幂等
- `message.complete` handler：以后端 segments 为准覆盖本地；旧服务端无 segments 字段则 fallback 单段

### UI 渲染

**方案**：段间分隔气泡（单头像 + 段栈）

- 头像 + 名字只出现一次，下方垂直堆叠 N 个 segment 块
- 段间用 `borderTop: 1px solid rgba(0,0,0,0.06)` + `paddingTop: 0.5rem` 分隔
- 不要每段一个头像——会误读成多条独立消息，破坏 turn 语义
- 流式期间新 segment 到达即在底部追加新块（fade-in）

## 实施

### 后端改动

1. **tool-factory.ts**：捕获 `appendSegment` 返回值，传递 `segmentId` + `sequenceNum` 到 details
2. **agent-invoker.ts**：在 `speak.intermediate` SSE 事件中传递 `segmentId` + `sequenceNum`
3. **orchestrator.ts**：在 `message.complete` SSE 事件中添加 `segments` 数组

### 前端改动

1. **mappers.ts**：新增 `LocalMessageSegment` 类型，`LocalMessage` 增加 `segments` 可选字段
2. **use-speak-segments.ts**：新增 hook 管理流式分段状态
3. **index.tsx**：三处 SSE handler 更新支持分段
4. **MessageList.tsx**：`MessageItem` 分段渲染

### API 契约

1. **api-contract/sse/events.ts**：`SSEEventMap` 类型更新，`speak.intermediate` 补 `segmentId`/`sequenceNum`，`message.complete` 补 `segments`

## 测试结果

- 112 文件 / 1351 用例全通过
- 构建成功
- CI 通过

## 向后兼容

| 场景 | 影响 |
|---|---|
| 旧服务端 + 新前端 | complete 无 segments 字段时 fallback body 单段 |
| 新服务端 + 旧前端 | body 字段保留，旧前端无感 |
| 飞书/memory/FTS | aggregateBody 不动 |

## 已知限制

- 历史消息 DTO 无 segments 字段，退化为单气泡展示（Issue #369）
- 段间分隔线深色主题兼容性待后续迭代

## 决策史

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-08-21 | SSE 字段增强而非新增事件 | speak 是一次性落库，无真增量流 |
| 2026-08-21 | Array 而非 Map 存储 segments | segments 1-5 个，Array sort 更自然 |
| 2026-08-21 | 纯间距 + 细分隔线第一版 | 保守起点、可迭代 |
