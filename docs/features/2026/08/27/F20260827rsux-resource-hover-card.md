---
id: F20260827rsux
title: 关键资源悬浮详情卡与快速复制
doc_type: feature

# 记忆索引
summary: |
  右侧栏关键资源条目的悬浮展示升级：原生 title tooltip（灰条、无样式、超长不换行、不可复制）
  替换为玻璃拟态悬浮详情卡——停留 400ms 弹出，全文 wrap 不截断，文本可选中，右上角一键复制
  （clipboard API + execCommand 降级）。fact 与链接类（file/pr/branch/worktree/url）共用
  ResourceHoverCard + useResourceHover；Portal + fixed 定位摆脱 aside overflow 剪裁（沿 F20260826pfix 模式）。

# 因果链路
causal_links:
  from: []
  to: []

# 元数据
status: implemented   # 代码已实现（测试全绿），待对抗审视
change_type: feature
capability_test: "web/src/pages/conversation/RightPanel.test.tsx"
tags: [web-ui, right-panel, linked-resource, copy-ux]
modules: [web/src]

# 时间
created_at: 2026-08-27
created_in_conversation: 60a89cc6-f61e-4e5c-a034-bb0570bf4735
---

# 关键资源条目：悬浮详情卡 + 快速复制

## 背景

搭档反馈两个痛点：
1. **复制不方便**——资源条目截断后，value 只能悬停看原生 title tooltip，没法快速复制（PR 号、路径、事实文本都是要贴到别处用的）
2. **原生 tooltip 简陋**——灰底黑字无样式，超长不换行，视觉与产品玻璃拟态风格脱节

## 方案

新增 `ResourceHoverCard`（玻璃拟态悬浮卡）+ `useResourceHover`（hover 态 hook），替换 FactItem / LinkedResourceItem 的原生 title tooltip：

| 维度 | 旧（title tooltip） | 新（ResourceHoverCard） |
|------|---------------------|------------------------|
| 触发 | 立即 | 停留 400ms（防快速滑过误弹，与 OtterParticipantCard 快览卡同节奏） |
| 样式 | 系统原生灰条 | glass-strong 圆角卡 + shadow-bubble，280px 定宽 |
| 内容 | 纯文本不换行 | 分类徽章 + 全文 wrap（break-all + whitespace-pre-wrap） |
| 复制 | 无 | 文本可选中 + 右上角复制按钮（成功 1.5s 显示 ✓） |
| 定位 | 浏览器托管 | Portal → document.body + fixed 坐标（clamp 防出屏） |

**关键实现**：
- Portal 摆脱 aside `overflow-y-auto` 剪裁——F20260826pfix 已验证的模式（快览卡同款问题：浮层在滚动容器内会被顶缘剪裁）
- 复制走 `navigator.clipboard.writeText`，非安全上下文（局域网 IP 访问）降级 `execCommand`——与 Modals.tsx 的会话 id 复制同策略；Modals 内私有 legacyCopy 未导出，此处内联一份（两处 20 行重复，待后续统一提取，不值得为本次拉共享模块）
- 触屏设备不弹（isTouchDevice 复用既有惰性检测）——触屏无 hover，点击语义留给删除/星标

## 改动

| 文件 | 改动 |
|------|------|
| `web/src/pages/conversation/RightPanel.tsx` | +ResourceHoverCard/legacyCopy/useResourceHover；FactItem、LinkedResourceItem 接入，删 title 属性 |
| `web/src/pages/conversation/RightPanel.test.tsx` | 3 个旧 title 断言更新为 hover 卡行为；+3 个 hover 卡新用例 |

## 验证

- RightPanel.test 15/15（12 旧 + 3 新 hover 卡）
- web 全量 vitest 239/239
- tsc --noEmit 0 错

## 取舍

- **不做成 Modal/点击展开**：资源条目是高频扫视列表，点击语义已被删除/星标占据；hover 是最轻的详情通道
- **复制按钮放卡内右上角而非条目上**：条目宽度只有 256px（w-64 面板），塞下复制按钮会挤压标题；卡内空间充足且语义清晰（复制「这张卡」的内容）
- **复制内容由调用方声明式传入（copyText）**，不从卡内 DOM 抓 innerText（检视发现 2 处置）：链接类传「标题\nurl」（贴走的是完整可定位信息）；fact 类只传事实正文，分类徽章是展示元数据不进剪贴板
