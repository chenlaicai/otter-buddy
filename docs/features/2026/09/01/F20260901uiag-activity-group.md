---
id: F20260901uiag
title: '协作机制 v2·P4 前置：信号轨迹 UI 底座与活动段分组（读路径先行）'
summary: F20260901sgpx P4「turn 退役」的前置读路径工程：消息流按活动段（信号触发→静默）分组的派生视图先行上线——v1 用时间间隔+说话者转换启发式，P1 信号路由落地后升级为按投递信号切分；P4 拆 turn 写路径时 UI 零改动。信号轨迹徽章（档位/状态）依赖 P0 的 signal_level 元数据列，本期不渲染占位不造假。
change_type: feature
status: draft
capability_test: "n/a: 纯前端渲染逻辑（A 类），vitest 单测覆盖分组函数 9 用例；无 LLM 参与的行为"
tags: [signal-protocol, ui, activity-group, turn-retirement]
from: F20260901sgpx
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
---

# 协作机制 v2·P4 前置：信号轨迹 UI 底座与活动段分组

## 背景

母方案 F20260901sgpx 已通过双獭对抗审视（12/12 delta 复核）与搭档终审，按 P0→P4 灰度实施。本特性是 P4「turn 退役」的前置读路径工程：

- 母方案 R-兼容期约束：turn 表退役前需 UI 派生视图先上线（读路径切换后才拆写路径）
- 母方案 §7：`「一轮」= UI 从消息图派生的活动段分组（信号触发→静默），非数据库实体`

现状锚点：消息列表分隔线按 `turnId` 变化切分（MessageList.tsx 原 isNewTurn 逻辑），P4 拆 turn 后此视觉依据消失——必须先把分组真相源迁到消息流自身可计算的启发式上。

## 目标

- G1 活动段分组读路径先行：分组依据从「turnId 数据库实体」迁到「user 消息 + 时间间隔」纯前端派生，P4 拆 turn 时 UI 零改动
- G2 分组逻辑可测可解释：纯函数 + 切分依据显式（conversation-start / user-message / gap），测试断言切分依据而非实现细节

## 非目标

- 不做投递信号的 UI 渲染（signal_level/signal_meta 元数据列尚未落地——mimo 的 P0 在途，本 PR 先于 P0 合入时前端只是没有数据源，不做占位不造假）
- 不做 presence 徽标、URGENT 决策提示（P1/P3 落地后的增量）
- 不改后端任何代码（零后端依赖，读路径纯前端）

## 方案设计

### 活动段切分启发式（v1）

| 边界 | 规则 | 依据 |
|---|---|---|
| user 消息 | 开新段 | 与 `ensureActiveTurn`（send-message.ts:643）语义对齐：用户消息必开新 turn、链跑完 tryCloseTurn 即关，故「user 开新段」与现有 turn 视觉最接近 |
| 时间间隔 | 相邻消息 > 5 分钟开新段 | retry/scheduler/resume 产生的 otter 消息无 source 标识（MessageSource 值域仅 web/feishu/weixin，message.ts:11），无法按来源切分；长静默是「上一轮已收束」的唯一可靠信号 |
| otter/system 消息 | 跟随当前段 | 它们是活动的延续，不是活动的起点 |

P1 信号路由落地后的升级路径：`signal_level` 非空的消息即段边界（信号触发→静默的原始定义），本函数只改边界判断一行，接口不变。

### 组件与数据流

- `web/src/lib/activity-group.ts`：纯函数 `groupByActivity(messages) → ActivityGroup[]`，组 id = 首消息 id（React key），每段附切分依据（可解释性）
- `web/src/pages/conversation/MessageList.tsx`：渲染层把 `messages.map` 换成 `groupByActivity(messages).map`，原 turn 分隔线逻辑删除；`ActivityGroupBlock` 容器渲染段头（时间 + 「新一轮」短语），视觉密度与原分隔线一致

### 视觉设计

段头：时钟图标 + 时间 + 切分依据短语（首轮不显示短语，user 开新轮显示「新一轮」，gap 显示「新一轮（间隔较久）」）。分割线样式沿用原 turn 分隔（`mt-4 pt-3 border-t border-stone-200/50`）。

## 影响范围

| 文件 | 操作 |
|---|---|
| web/src/lib/activity-group.ts | 新增（纯函数 + 启发式） |
| web/src/lib/activity-group.test.ts | 新增（9 用例） |
| web/src/pages/conversation/MessageList.tsx | 修改（渲染接入 + ActivityGroupBlock） |

后端零改动。

## 设计取舍

| # | 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|---|
| 1 | 分组真相源 | 前端纯函数派生 | 保留 turnId 直到 P4 一起换 | 母方案 R-兼容期：读路径先行，P4 才不有破坏性切换；且 turnId 对乐观消息（无 seq/turnId）本来就不工作，派生分组反而全覆盖 |
| 2 | v1 启发式 | user 消息 + 5min 间隔 | 等信号落地用 signal_level 切分 | 用户今天就在用 UI；启发式误差（獭间长对话被并段）P1 后自动消失，不值得阻塞 |
| 3 | 段 id | 首消息 id | 自增/uuid | 消息 id 稳定（乐观消息升级为正式消息时 id 不变——前端已按 id 复用 DOM），组 key 天然稳定 |
| 4 | 信号轨迹徽章 | 本期不做 | 先做占位徽章等 P0 数据 | 无数据源的占位 = 造假；SignalBadge（F20260826mwrd C4）是獭间异议信号，与投递信号撞名不同物，投递信号徽章待 P0+P1 落地后另行设计避免混淆 |

## 验证

- vitest 9/9 通过（分组函数：空流/单条/跟随/用户切分/gap 阈值边界/混合场景/无效 ts 防御）
- 全量 web 测试 37 文件 320 用例通过（含 MessageList 既有测试无回归）
- `tsc --noEmit` 干净；`vite build` 成功（chunk 体积警告为存量问题）
- capability_test: n/a——纯前端确定性逻辑，无 LLM 参与行为

已过最简实现检查：分组逻辑一个纯函数 + 渲染层一个容器组件，无新依赖（复用 lucide Clock/fmtTime）。

## 与母方案迁移路径的衔接

| 母方案阶段 | 本特性的角色 |
|---|---|
| P0（信号元数据列） | 无依赖（本 PR 可先合）；落地后投递信号徽章有数据源 |
| P1（信号路由） | 落地后 `groupByActivity` 边界判断升级为 `signal_level 非空即切分`（一行改动，接口不变） |
| P4（turn 退役） | UI 读路径已不依赖 turnId——拆写路径时本文件零改动，验收「历史 UI 不劣化」 |
