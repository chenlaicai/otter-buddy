---
id: F20260807tprt
title: tool-result-truncation
doc_type: feature

summary: |
  工具返回结果增加大小上限，防止巨量 tool result 污染上下文导致 mimo 退化。
  根因是 search_memory 返回 70K+ 字符、read 返回 48K 字符，上下文被撑爆后模型陷入重复循环。
  在 tool-helpers 层统一截断（15K 字符），search_memory snippet 统一截断到 200 字符。

causal_links:
  from:
    - F20260807snip
  to: []

status: development
change_type: fix
tags: [agent, context-management, degenerate-detection]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-helpers.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/usecases/memory/search-memory.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260807tprt: 工具结果截断防止上下文退化

## 案发现场

系统重启后多个大獭同时退化（repeat_window / distinct_ratio 触发）：

| Otter | 任务 | 退化次数 | 关键 tool result |
|---|---|---|---|
| 862dc691 | 对话标题复制按钮 | 2 | read: 48702 chars（conversation/index.tsx 全文） |
| 54defc5f | 重启提示词默认值 | 2 | search_memory × 2: 36400 + 33712 chars |

退化模式：mimo 的 thinking block 完全重复 4 次，text 输出逐轮膨胀（1503 → 4511 → 4887 → 41903 chars）。

## 根因分析

### 直接原因：工具结果无大小上限

- `search_memory` 默认返回 10 条结果，每条含完整 content（可达 2000+ chars），两个调用合计 70K+ chars
- SDK `read` 工具返回整个文件内容（48K chars for 1224 行 TSX）
- 无任何截断机制，tool result 原样传给 LLM SDK

### 加剧因素

- search_memory 的 snippet 字段与 content 字段内容相同（FTS highlight 未截断），双重膨胀
- 退化内容已实时写入 session 文件（SDK streaming 落盘），重试时上下文仍包含退化输出
- 重试流程额外注入身份消息，进一步扰乱上下文

### 为什么 F20260807snip 未覆盖

F20260807snip 修的是 `<b>` HTML 标签污染 memory snippet。本次是 tool result 整体过大，是不同维度的问题。

## 修复方案

### 修点 1：tool result 统一截断（tool-helpers.ts）

新增 `truncateToolResult()` 函数，单个 text block 超过 15000 字符时截断，附加截断提示。

在 `pi-session-factory.ts` 的 `buildCustomTools()` 中包裹所有自定义工具的 execute 调用。

### 修点 2：search_memory snippet 截断（search-memory.ts）

`buildSnippet()` 中 FTS highlight snippet 统一截断到 `SNIPPET_FALLBACK_LENGTH`（200 字符），
此前仅 vec-only 降级路径截断，FTS 路径返回完整 highlight。

## 已知边界

- SDK 内置工具（read/write/edit/bash）的返回值不在 otter 层拦截，需 SDK 侧支持
- 截断后的提示引导模型用 offset/limit 分段读取，但模型不一定遵从
- 退化内容落盘问题（session file streaming write）需要更深层的 session 管理改造

## 验证

- 全量测试通过（982 tests）
- search-memory 测试通过（17 tests）
- TypeScript 编译无错误
