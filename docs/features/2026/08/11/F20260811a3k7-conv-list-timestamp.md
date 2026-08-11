---
id: F20260811a3k7
title: conv-list-timestamp
doc_type: feature

summary: |
  左侧聊天列表（LeftPanel）新增最后消息相对时间显示，方便用户快速区分近期对话和历史对话。
  支持"刚刚"、"N分钟前"、"N小时前"、"昨天 HH:mm"、"MM-DD HH:mm"等格式，跨年消息显示完整年份。

causal_links:
  from: []

status: implemented
change_type: feature
tags: [conversation, ux, timestamp, relative-time, left-panel]
modules:
  - web/src/lib/utils.ts
  - web/src/lib/utils.test.ts
  - web/src/pages/conversation/LeftPanel.tsx

created_at: 2026-08-11
---

# F20260811a3k7 左侧聊天列表显示最后消息相对时间

## 问题描述

### 用户反馈
- **现象**：左侧聊天列表缺乏时间信息，难以区分哪些是最近活跃的对话、哪些是历史聊天
- **影响**：用户需要逐个点击对话才能了解最后活动时间，效率低下

### 技术现状
- 后端已提供 `lastMessageTs` 字段（来自 `lm.created_at`）
- 前端 `LocalConversation` 类型已包含 `lastMessageTs` 字段
- 仅需在 UI 层展示即可

## 解决方案

### 1. 新增 `fmtRelativeTime()` 工具函数
- **位置**：`web/src/lib/utils.ts`
- **功能**：将时间戳格式化为相对时间描述
- **支持格式**：
  - 刚刚（< 60秒）
  - N分钟前（1-59分钟）
  - N小时前（1-23小时）
  - 昨天 HH:mm
  - MM-DD HH:mm（同年内更早日期）
  - YYYY-MM-DD HH:mm（跨年消息）

### 2. ConversationItem 组件集成
- **位置**：`web/src/pages/conversation/LeftPanel.tsx`
- **展示位置**：对话标题右侧，使用灰色小字（`text-[10px] text-stone-400`）
- **显示条件**：仅当 `lastMessageTs` 存在时显示

### 3. 单元测试覆盖
- **位置**：`web/src/lib/utils.test.ts`
- **测试用例**：
  - 空字符串返回空字符串
  - 无效日期返回原字符串
  - 刚刚（< 60秒）
  - N分钟前（1-59分钟）
  - N小时前（1-23小时）
  - 昨天 HH:mm
  - 同年内更早日期 MM-DD HH:mm
  - 跨年消息 YYYY-MM-DD HH:mm
  - UTC 时间带 Z 后缀正确处理

## 设计决策

### 时间格式选择
- **相对时间 vs 绝对时间**：选择相对时间，更直观（如"5分钟前" vs "2026-08-11 15:00"）
- **符合用户习惯**：用户更关心"多久之前"而非具体时间点

### 展示位置
- **标题行右侧**：不干扰主要信息（标题、未读消息、状态）
- **灰色小字**：视觉层次清晰，不喧宾夺主

### 自动刷新机制
- **依赖现有轮询**：`useConversationListPolling` 每 5 秒刷新对话列表
- **组件重渲染**：轮询更新 `conversations` 触发组件重渲染，`fmtRelativeTime` 随之更新
- **无需额外定时器**：利用现有机制，保持架构简洁

## 测试结果

- 根目录测试：88 files, 1053 tests passed ✅
- Web 目录测试：13 files, 118 tests passed ✅
- Lint 检查：通过 ✅

## 相关 Issue

- #225 - [conversation][test] LeftPanel 时间戳集成测试（低优先级，后续跟进）

## 变更文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `web/src/lib/utils.ts` | 新增函数 | `fmtRelativeTime()` 相对时间格式化函数 |
| `web/src/lib/utils.test.ts` | 新增文件 | 9 个测试用例，覆盖所有分支 |
| `web/src/pages/conversation/LeftPanel.tsx` | 修改 | 导入并使用 `fmtRelativeTime`，展示时间戳 |

## 影响分析

### 正面影响
- 用户可快速区分近期对话和历史对话
- 提升聊天列表的信息密度和可用性

### 风险评估
- **无破坏性变更**：仅新增展示，不影响现有逻辑
- **无性能影响**：利用现有轮询机制，无额外开销
- **无兼容性问题**：`lastMessageTs` 字段已由后端提供

## 后续改进

1. **LeftPanel 时间戳集成测试**（#225）：验证 `lastMessageTs` 存在/缺失时的渲染行为
2. **时间格式本地化**：支持多语言相对时间格式（如英文 "5 minutes ago"）
