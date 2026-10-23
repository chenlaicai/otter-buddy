---
id: F20261023pmnu
title: 对话列表右键菜单 Portal 化统一（issue #1006）
summary: conversation-list/index.tsx 的对话右键菜单（蒙层+菜单本体）改 createPortal 挂 document.body，与 WorkspacePanel/Modal 统一 Portal 模式，消除根容器未来引入 transform/backdrop-filter 时 fixed 菜单退化为相对容器定位（containing block）的防御性风险。
change_type: refactor
capability_test: "web/src/pages/conversation-list/index.test.tsx 新建 2 用例（Portal 挂载点：document 查到+container 查不到；Portal 后点击置顶调 PATCH pin API 并收起）+ web 全量 75 文件 759 用例绿。牙齿自证：stash 掉 Portal 改动后 2 用例全红（旧实现下 container 内可查到菜单，断言必挂）。回归口径：cd web && npx vitest run src/pages/conversation-list/index.test.tsx"
intent:
  problem: "issue #1006（PR #1005 检视发现 1，F20260916cmpt delta）：左栏对话列表右键菜单（conversation-list/index.tsx:268）以 fixed 定位直接渲染在组件树内——当前根容器无 transform/backdrop-filter 所以不受影响，但结构与右栏 WorkspacePanel 修复前（F20260916scfx 实测菜单飞出视口）完全相同：一旦未来根容器层级引入 transform/backdrop-filter（如整页过渡动画），会成为 containing block，后代 fixed 元素退化为相对容器定位，菜单按「右键坐标 + 容器偏移」飞出视口。"
  expected_effect: "对话列表右键菜单挂 document.body，脱离根容器 containing block 风险域；与 WorkspacePanel ctxMenu、Modal、RightPanel hover 卡统一 Portal 模式；未来容器样式变更不再触发菜单定位退化。"
  verify_by:
    type: capability_test
    detail: "web/src/pages/conversation-list/index.test.tsx 新建 2 用例 + web 全量 759 用例绿；tsc --noEmit 零错误；eslint 零错误；牙齿自证（旧实现下红）防假绿。CI 由 PR checks 验证"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [web, tech-debt, portal, containing-block, defensive]
modules: [web]
---

# 对话列表右键菜单 Portal 化统一（issue #1006）

## 1. 来源

issue #1006（P2 tech-debt，PR #1005 检视发现 1，出处对话 acf4e2d3；清账批次关闭标准：index.tsx 菜单 createPortal 挂 document.body 合入——关闭标准即合入本身）。

## 2. 问题现象

对话列表页右键菜单（蒙层 + 玻璃卡片菜单本体）以 `fixed` 定位直接渲染在组件树内（conversation-list/index.tsx:268-271）：

```tsx
{ctxMenu && activeConvForMenu && activeConvForMenu.status !== 'archived' && (
  <>
    <div className="fixed inset-0 z-40" onClick={closeCtxMenu} />
    <div className="fixed glass-overlay ..." style={{ left: ctxMenu.x, top: ctxMenu.y }}>
```

**当前无实际 bug**（根容器无 transform/backdrop-filter，fixed 相对视口定位正确）——但结构与右栏 WorkspacePanel 修复前完全相同（F20260916scfx 实测：aside.glass 的 backdrop-filter 成为 containing block，右键 x=1605 时菜单 left=3130 飞出视口）。一旦未来根容器引入 transform/backdrop-filter（整页过渡动画等），本菜单同款退化。

## 3. 根因（风险成因）

CSS 规范：transform/backdrop-filter 等属性使元素成为 fixed 后代的 containing block。fixed 元素脱离视口定位、改为相对该容器定位——菜单按「右键坐标 + 容器偏移」渲染，飞出视口。此前右栏 WorkspacePanel 已实测踩坑并以 Portal 修复（WorkspacePanel.tsx:502），本菜单是同构残留。

## 4. 方案设计

### 4.1 机制判定

未命中机制识别清单——纯防御性结构统一（Portal 化），复用既有 Portal 模式（Modal/WorkspacePanel ctxMenu 同款），零新机制引入。一行留痕：**未命中机制清单，零新机制引入。**

### 4.2 变更要点

1. **conversation-list/index.tsx**：ctxMenu 块（蒙层 + 菜单本体）包 `createPortal(..., document.body)`，加 `data-testid="convlist-ctx-menu"` 与 Why-Portal 注释（与 WorkspacePanel ctxMenu 同因）。
2. **conversation-list/index.test.tsx**（新建）：2 用例——
   - Portal 挂载点有牙断言：`document.querySelector` 查到菜单 + `container.querySelector` 查不到（防退回组件树内 fixed 渲染）；
   - Portal 后交互不回退：点击「置顶」项调 `PATCH /conversations/:id/pin` 并收起菜单。

### 4.3 设计取舍

- **只动挂载点、不动菜单逻辑**：视口钳位（F20260826pfix）、归档不弹菜单（F20260922cgrp）等既有行为零变化，回归面最小。
- **测试断言挂载点而非样式**：containing block 退化在 jsdom 不可测（无真实布局引擎），断言「挂 body 不在容器内」是该风险的最强代理断言。

## 5. 影响范围

- 仅对话列表页右键菜单的挂载位置；交互（置顶/取消置顶、蒙层关闭、视口钳位）不变。
- 无 API/数据结构/协议变更。

## 6. 验证

- `web/src/pages/conversation-list/index.test.tsx` 新建 2 用例绿。
- **牙齿自证**：stash Portal 改动（模拟旧实现）后 2 用例全红——用例有牙，防假绿。
- web 全量 75 文件 759 用例绿；`tsc --noEmit` 零错误；`eslint` 零错误。
