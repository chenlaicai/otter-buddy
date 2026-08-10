---
id: F20260810dp01
title: F20260810dp01-user-display-name
summary: "用户消息气泡显示设置中配置的称呼替代硬编码的\"我\""
status: development
created: 2026-08-10
---

# 用户消息气泡显示设置中配置的称呼

## 背景

用户在设置页面配置了"你的名字"（如"chen"），但对话 UI 的消息气泡旁仍显示硬编码的"我"，头像首字母也固定显示"我"。这导致用户体验不一致——设置中的称呼配置在对话界面完全无效。

## 目标

- T1: 消息气泡旁的名称显示使用设置中配置的称呼
- T2: 头像首字母使用配置的名称
- T3: 留空时 fallback 到"我"
- T4: 全局统一用户身份显示

## 方案设计

### 数据流

```
settings API → ConversationPage (state) → ChatView (prop) → MessageList (prop) → MessageItem (渲染)
```

### 改动文件

| 文件 | 改动 |
|------|------|
| `web/src/pages/conversation/index.tsx` | 新增 `userName` state，启动时调 `api.getSettings()` 获取 |
| `web/src/pages/conversation/ChatView.tsx` | 新增 `userName` prop，透传给 `MessageList` |
| `web/src/pages/conversation/MessageList.tsx` | 新增 `userName` prop，`MessageItem` 中用 `userName?.trim() \|\| '我'` 替代硬编码 |

### 边界处理

- `userName` 为 undefined / 空字符串 / 纯空格 → fallback 到"我"
- settings API 请求失败 → `console.warn` 记录日志，fallback 到"我"
- `SettingsDTO.userName` 为必填 string，`?? ''` 是额外防御

## 验收标准

- [x] 配置"你的名字"为"chen"后，消息气泡旁显示"chen"而非"我"
- [x] 头像首字母显示"C"而非"我"
- [x] 留空时 fallback 到"我"
- [x] Lint 通过
- [x] Build 通过
- [x] CI 通过

## 已知限制

- userName 仅 mount 时获取一次，当前 MPA 整页跳转模式下行为正确，未来改 SPA 路由时需注意（#209）
