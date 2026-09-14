---
id: F20260907rmst
title: "信号轨迹 chip 移除：删掉消息流中的「信号轨迹」胶囊及其前端专用库"
doc_type: feature
summary: >
  搭档反馈信号轨迹 chip（消息下方 ⏳排队待消化/✓已处理 胶囊）没有价值：
  「我平时也不看的，看了也没啥用」。该 UI 是 09-02 信号协议 v2 的配套投影
  （F20260902u5tr），设计意图是让投石信号的投递状态对用户可见，但实际使用中
  属于常态噪音；且它是视口上跳问题（PR #836 根因）的主要触发源之一。
  移除范围：SignalTrailChip 组件、signal-trail.ts 前端库（trailStateMeta/
  humanizeNote/isSignalMessage/TrailItem）、index.tsx 的 trailItems 状态与
  轮询刷新、MessageList/ChatView 的 trailItems 传递链。保留：/signal-trail
  端点（GateBanner 闸门数据源）、SignalBadge（獭间信号徽章，独立机制）、
  后端台账（SignalRouter/QuerySignalTrail，数据仍可查）。
change_type: feature
tags: [conversation, signal-trail, ui-cleanup, ux]
modules: [web/src/pages/conversation/, web/src/lib/]
capability_test: "n/a: 纯 UI 移除，无 prompt/协议层语义变更；web 全量 46 文件 384 用例回归通过 + tsc/eslint 干净"
created_in_conversation: d8a282d9-e0e7-4cdc-931b-96abbe68cc22
causal_links:
  from:
    - F20260902u5tr   # 信号轨迹 UI 底座——本 PR 退役其用户可见面
  references:
    - F20260907sgpt   # 同日视口上跳修复：chip 是主要触发源之一（移除后触发面进一步缩小，PR #836 的补偿机制继续兜底其余来源）
---

# F20260907rmst: 信号轨迹 chip 移除

## 需求背景

搭档 09-07 反馈（PR #836 讨论语境中）：
「这个信号轨迹是从哪里出现的，我一直对这个觉得很奇怪，我觉得可以移除这个东西，没必要呀，我平时也不看的，看了也没啥用」

## 这个 UI 是怎么来的

信号轨迹 chip 是 09-02 信号协议 v2 的配套交付（F20260902u5tr「信号轨迹 UI 底座」）：
当你点名某只獭（投石信号）时，系统在消息下方渲染一枚胶囊显示投递状态
（⏳排队待消化 → ⚡处理中 → ✓已处理 / ❌失败）。设计意图是「让用户看见信号的流向」
——信号协议 v2 的核心心智是「点名 = 信号投递」，chip 是这个机制的用户可见投影。

## 为什么移除

1. **用户裁决**：搭档明确不看、觉得没用——UI 存在的唯一理由（可见性价值）不成立
2. **常态噪音**：每条点名消息都挂一枚胶囊，信息密度高但可操作性低；正常流转
   （排队→已处理）对用户没有决策价值
3. **副作用**：它是视口上跳问题的**主要触发源**（PR #836 排查结论——trailItems
   2s 轮询异步到达后 chip 弹出改变内容高度，触发视口漂移）。移除后上跳触发面直接缩小
4. **数据无损失**：投递状态的服务端真相在 dispatch_attempts 台账（持久层），
   排查时仍可通过后端查询；/signal-trail 端点保留（GateBanner 闸门数据源）

## 移除范围

| 项 | 处置 |
|----|------|
| `web/src/pages/conversation/SignalTrailChip.tsx` | **删除**（组件本体） |
| `web/src/lib/signal-trail.ts` + `signal-trail.test.ts` | **删除**（前端专用库：trailStateMeta/humanizeNote/isSignalMessage/TrailItem；唯一消费方是 chip） |
| `index.tsx` trailItems state + refreshSignalTrail | 改为 refreshGate：只取 `resp.gate`（闸门状态），丢弃 `resp.items` |
| MessageList/ChatView 的 trailItems 传递链（props + trailByMessage + MessageItem trail 参数） | 删除 |
| GateBanner.test.tsx 后两个 describe | 随库退役删除，保留 gateBannerMeta/GateBanner 渲染用例 |

### 保留项（明确不动）

| 项 | 理由 |
|----|------|
| `/signal-trail` API 端点 + `api.getSignalTrail` | GateBanner 的 gate 字段数据源（停机/限流横幅），一个端点两个字段，items 字段前端不再消费 |
| `SignalBadge.tsx`（獭间信号徽章 ⚡/🚧/🛑） | 独立机制（F20260826mwrd C4：<signal> 块的视觉表达），与轨迹 chip 无代码依赖；09-03 已拍板弱化过，保留现状 |
| 后端 SignalRouter / QuerySignalTrail / dispatch_attempts 台账 | 服务端真相源，排查与审计仍需；前端投影退役 ≠ 数据层退役 |

## 验证

- `npx vitest run`（web 全量）：46 文件 384 用例全绿（MessageList 16 例含 PR #836 补偿用例均过）
- `npx tsc --noEmit`：通过
- `npx eslint src/pages/conversation/ src/lib/`：无新增 warning（index.tsx 既有 3 条 exhaustive-deps warning 经 stash 基线对照为 pre-existing）
- 引用清零检查：`grep -rn "signal-trail\|SignalTrailChip\|trailItems\|TrailItem" web/src` 仅剩 api client（gate 数据源）、GateBanner 注释、测试文件退役说明——无代码引用残留
- 最简实现检查：已过——纯删除 PR，无新增代码（refreshGate 是 refreshSignalTrail 的收缩版）
- 人工验收（合并后）：消息流中不再出现「⏳ 排队待消化 · 信号轨迹 N」胶囊；獭间信号徽章（⚡/🚧）与停机横幅正常

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 移除粒度 | 前端 UI + 专用库全删 | A：只隐藏（加开关） | 开关是永久维护负担；用户明确不要 |
| API 端点 | 保留 | 删端点+后端 query | gate 字段仍需；后端排查数据源不动（变更面最小） |
| SignalBadge | 保留 | 一并删 | 独立机制（objection/blocked/halt 的用户可见面），搭档 09-03 拍板「弱化」而非删除——本 PR 不扩大范围 |
| 上跳修复兜底 | PR #836 照常合入 | 随 chip 删除撤回 #836 | 徽标/GateBanner/流式折叠仍会改变高度，#836 的 ResizeObserver 补偿继续兜底这一类 |
