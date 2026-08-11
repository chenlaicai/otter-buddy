---
id: F20260811dsrt
title: dissolve-realtime-update
doc_type: feature

summary: |
  修复解散小獭时右侧栏不实时更新的问题：在 SSE 的 tool.result 事件处理器中，检测到 dissolve_otter 工具执行完成后，立即调用 api.getParticipants 刷新参与者列表。

causal_links:
  from:
    - F20260811safen

status: development
change_type: fix
tags: [bugfix, realtime-update, SSE]
modules:
  - web/src/pages/conversation/index.tsx
capability_test: "n/a: 纯前端 UI 逻辑改动（A 类），无 LLM 参与行为"
---

# F20260811dsrt: 修复解散小獭时右侧栏不实时更新

## 背景与需求

### 问题描述

agent 通过 `dissolve_otter` 工具解散小獭时，右侧栏没有实时更新，用户需要刷新页面才能看到最新状态。

### 根因分析

前端的 SSE 事件处理器中，`tool.result` 事件只记录到 `liveEvents`（用于消息详情展示），没有根据工具名做特殊处理。

参与者列表的刷新只在两个时机触发：
1. 页面首次加载
2. `message.complete` 事件后的 `onDone` 回调

当 agent 执行 `dissolve_otter` 后继续执行其他工具再 `speak`，`onDone` 要等整个流程结束才触发——中间这段时间右侧栏一直显示已解散的小獭。

## 设计方案

### 核心思路

在 SSE 的 `tool.result` 事件处理器中，检测到 `dissolve_otter` 工具执行完成后，立即调用 `api.getParticipants` 刷新参与者列表。

### 实现细节

1. **提取辅助函数**：`refreshParticipantsAfterDissolve(toolName: string)`
   - 使用 `useCallback` 包装，依赖项为 `[activeId]`
   - 检测 `toolName === 'dissolve_otter'` 后调用 `api.getParticipants`
   - 错误处理：`.catch(err => console.error(...))` 输出错误日志

2. **修改三处 `tool.result` 处理器**：
   - 常驻订阅（GET `/api/conversations/:id/subscribe`）
   - 发送消息时的临时订阅
   - 重试消息时的临时订阅

3. **类型修复**：`data.toolName` 从 `unknown` 转换为 `string`

## 变更范围

- `web/src/pages/conversation/index.tsx`（+14行，-27行，净减13行）

## 测试建议

1. 创建一个小獭
2. 让 agent 执行 `dissolve_otter` 工具解散该小獭
3. 观察右侧栏是否立即移除该小獭卡片

## 验收标准

- [x] agent 调用 `dissolve_otter` 工具返回结果的瞬间，右侧栏立即移除已解散的小獭卡片
- [x] 代码 DRY 原则：辅助函数提取，消除重复代码
- [x] 错误处理：静默吞掉改为 console.error 输出

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
