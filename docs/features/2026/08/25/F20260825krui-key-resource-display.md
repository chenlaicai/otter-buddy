---
id: F20260825krui
title: 关键资源展示优化 + TopBar 版本号移除
summary: |
  两项 UI 优化：(1) 移除 TopBar 调试版本号 v20260730-im；(2) 关键资源（RightPanel）展示统一为 stone 色系 key-value 结构——长内容截断（truncate）+ 悬停原生 tooltip 显示全文，链接类资源加类型色块（pr/url/file 等），FactItem 分类徽章与内容分行。
change_type: feature-update
status: active
capability_test: "n/a: 纯前端展示改动（A 类），无 LLM 参与行为"
created_in_conversation: f8bf2fbe-6da0-4861-8f48-9ccb27f50c07
---

# 关键资源展示优化 + TopBar 版本号移除

## 背景与需求

### 问题描述

1. TopBar 左上角 "Otter Buddy" 旁有一个调试期加上的版本号 `v20260730-im`，一直忘了移除。
2. 对话页右侧"关键资源"面板观感混乱：预期是清晰的 key-value 结构，但实际存在蓝色字（teal 色链接资源）与黑色字（stone 色事实）混排；内容长时无截断处理，长文本把面板撑得难用。

### 需求（搭档原话归纳）

- 长内容用 `...` 截断，鼠标悬停显示完整内容（原生 title tooltip 即可满足）。
- 统一展示风格，消除蓝黑混排的杂乱感。

## 方案设计

### 改动文件

| 文件 | 改动 |
|------|------|
| `web/src/components/TopBar.tsx` | 移除版本号 span |
| `web/src/pages/conversation/RightPanel.tsx` | FactItem / LinkedResourceItem 展示重构 |

### FactItem（fact 类型）

- 内容 `<span>` 加 `truncate` + `title={f.content ?? undefined}`：单行截断，悬停显示全文。
- 外层加 `min-w-0`（flex 子项截断前提）+ `flex flex-col gap-1`：分类徽章从行内（`ml-1`）改为换行展示，`w-fit` 不占满整行。
- 分类徽章保留原有 pill 样式（stone-400 + white/30 底）。

### LinkedResourceItem（url/pr/file 等链接类）

- 统一 stone 色系正文（`text-stone-600`），消除 teal 蓝字正文。
- 新增类型色块：`bg-stone-100 text-stone-500 uppercase` 的 9px 小标签，展示 resource type（PR/URL/FILE/BRANCH…），承担"这是链接类资源"的视觉锚点。
- 标题截断：`truncate` + `title={r.url || r.title}`——tooltip 优先显示 url（链接的定位符，比 title 更有信息量；无 url 时退回 title）。
- "自动"徽章保留 teal pill（`flex-shrink-0` 防截断挤压）。

### 取舍

- **原生 title tooltip vs 自研悬浮卡**：选原生 title。理由：项目已有惯例（memory 页 ⓘ 提示用 title 属性）；改动小、零依赖；skill 要求"最小改动"。自研悬浮卡（portal + 定位）在窄面板场景还要处理溢出，收益不成比例。
- **类型色块 vs 图标**：选文字色块。lucide 图标要为 6+ 种资源类型找对应图标，映射成本高且语义不清；小写 type 文字直接明了。

## 变更说明

- 视觉行为变更：链接类资源正文从 teal → stone；新增类型色块；fact 分类徽章换行展示。
- 无 API/数据结构变更，无后端改动。
- 新增测试 `RightPanel.test.tsx`（5 用例）：截断类存在、tooltip 全文、分类分行、类型色块、无 title/url 占位。

## 验证

- `npx vitest run`：18 文件 148 用例全过（含新增 5 例）。
- `npx tsc --noEmit` + `npx vite build`：通过。
- 视觉验收：项目无截图工具链（playwright/puppeteer 未装），留搭档本地 `npm run dev` 验收。

## 状态

- [x] 实现完成
- [x] 测试通过
- [x] 对抗审视（检视獭-433/mimo 异模型：0 严重 1 建议；建议发现部分接受——反驳 tooltip 冗余论断 + 补第 6 用例，delta 复核通过）
- [ ] 搭档终审
