---
id: F20261102kfvqa
title: Session 弹窗层级误用修复——glass 面板级误当弹层级
doc_type: fix

summary: |
  搭档反馈 Session 弹窗「过于透明看不清字」。根因：SessionModal 弹窗主体误用
  L1 面板级 .glass（白底随 --glass-t 系数缩放，默认 0.85 下实际不透明度仅 ~49%），
  而设计系统早为弹层定义了 L3 级 .glass-overlay（96%/93% 实色+blur(40px) saturate(180%)，
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
| L3 弹层 | `.glass-overlay` | `--overlay-bg`，96%/93% **不随 glass-t 缩放**（F20260805dmux 例外条款：弹层承载正文阅读） | 96%/93% |

SessionModal.tsx:198（修复前）弹窗主体用了 `glass`——这是左栏/右栏**侧边面板**用的类
（LeftPanel.tsx:294 / RightPanel.tsx:73），透过它看背景内容只隔 ~49% 白底，正文自然糊。
遮罩也是内联的 `rgba(60,50,40,0.25) + blur(2px)`，弱于全站 `.scrim`（rgba(28,22,16,0.30) + blur 6px）。

同页面其他弹窗（Otter 详情、Restart 等）走标准 `Modal` 组件
（web/src/components/Modal.tsx:114/122），用的是 `scrim` + `glass-overlay`——所以只有
Session 弹窗犯病。F20260913ctlv 建 SessionModal 时手写了 modal 结构，没复用 Modal 组件，
材质类跟着取错了层。

## 修复方案

SessionModal.tsx 类名与结构对齐设计系统：

1. 弹窗主体：`glass` → `glass-overlay`（L3 实色 96%/93%，不随滑杆降透）
2. 遮罩层：删内联 rgba/blur，挂 `scrim` 类（与 Modal.tsx 一致）
3. Portal 挂 body + `body.modal-open` 声明期（检视建议采纳，F20260909srf6 模糊语义全接入）

弹窗主体不换用 Modal 组件——SessionModal 是主从双栏非标布局，换骨架是伤筋动骨的
重构，类名/结构对齐已达目的（最小修）。

## 影响范围

SessionModal 弹窗自身视觉与弹窗期模糊语义；`.scrim`/`.glass-overlay`/`.modal-open`
均为既有全局机制，无 CSS 变更；Portal 挂 body 与 Modal.tsx 同款，多弹窗共存安全
（`body > .scrim` 查询不命中页面树内 scrim，Modal.tsx 同款摘除条件）。

## Verification

- SessionModal.test.tsx 10/10 通过（含新增弹层材质契约 4 用例，worktree 内实跑）
- scrim-flicker-6.test.ts 11/11 通过（modal-open 语义接入后不回归）
- tsc --noEmit 通过
- 检视建议原「bugfix 失败用例豁免」撤回：先例 scrim-flicker-6.test.ts 证明类名/契约
  断言可写，已补源码断言形态测试（修复前必红），豁免不再成立

## 对抗审视处置（检视獭-kfvqa，mimo-pro，2026-11-02）

严重 1（B1+B9 机械闸红）：PR body 段名不匹配 `## Rollback` / `## 证据分层声明` 正则——已重写 PR body 修复。
严重 2（B2 数值失实）：文档/PR body 引用 F20260806ovgl（status: development，未落地）的计划值 77%/67% + 48px/220%，
实际落地值为 96%/93% + blur(40px) saturate(180%)（globals.css:101-102）——已全部对齐代码实际值。
建议 1（scrim 半接入）：采纳并当场修复（Portal + modal-open 声明期，Modal.tsx 同款多弹窗安全逻辑），不留 issue。
建议 2（豁免不成立）：接受反驳成立，撤回豁免声明，补源码断言形态契约测试 4 用例（先例 scrim-flicker-6.test.ts）。
