---
id: F20260811abce
title: fix-streaming-text-accumulation
doc_type: feature

summary: |
  修复非 Web 通道（飞书消息、定时任务等）在 web 端流式阶段不显示文本内容的问题。
  GET 订阅通道和 POST 流通道的 assistant_text 处理器只将事件写入 liveEvents（流式过程面板），
  未将文本内容累积到 m.content（消息正文渲染区），导致消息正文在 message.complete 之前始终为空。
  修复方式：在两个通道的 assistant_text 处理器中，提取 text 类型的 content blocks 并追加到 m.content，
  与重试流处理器行为一致。message.complete 最终会用 DB 中的完整 body 替换，保证最终结果正确。

status: implemented
change_type: fix
tags: [conversation, sse, streaming, text-accumulation]
modules:
  - web/src/pages/conversation/index.tsx
capability_test: "n/a: 纯前端 UI 逻辑改动，无 LLM 参与行为"
causal_links:
  from:
    - F20260805abpp   # scroll-jank-architecture-fix，引入了 GET 订阅通道的 assistant_text 处理器但遗漏文本累积
---

# F20260811abce: 修复非Web通道消息流式文本不显示

## 背景

### 现象

飞书侧发消息后，web 端只在 `message.complete` 时一次性显示最终 body，流式过程中消息正文始终为空（只显示"正在回复..."）。

### 根因

前端 SSE 事件处理有三个 `assistant_text` 处理器：

| 处理器 | 位置 | 文本累积 |
|--------|------|---------|
| GET 订阅（常驻通道） | index.tsx ~502 行 | ❌ 缺失 |
| POST 流（发送通道） | index.tsx ~741 行 | ❌ 缺失 |
| 重试流 | index.tsx ~952 行 | ✅ 有 |

GET/POST 两个处理器只将事件写入 `liveEvents`（流式过程面板数据），未提取文本内容追加到 `m.content`（消息正文渲染区）。重试流处理器已有正确的文本累积逻辑，说明这是遗漏而非设计决策。

消息来自飞书时，web 端只有 GET 订阅通道接收事件，所以 `m.content` 始终为空，直到 `message.complete` 一次性替换为 DB 中的完整 body。

## 变更

1. **GET 订阅 assistant_text 处理器**（index.tsx ~502 行）：补上文本提取 + 追加到 `m.content` 的逻辑，使用 `Array.isArray()` 防御类型检查。
2. **POST 流 assistant_text 处理器**（index.tsx ~741 行）：同上。

## 设计决策

- **`message.complete` 覆盖**：累积的文本在 `message.complete` 时被 DB 完整 body 替换，最终结果与不累积完全一致。累积只影响流式阶段的用户体验。
- **不提取辅助函数**：两通道文本累积逻辑相同（~5 行），但对 bugfix PR 来说提取函数过度工程化，留后续优化。
- **`Array.isArray()` 防御**：对齐重试处理器的模式，非数组 content 时静默跳过而非抛 TypeError。

## 验收场景

| 编号 | 复现步骤 | 预期结果 |
|------|---------|---------|
| AT-1 | 飞书侧发消息，观察 web 端 | 流式过程中消息正文逐步出现（不再只显示"正在回复..."） |
| AT-2 | Web 端发消息，观察流式过程 | 流式过程中消息正文逐步出现（POST 流也受益） |
| AT-3 | message.complete 后观察 | 最终 body 正确替换，与修复前一致 |

## 审视记录

检视獭对抗审视（2026-08-11）：无阻断发现，两个非阻断发现。

| 编号 | 发现 | 严重度 | 处置 |
|------|------|--------|------|
| N1 | `data.content` 类型防御不如重试处理器健壮（类型断言 vs Array.isArray） | 非阻断 | 已修复：两处改为 Array.isArray() 先校验 |
| N2 | 两通道文本累积逻辑完全重复（~5 行） | 非阻断 | 延后：bugfix PR 不提取辅助函数 |

## 影响面

- **飞书消息**：web 端流式文本实时显示（主要修复目标）
- **定时任务**：web 端流式文本实时显示
- **Web 发消息**：流式文本实时显示（附带收益）
- **最终结果**：不变（message.complete 覆盖）
