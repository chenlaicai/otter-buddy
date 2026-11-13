---
id: F20261113fotcr
title: 浮动獭 click/drag 分离改读 ref，修 Esc 收起后点击偶发不展开
doc_type: feature
change_type: fix
summary: "浮动獭 Esc 收起后点击獭本体偶发不重新展开（#1181/#1858，全量 e2e 顺序跑 ~2/3 概率红、单跑稳定绿）。根因：click 判定读 React dragging state——pointerup 里 setDragging(false) 在 click 触发时未必已重渲染，click 读到陈旧 true 被抑制。修法：拖动判定改用 ref 同步维护（pointerdown 重置 false，move 越 6px 阈值置 true），FloatingOtter 的 onClick 直接读 dragMovedRef.current，不再依赖 state 异步刷新。"
intent:
  problem: "#1181（2026-09-28 发现）与 #1858（2026-11-11 复现登记）同一 flaky：Esc 收起 → 点獭 → assistant-panel 5s 不可见。排查证实为 click 与 drag 分离依赖 dragging state 的异步更新闭包时序，非确定性产品 bug。"
  why_now: "搭档指示按时间从古到今逐个处理 open issue，#1181（第 3 件）与 #1858（第 11 件）同源，一并修复可同时关双单。"
  expected_effect: "Esc 收起后点击獭本体稳定重新展开；拖动（>6px）仍抑制点击不误触发；e2e floating-assistant.spec 全量顺序跑不再因该竞态红。"
  verify_by:
    type: capability_test
    note: "新增 2 条组件级单测（dragMovedRef 在拖动/点击两路径下的取值），修复前代码无 dragMovedRef 字段即红；e2e 全量跑行为由 CI 覆盖。"
capability_test: "web/src/components/FloatingAssistant/floating-assistant.test.ts 新增 click/drag 分离 describe（2 条）"
created_at: 2026-11-13
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [web, floating-assistant, flaky, e2e, race]
modules:
  - web/src/components/FloatingAssistant/use-floating-otter.ts
  - web/src/components/FloatingAssistant/FloatingOtter.tsx
  - web/src/components/FloatingAssistant/FloatingAssistant.tsx
  - web/src/components/FloatingAssistant/floating-assistant.test.ts
causal_links:
  - F20260924wast
  - F20260928waf1
---

# F20261113focr: 浮动獭 click/drag 分离改读 ref

## 问题

#1181 / #1858 同一 flaky：`web/e2e/floating-assistant.spec.ts`「Esc 收起 / ⌘J 唤起」用例全量顺序跑偶发红（约 2/3 概率），单跑稳定绿。失败点在最后一步「獭点击兜底再展开」：Esc 收起 → 点獭 → assistant-panel 5s 不可见。

排查（F20260928waf1 期间 git stash 对照）确认：修复前代码全量跑同样红，属存量竞态，非新 PR 引入。

## 根因

`FloatingOtter.tsx` 的 click handler 读 React `dragging` state：

```ts
onClick={() => { if (!dragging) onToggle() }}
```

时序竞态：pointerdown 里 `setDragging(true)`；pointerup 的 `onUp` 里 `setDragging(false)`。浏览器在 pointerup 之后同步派发 click，而 React 对 discrete event 的状态刷新未必赶在 click handler 执行前完成——click 读到陈旧 `dragging=true` 被抑制，`onToggle` 不触发，面板不展开。拖动侧 `dragStateRef` 虽已有 `moved` 标志，但 onUp 把 ref 置 null，click 时已拿不到。

## 修复

`use-floating-otter.ts` 新增 `dragMovedRef`（`useRef(false)`），与 React state 脱钩、同步维护：

- `onPointerDown`：`dragMovedRef.current = false`（新交互默认为点击）。
- `onMove` 越 6px 阈值：`dragMovedRef.current = true`（确认为拖动）。
- `onUp`：不动该 ref（click 在 up 之后读它）。

`FloatingOtter` 的 click handler 改读 `dragMovedRef.current`；`dragging` state 保留，仅驱动视觉态（cursor-grabbing / scale）。

## 验证

- 新增 2 条组件级单测（`floating-assistant.test.ts` 新 describe）：拖动路径 `dragMovedRef=true`、点击路径 `dragMovedRef=false`——修复前无 `dragMovedRef` 字段，测试即红（失败固化）。
- `web` tsc --noEmit 零错误；单测 13/13 通过。
- e2e 行为由 CI floating-assistant.spec 覆盖。