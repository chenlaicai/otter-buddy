---
id: F20260721k9m2
title: conv-create-otter-fix
doc_type: feature

summary: |
  修复"每个对话创建独立大獭"特性（F20260720qs9y）遗留的三个 bug：
  1. 对话创建 API 返回类型不含 otterIds，前端无法获取新对话的大獭
  2. 前端创建对话后未加载 otter 数据，导致"没有可用的 Otter"错误
  3. 自定义 LLM 模型缺少 cost 字段，SDK 计算费用时 tiers 报错导致大獭无响应

causal_links:
  from:
    - F20260720qs9y   # 每个对话创建独立大獭

status: implemented
change_type: fix
tags: [conversation, otter, api, frontend, llm, sdk]
modules: [interface-adapters/http, usecases/conversation, frameworks/llm, web]

created_at: 2026-07-21
---

# F20260721k9m2 - 对话创建与大獭响应修复

## 1. 问题描述

### Bug 1：对话创建 API 返回类型不一致

- `list` 返回 `ConversationListItemDTO`（含 `otterIds`）
- `create` 返回 `ConversationDTO`（不含 `otterIds`）
- 前端 `mapConversationDTO` 期望 `ConversationListItemDTO`
- 结果：新建对话的 `otterIds` 为 `undefined`，发送消息时找不到 otter

### Bug 2：前端创建对话后未加载 otter 数据

- `confirmNewConv` 同时设了 `allMessages[conv.id] = []` 和 `setActiveId`
- React 18 批量更新后，`useEffect` 看到 `allMessages[activeId]` 已有值（空数组），跳过 `loadConversationDetail`
- 原代码未暴露是因为当时有全局大獭已在 `allOtters` 里

### Bug 3：自定义模型缺少 cost 字段

- `models-factory.ts` 的 `loadCustomProvider` 创建自定义模型时未携带 `cost` 字段
- SDK 的费用计算代码访问 `model.cost.tiers` 时 `cost` 为 `undefined`，抛出 `Cannot read properties of undefined (reading 'tiers')`
- LLM 响应正常返回但 SDK 后处理崩溃，`stopReason: "error"`，content 为空

## 2. 修复方案

### 后端：API 返回类型统一

`ConversationController.create` 查 participants 后返回 `ConversationListItemDTO`，与 `list` 一致。

### 后端：大獭名字修复

`ManageConversation.create` 中大獭名字从 `大獭-${title}` 改为 `大獭`。

### 后端：自定义模型补充 cost

`loadCustomProvider` 创建模型时从 template 继承 `cost`，无则给零值默认。

### 前端：创建对话后加载详情

`confirmNewConv` / `confirmChild` 去掉预设空数组，改为显式 `await loadConversationDetail(conv.id)`。

### 前端：message.complete 提取实际内容

从 `assistant_text` 事件中提取文本替代硬编码 `"fixme"`。

### 脚本：otter-buddy.sh 改进

- 修复 `is_running()` / `port_owner_pid()` 在 `set -euo pipefail` 下的静默退出
- 健康检查 URL 从 `/api/otters/big` 改为 `/api/settings`
- 增加前端构建步骤
- 增加进度输出和错误信息
- 日志输出到 `.otter-buddy.log`

## 3. 影响范围

- `scripts/otter-buddy.sh` — 脚本可靠性与可观测性
- `src/interface-adapters/http/controllers/conversation-controller.ts` — API 响应
- `src/usecases/conversation/manage-conversation.ts` — 领域逻辑
- `src/frameworks/llm/models-factory.ts` — LLM 模型配置
- `web/src/pages/conversation/index.tsx` — 前端对话流程
