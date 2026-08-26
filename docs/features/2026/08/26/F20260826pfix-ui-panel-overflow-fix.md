---
id: F20260826pfix
title: ui-panel-overflow-fix
doc_type: feature

# 记忆索引
summary: |
  海獭面板 UI 展示问题修复（三路审视：大獭+界面獭kimi+交互獭mimo 汇总 9 实锤）。
  P0 七项：HelpIcon 气泡 Portal 化脱离 overflow 剪裁（截断根因）；
  Modal desktop 高度上限不再因 fullScreenOnMobile 丢失（无滚动条根因，双模型独立确认）；
  OtterDetailModal 加 key 消除展开状态跨獭串台；会话列表页右键菜单视口钳位；
  hover 快览卡 Portal 化（bottom-0 锚定顶缘剪裁）；面板宽 min(580px,92vw)；
  Modal 焦点管理 + HelpIcon aria。P1（三栏响应式/滚动 token 化）与 P2（轮询抖动）另行立项。

# 因果链路
causal_links:
  from: []

# 元数据
status: development
change_type: bugfix
capability_test: "n/a: 纯前端 UI 组件变更，无 LLM 参与行为；验证走 web 单测（vitest）"
tags: [web-ui, bugfix, modal, help-icon, accessibility, portal]
modules: [web/src]

# 时间
created_at: 2026-08-26
created_in_conversation: 60a89cc6-f61e-4e5c-a034-bb0570bf4735
---

# 海獭面板 UI 展示问题修复（P0）

## 背景

搭档原话（意图锚）：

> 「问号弹窗会被 面板边缘直接截断，导致我根本看不全；以及，因为工具、内容比较多，点击展开后，又没有滚动条，导致面板就乱了，我觉得面板的ui展示还要继续优化下，不止我提的找问题，你拉kimi/mimo进来一起审视下是否还有其他ui展示问题」

三路审视（大獭 + 界面獭 kimi + 交互獭 mimo）汇总去重后 9 实锤 + 3 打磨，本 PR 修 P0 七项。P1/P2 记档另行立项。

## 修复清单

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 问号气泡被弹窗边缘截断 | `HelpIcon.tsx:34` absolute+240px 居中，被 Modal `overflow-hidden` + 内容区 overflow-y-auto 双重剪裁 | 气泡走 Portal 挂 body + fixed 按钮坐标定位 + 视口 clamp（顶部放不下翻下方） |
| 2 | 桌面端弹窗无高度上限，展开后无滚动条 | `Modal.tsx:62` fullScreenOnMobile=true 时 maxHeight 双双置 undefined，而 modal-fs-content 上限只在 <639px media query | JS 侧上限恒给 80vh / calc(80vh-120px)，CSS 类只在窄屏覆盖为 100dvh |
| 3 | 展开状态跨獭串台（A 展开→B 也展开） | 条件渲染无 key，React 复用组件实例，boolean state 不随 otterId 重置 | `<OtterDetailModal key={modal.otterId}>` 强制 remount |
| 4 | 会话列表页右键菜单贴边出屏 | `conversation-list/index.tsx:75` 无钳位（会话页 index.tsx:1110 有） | 复制同款 clamp |
| 5 | 快览卡 bottom-0 锚定被 panel 顶缘剪 | `RightPanel.tsx:251` absolute right-full bottom-0 在 aside overflow-y-auto 内 | Portal + fixed 按 trigger rect 快照定位 + clamp |
| 6 | 580px 定宽弹窗 640-700px 窗口贴边 | width="580px" 无响应式 | width="min(580px, 92vw)" |
| 7 | Modal 无焦点管理 / HelpIcon 无 aria | 无 focus trap、无 role/aria-modal；气泡无 role=tooltip | 打开聚焦关闭按钮 + Tab 循环限制在 dialog 内 + 关闭归还焦点；role=dialog + aria-modal + aria-expanded/describedby |

## 明确不做（P1/P2 记档）

- P1：三栏固定宽无断点降级（`conversation/index.tsx:1296`，需左右栏折叠交互设计，独立立项）；滚动上限 5 种口径 token 化收敛；玻璃色/骨架色跨页漂移
- P2：轮询刷新快览卡微抖（useMemo 优化）
- 交付时用 gh issue 立档（见 PR 描述 Discovered Issues 节）

## 验证

- 单测 192/192 绿（含新增：HelpIcon portal/aria 4 例；快览卡 portal 断言迁移）
- tsc --noEmit 0 错
- 手工验收路径：桌面开海獭面板 → 点各 ? 看气泡完整；展开工具袋+多世摘要 → 弹窗内滚动、footer 可达；A/B 两獭切换展开态不串台；列表页右下角右键菜单不出屏；hover 最后一只獭快览卡完整

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/components/HelpIcon.tsx` | 重写 | Portal+fixed+clamp+aria |
| `web/src/components/HelpIcon.test.tsx` | 修改 | 断言迁移到 body + 新增 portal/aria 用例 |
| `web/src/components/Modal.tsx` | 修改 | 高度上限恒给 + focus trap + role/aria-modal |
| `web/src/pages/conversation/Modals.tsx` | 修改 | OtterDetailModal 加 key；width min(580px,92vw) |
| `web/src/pages/conversation/RightPanel.tsx` | 修改 | 快览卡 Portal 化 + rowRef rect 快照 |
| `web/src/pages/conversation-list/index.tsx` | 修改 | 右键菜单钳位 |
| `web/src/components/OtterProfileCard.test.tsx` | 修改 | hover 断言迁移到 body |
