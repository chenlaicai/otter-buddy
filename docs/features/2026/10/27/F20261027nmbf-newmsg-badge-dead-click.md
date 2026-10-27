---
id: F20261027nmbf
title: "「新消息 N 条」浮窗计数僵死与点击不可达修复"
summary: "两个叠加 bug：①输入覆盖层（F20261015inpd absolute bottom-0 z-10）叠在浮窗（bottom-4 z-10）上方，同 z 值 DOM 序后来居上，透明区域吞掉命中测试——按钮点不到（#1535 同族）；②浮窗计数清零仅「点浮窗/发言」两路，均要求按钮可点，按钮被遮后计数僵死——左栏未读红点已被聚焦 ack（F20260921urdo）消掉，浮窗仍挂「新消息1条」。修法：浮窗 bottom 抬到覆盖层上方（bottomSpacerPx+16 联动）+ z-20；handleScroll 回锚分支补 floating→pinned 转换清零回调 onPinnedToBottom。"
change_type: fix
capability_test: "n/a: 纯前端滚动/布局修复，无 prompt/LLM 行为改动"
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
created_at: 2026-10-27T15:30:00+08:00
causal_links:
  from: [F20261015inpd, F20261016inbs, F20261008scpg, F20260921urdo]
tags: [web, conversation, scroll, unread-count, overlay, z-index, hit-test]
modules: [web/src/pages/conversation/MessageList.tsx, web/src/pages/conversation/ChatView.tsx, web/src/pages/conversation/index.tsx]
---

# 「新消息 N 条」浮窗计数僵死与点击不可达修复

## 预注册（动手前冻结）

- 预期根因方向：浮窗计数清零路径断裂 + 按钮被输入覆盖层遮挡（几何/层叠问题，非数据问题——左栏红点正常消散证明服务端已读链路健康）
- 验证标准：代码中找到「计数只增不清的具体路径缺口」与「覆盖层与浮窗的 z/bottom 几何冲突」双证据
- 反例方向：若浮窗计数源自服务端未读数（与红点同源），则应查数据链路而非前端 UI——实际排除：`newMessagesCount` 是 index.tsx:74 纯前端本地 state

**预期命中**：双假设均成立（见下），未反转。

## 问题现象

搭档报告（2026-10-27，附截图两箭头）：左侧栏对话已无未读红点，但中间栏底部仍挂「新消息 1 条」浮窗，且点击无反应。

## 根因分析（双 bug 叠加）

### Bug 1：按钮被输入覆盖层遮挡——点击不可达

- `ChatView.tsx` 输入覆盖层：`absolute bottom-0 left-0 right-0 z-10`（F20261015inpd，2026-10-15 起）
- `MessageList.tsx` 浮窗：`absolute bottom-4 left-1/2 -translate-x-1/2 z-10`（历史位置，覆盖层落地时未同步迁移）
- 两者同 z-10，DOM 序覆盖层在后 → 层叠后来居上。浮窗 bottom-4（16px）恰落在覆盖层（输入框实高 ≥72px）内部 → 命中测试被覆盖层吞掉，点击不可达
- 这是 #1535（卡片预览按钮被覆盖层吞点击）同族问题：覆盖层透明区域照吃命中测试

### Bug 2：计数清零路径全断——僵死

`newMessagesCount`（index.tsx:74，纯前端本地 state）的清零入口仅两个：

| 入口 | 位置 | 前提 |
|---|---|---|
| 点浮窗 | index.tsx handleJumpToBottom（经 MessageList 按钮 onClick） | 按钮可点 ← Bug 1 断 |
| 用户发言 | index.tsx handleSend 内 setNewMessagesCount(0) | 用户主动发言 |

而左栏未读红点是**服务端**权威计数，F20260921urdo「聚焦即已读」会在窗口聚焦时自动 ack——红点正常消散、浮窗本地计数无人清——两者状态分裂，浮窗挂到刷新/发言才消失。

流式新消息（entry.stream.delta 增量）不触发计数（只有完整 entry.user/entry.speak/entry.complete 计数），故僵死值一般是小数目（如「1 条」）。

## 修复方案（修法决策树①：既有语义内修）

两处均为既有机制内补缺，无新增机制（机制识别检查点全未命中：无新配置/状态生命周期/定时任务/信号类型/持久化/决策分支/跨模块调用——onPinnedToBottom 是组件回调 prop，沿用 onJumpToBottom 同型签名）。

**修 A（几何）**：浮窗 bottom 从写死 `bottom-4` 改为 `style={{ bottom: bottomSpacerPx + 16 }}`——与底部衬垫（输入覆盖层实高，ChatView ResizeObserver 实测透传）联动，浮窗恒悬于覆盖层上方 16px；z-10 → z-20 脱离同层竞争。覆盖层长高（卡片预览展开、输入多行）时浮窗随之上移，恒在可点区。

**修 B（清零）**：handleScroll 回锚分支（nearBottom）补 floating→pinned 转换检测——转换且计数>0 时调 `onPinnedToBottom?.()`，index.tsx 侧清零。语义：滚回底部=新消息已在眼前，等同已读（与 F20260921urdo 聚焦 ack 同哲学）。边缘触发（仅转换沿），pinned 保持的重复 scroll 不打。

## 验证（失败证据链）

**修复前红**（git stash 源文件后跑，2 失败 / 28 通过）：

```
× F20261027nmbf 几何：浮窗 bottom = 衬垫高+16，抬升到输入覆盖层上方（修复前 bottom 僵 16px 被覆盖） 13ms
× F20261027nmbf 回锚清零：floating 滚回底部（nearBottom）→ 触发 onPinnedToBottom 清零回调 8ms
```

**修复后绿**（30/30 通过）：

```
✓ F20261027nmbf 几何：bottom=112px（96+16）断言 + z-20 断言
✓ F20261027nmbf 回锚清零：floating→pinned 触发 1 次，pinned 保持不重复
✓ F20261027nmbf 无计数不打：计数 0 时回调不触发
```

全量回归：web 测试 785/785 通过（77 文件），tsc --noEmit 零错误。

**测试形态备注**：mount 时「切换会话重置状态」effect 置 pinRef=true，回锚用例需在 instrumentRW 后手动置 floating 再 fireScroll（调试过程实证：未置 floating 时第一批 scroll 是 pinned 保持沿，回调合法不打——这本身验证了边缘触发语义）。

## 影响范围

- 浮窗几何：仅在 bottomSpacerPx>0（输入覆盖层存在）时视觉位置变化；旧布局无覆盖层时 bottom=16px 与原 bottom-4 等价
- 回锚清零：用户滚回底部即清计数——语义增强，无破坏性（计数本就该在「已看到」时清）
- 不影响：服务端已读游标、左栏红点、scroll-pin 状态机其余转换（floating 保持、脱锚路径零改动）

## 预期 vs 实际对照

预期命中：根因双假设（遮挡 + 清零路径断）均在代码中实证，修复后搭档报告的两个症状（点不到、僵死挂条）分别被修 A/修 B 对应消除。
