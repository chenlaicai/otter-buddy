---
id: F20260916rcxa
title: 右栏休息中恒显示上下文使用量
summary: 右侧栏海獭卡片在休息中（含无 invoke 记录但有世）恒显示「○ 休息中 · ctx/上限」；invoke.start 新行动启动时保留上轮终态的 ctx 值，行动间隙数据不断档。ctx 语义即「当前 session 的上下文占用」——休息中占用不变，属准确数据展示。
change_type: feature-update
tags: [web-ui, right-panel, invoke-status, context-usage]
modules: [web/src/lib/invoke-tracker.ts, web/src/lib/invoke-tracker.test.ts, web/src/pages/conversation/RightPanel.tsx]
from: [F20260914rtsp]
supersedes: []
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
---

# 右栏休息中恒显示上下文使用量

## 背景（意图锚）

搭档原话（2026-09-16）：「右侧栏海獭休息中时，会不显示上下文使用量，但我期望即使休息中，上下文使用量也要显示出来，因为这数据就是表示海獭当前 session 的情况、是准确的数据展示效果」。

排查证实缺口存在（RightPanel.tsx:420）：状态行渲染条件是 `{invokeState && (...)}`——**invokeState 为 undefined 时整行不渲染**。以下场景休息中无数据显示：

1. 獭从未在本会话行动过（新建小獭，listInvokes 无记录）
2. 刷新后该獭最新 invoke 落在 listInvokes 返回窗口之外（limit=50 之外的旧记录）
3. invoke 状态被其他事件路径重置后无记录

## 方案设计

### D1. 渲染条件放宽：`invokeState || activeS`

`RightPanel.tsx`：状态行渲染条件从 `{invokeState && (...)}` 改为 `{(invokeState || activeS) && (...)}`——无 invoke 记录但该獭已握过（有 active session）时也渲染休息中行，ctx 取 `invokeState?.ctxWindowUsed`（undefined → fmtCtx 显 '—'）。

- 从未握过（无 active session）的獭仍不显示该行——没有 session 就谈不上「当前 session 上下文占用」，显示 '—' 反而是噪音
- 休息中分支字段全部改可选链（`invokeState?.ctxWindowUsed`），running 分支无需改（running 必有 invokeState）

### D2. applyInvokeStart 保留上轮 ctx（行动间隙不断档）

`invoke-tracker.ts`：`applyInvokeStart` 新建 running 状态时，从 prev（上轮终态）继承 `ctxWindowUsed`/`ctxMax`。

**Why**：同獭连续两轮 invoke 之间，start 事件会整体替换状态对象——旧实现下 ctx 瞬间掉回 undefined，右栏在新 invoke 首条 LLM 往返（invoke.tick 发射）前显示 '—/上限'，数据断档。而真实语义上：新 invoke 刚启动、尚未向 LLM 发消息前，session 上下文占用**仍等于上轮末态**（上下文只增不减，compaction 是 session 内事件，发生后下一轮 tick 会如实拉低数值）。保留上轮值是准确展示，不是近似。

- 幂等判断不受影响（幂等路径 prev.invokeId === next.invokeId 是重放场景，prev 本身就是 running 态，ctx 一致）
- 无上轮数据（首次行动/刷新恢复）时 prev.ctxWindowUsed 为 undefined，不注入字段，显 '—' 兜底（AT-11 行为不变）

### D3. 数据源不变，无后端改动

ctx 数据源仍是既有链路：运行中 invoke.tick（message_end usage）→ 终态保留 → 刷新后 listInvokes 的 `ctx_window_used` 列恢复。本特性只动展示条件与状态继承，不新增 API/字段。

## 影响范围

| 模块 | 变化 |
|---|---|
| web/src/pages/conversation/RightPanel.tsx | 状态行渲染条件放宽 + 休息中分支可选链 |
| web/src/lib/invoke-tracker.ts | applyInvokeStart 继承上轮 ctx（+注释） |
| web/src/lib/invoke-tracker.test.ts | 新增用例：start 覆盖后仍携带上轮 ctx |

## 取舍

- **选了**：无 invoke 记录但有世 → 显示「○ 休息中 · —/—」而非隐藏整行。**代价**：从未行动的新獭也会多一行 '—'。**理由**：搭档明确表态「这是准确的数据展示」——行在、数据缺失显 '—' 比整行消失更符合「休息中也展示」的诉求；且 '—' 准确传达了「尚无数据」
- **没选**：把 ctxMax 也做独立兜底（如默认 128k 常显上限）。ctxMax 只随 tick 携带，没有真实数据时不编造
- **没选**：后端改 listInvokes 默认 limit 或按獭聚合。50 条窗口覆盖不到的极端场景由 D1 的 '—' 兜底承接，不为此放大查询

## 验证

- [x] `invoke-tracker.test.ts` 17 用例全过（新增 1：start 覆盖后仍携带上轮 ctxWindowUsed/ctxMax）
- [x] `src/pages/conversation` 全部测试通过（18 文件 186 用例，RightPanel 相关渲染测试无回归）
- [x] `tsc --noEmit` 与 main 基线一致（无新增类型错误）
- [ ] 手动验收：刷新页面后休息中的獭显示「○ 休息中 · xx/xx」；新建未行动小獭显示「○ 休息中 · —/—」；行动中数字实时不变断档
