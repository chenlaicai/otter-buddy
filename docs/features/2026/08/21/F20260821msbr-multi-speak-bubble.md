---
id: F20260821msbr
title: 多 speak 气泡分段渲染
doc_type: feature
summary: |
  将 speak 工具的长输出按段落拆分为多个子气泡，支持流式分段渲染和历史消息分段展示。
  解决单气泡长文本难以阅读的问题。

causal_links:
  from:
    - F20260821spcm
  references:
    - "#368"

status: development
change_type: feature_update
created_at: "2026-08-21"
created_in_conversation: "e2fa3ea3-3efc-43e4-ba56-2436d0ee930d"
tags: [speak, segment, UI, streaming, frontend, backend]
modules:
  - "src/interface-adapters/agent-runtime/agent-invoker.ts"
  - "src/interface-adapters/agent-runtime/tools/tool-factory.ts"
  - "src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts"
  - "web/src/lib/mappers.ts"
  - "web/src/lib/use-speak-segments.ts"
  - "web/src/pages/conversation/MessageList.tsx"
  - "web/src/pages/conversation/index.tsx"
---

## 背景

在多智能体对话中，海獭的 speak 输出通常是长文本，全部内容显示为一个大气泡。
当内容很长时，用户难以快速定位和阅读不同段落。

## 设计目标

1. **流式分段**：speak 输出按段落（`\n\n` 分隔）拆分为多个子气泡，实时渲染
2. **历史一致**：刷新页面后，历史消息保持分段显示
3. **向后兼容**：旧服务端无分段数据时，fallback 到单气泡显示

## 方案设计

### 后端

- `message_segments` 表存储分段数据（每个 speak 调用为一个 segment）
- `speak.intermediate` SSE 事件新增 `segmentId` + `sequenceNum` 字段
- `message.complete` SSE 事件新增 `segments` 数组
- `MessageDTO` 新增 `segments` 可选字段，历史加载时携带分段数据

### 前端

- `useSpeakSegments` hook 管理流式分段状态（upsert/refresh/clear）
- `MessageItem` 分段渲染：每个 segment 作为独立子气泡，段间有分隔线
- `mapMessageDTO` 映射 `dto.segments` 到 `LocalMessage.segments`

## 已知限制

1. **段间分隔线**：当前硬编码深色边框（`rgba(0,0,0,0.06)`），深色主题下可能不明显
2. **MessageDTO segments 字段**：仅在 segments 非空时携带（向后兼容）

## 验收标准

- [x] 流式 speak 输出按段落拆分为子气泡
- [x] 历史消息加载保持分段显示
- [x] 旧服务端无 segments 时 fallback 到单气泡
- [x] 所有现有测试通过
