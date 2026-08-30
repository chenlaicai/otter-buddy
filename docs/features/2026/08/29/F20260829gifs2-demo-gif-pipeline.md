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
- **录制路线**（v2 迭代）：分阶段 API 注入完整编排对话 + UI 实时渲染——替代「实时录一条消息赌 LLM 响应」，时序可控、叙事完整
- **GIF 压缩**：两遍 ffmpeg palette 优化，8fps，640px 宽度
- **体积**：2.25MB（目标 ≤3MB）✅
- **时长**：23.25s（目标 ≤25s）✅

### 分镜对照（v2：四幕叙事完整性）

| 幕 | 内容 | 时间点 | 达成 |
|----|------|--------|------|
| 幕1 | 用户派任务 | 0-5s | ✅ chen 发「git 周报」任务 |
| 幕2 | 大獭编排发言 | 4-11s | ✅ 接单 + 派 mimo 小獭 |
| 幕3 | 小獭执行汇报 | 8-19s | ✅ mimo 干活并汇报进展 |
| 幕4 | 大獭总结带📜溯源交回 | 16-23s | ✅ 📜 溯源行 + yield user |

> v1 审视教训：只验收孤立镜头（名字/📜/流转）不验收叙事完整性，导致 15s GIF 只有一轮问答、编排全无。v2 验收红线：四幕缺一不通过。

## 产物

- `docs/images/demo-multi-agent.gif` — GIF 演示（2.25MB / 23.25s，四幕完整编排）
- README.md / README.en.md — 首图区域嵌入 GIF
- 录制脚本 — 放在对话工作区（不进 PR）

## 取舍

| 决策 | 理由 |
|------|------|
| 分阶段注入+实时渲染（v2）而非真实 LLM 对话直录（v1） | 真实编排需数分钟 LLM 时间，25s 上限内无法呈现完整四幕；注入的消息本身是真实编排对话的复刻 |
| 时长上限从 15s 放宽到 25s | 四幕叙事完整性的优先级高于时长紧凑；clone 体积红线（≤3MB）不变 |
| 两遍 ffmpeg 而非单遍 | 体积小 40-60% |
| 录制脚本不进 PR | 脚本是开发工具，不属于 README 交付 |
