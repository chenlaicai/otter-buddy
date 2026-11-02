---
id: F20261102kfvqa
title: Session 弹窗层级误用修复——glass 面板级误当弹层级
doc_type: fix

summary: |
  搭档反馈 Session 弹窗「过于透明看不清字」。根因：SessionModal 弹窗主体误用
  L1 面板级 .glass（白底随 --glass-t 系数缩放，默认 0.85 下实际不透明度仅 ~49%），
  而设计系统早为弹层定义了 L3 级 .glass-overlay（~77%/67% 实色+blur 48px saturate 220%，
  且不随 --glass-t 降透）与 .scrim 遮罩——标准 Modal 组件（web/src/components/Modal.tsx）
  用的正是这套。修复：主体 glass → glass-overlay、遮罩内联 rgba+blur(2px) → .scrim，
  与全站弹层材质对齐。

causal_links:
  from:
    - F20260913ctlv   # Session 弹窗母方案（本次修复其弹层材质）
    - F20260806ovgl   # L3 弹层磨砂玻璃三件套（本修复回归其定下的层级体系）
  supersedes: []

change_type: fix
tags: [web, ux, glass, contrast, session-panel]
modules:
  - web/src/pages/conversation/SessionModal.tsx
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
capability_test: "n/a: 纯 CSS 类名对齐（视觉对比度），行为由 SessionModal.test.tsx 既有 6 用例覆盖，无逻辑变更"
intent:
  problem: "Session 弹窗正文透明到看不清字"
  solution: "弹窗主体从 L1 .glass 升级到 L3 .glass-overlay，遮罩对齐全站 .scrim"
---

# F20261102kfvqa: Session 弹窗层级误用修复

## 问题描述

搭档 2026-11-02 反馈：「海獭的 session 弹窗过于透明了，导致我都看不清楚字了」。

## 根因分析

globals.css 的玻璃体系分四层（L0 chrome → L1 面板 → L2 气泡卡片 → L3 弹层），
层级靠透明度梯度 + 投影区分（globals.css L51-53 注释）：

| 层级 | 类 | 背景 | 默认不透明度 |
|---|---|---|---|
| L1 面板 | `.glass` | `--panel-bg`，白 58%/38% **随 `--glass-t`（默认 0.85）缩放** | ≈49%/32% |
| L3 弹层 | `.glass-overlay` | `--overlay-bg`，77%/67% **不随 glass-t 缩放**（F20260805dmux 例外条款：弹层承载正文阅读） | 77%/67% |

SessionModal.tsx:198（修复前）弹窗主体用了 `glass`——这是左栏/右栏**侧边面板**用的类
（LeftPanel.tsx:294 / RightPanel.tsx:73），透过它看背景内容只隔 ~49% 白底，正文自然糊。
遮罩也是内联的 `rgba(60,50,40,0.25) + blur(2px)`，弱于全站 `.scrim`（rgba(28,22,16,0.30) + blur 6px）。

同页面其他弹窗（Otter 详情、Restart 等）走标准 `Modal` 组件
（web/src/components/Modal.tsx:114/122），用的是 `scrim` + `glass-overlay`——所以只有
Session 弹窗犯病。F20260913ctlv 建 SessionModal 时手写了 modal 结构，没复用 Modal 组件，
材质类跟着取错了层。

## 修复方案

SessionModal.tsx 两处类名对齐设计系统：

1. 弹窗主体：`glass` → `glass-overlay`（L3 实色，不随滑杆降透）
2. 遮罩层：删内联 rgba/blur，挂 `scrim` 类（与 Modal.tsx:114 一致）

不弹窗主体不改用 Modal 组件——SessionModal 是主从双栏非标布局，换骨架是伤筋动骨的
重构，类名对齐已达目的（最小修）。

## 影响范围

仅 SessionModal 弹窗自身视觉；`.scrim` 与 `.glass-overlay` 是既有全局类，无 CSS 变更。

## Verification

- SessionModal.test.tsx 6/6 通过（worktree 内实跑）
- tsc --noEmit 通过
- bugfix 失败用例证据豁免：纯视觉透明度问题，无断言型失败测试可写（复现依赖人眼对比度感知）；修复本质是类名对齐既有全局类，行为回归由既有组件测试兜底
