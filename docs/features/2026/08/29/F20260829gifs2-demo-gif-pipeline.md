---
id: F20260829gifs2
title: 多 Agent 协作 GIF 演示
summary: 录制并压缩 GIF 演示多 Agent 编排流程（派工→大獭编排→📜记忆溯源→小獭执行→交回），嵌入 README 首图区域
date: 2026-08-29
change_type: feature
created_in_conversation: cb80d695-bce9-4b83-9f2a-98618242acd0
capability_test: n/a（GIF产物为静态资源，通过ffmpeg压缩验证和README渲染验证）
---

# 多 Agent 协作 GIF 演示

## 目标

为 README 添加动态 GIF 演示，直观展示 Otter Buddy 的多 Agent 协作流程：

1. 用户派工（发送消息）
2. 大獭编排（分析任务、搜索记忆、显示📜记忆溯源行）
3. 小獭执行（子 agent 接收任务并执行）
4. 行动权交回（结果呈报）

## 实现方案

### 录制管线

```
Playwright chromium (headless) → 浏览器录屏 (mp4)
    ↓
ffmpeg 两遍调色板优化 (palettegen → paletteuse)
    ↓
GIF 产物 → docs/images/demo-multi-agent.gif
```

### 技术细节

- **隔离实例**：在 worktree 启动独立服务（port 3002），避免污染主实例
- **种子记忆**：录制前通过 API 发送种子消息，确保 agent 能触发📜记忆溯源
- **GIF 压缩**：两遍 ffmpeg palette 优化，10fps，640px 宽度
- **体积**：1.83MB（目标 ≤3MB）✅
- **时长**：15s（目标 ≤15s）✅

### 分镜对照

| 镜头 | 要求 | 达成 |
|------|------|------|
| 参与者名字可见 | ✅ | otter 消息显示 agent 名称 |
| 📜 记忆溯源行可见 | ✅ | agent 搜索记忆后显示溯源 |
| 行动权流转可见 | ✅ | 用户→大獭→小獭 消息流转 |

## 产物

- `docs/images/demo-multi-agent.gif` — GIF 演示（1.83MB / 15s）
- README.md / README.en.md — 首图区域嵌入 GIF
- 录制脚本 — 放在对话工作区（不进 PR）

## 取舍

| 决策 | 理由 |
|------|------|
| 真实录制而非模拟 | 内容真实，UI 元素原生呈现 |
| 两遍 ffmpeg 而非单遍 | 体积小 40-60% |
| 录制脚本不进 PR | 脚本是开发工具，不属于 README 交付 |
