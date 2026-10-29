---
id: F20261029reanc
title: 回锚阈值收紧：消灭轻拉两三行后的延迟自动跳底
summary: 用户上拉两三行（<100px）脱锚后仍处旧回锚宽带内，任何非用户位移源（回弹/锚定微调/收缩 clamp）触发 scroll 即误回锚 pinned，下一次重渲染（5s 轮询等）贴底写入 → 无新消息也跳底。收紧回锚判定至视觉贴底（<=8px）。
change_type: fix
capability_test: "web/src/pages/conversation/MessageList.test.tsx: F20261029reanc 两条用例（负例锁缺陷通道 + 正例保合法回锚）"
created_in_conversation: 9ae84389-031a-4da1-be13-0238bcdf6a29
causal_links:
  - F20261008scpg
  - F20261016inbs
  - F20261020wcsr
  - F20261027nmbf
tags: [conversation, scroll, pin, reanchor, bugfix]
modules: [web/src/pages/conversation/MessageList.tsx]
---

## 预注册（排查前冻结）

- 预期根因方向：轻拉后的误回锚——用户脱锚后某通道把 pin 置回 true，重渲染贴底写入表现为跳底（✅ 命中）
- 验证标准：找到一条「非用户输入 → pinRef 置 true」的代码路径，且其触发条件覆盖「距底 <100px 静置」场景
- 最强反例方向：若全部 pin 写入点都有用户输入守卫，则转向渲染层（容器高度变化/布局抖动）排查

## 背景与问题现象

10/29 15:01 搭档主诉：对话中间栏往上拉一点点（两三行高度，不到最底部），海獭无执行无发言，两三秒后中间栏自动跳到最底部。搭档指出此问题曾提出过（严查要求）。

**历史脉络**：同族主诉出现过两轮——10/9（#1367 两轮修复）与 10/16「上滚一两行就被弹回」（#1525 输入框固定边界修复，当年修的是**脱锚通道**：向上位移一律脱锚，该修复至今有效）。10/20 #1575 微信式重构退役「写入账本」时，论证「程序写入方向构造性向下、几何上不可能命中脱锚分支」——该论证只覆盖脱锚方向，未覆盖**回锚方向**；回锚分支自 F20260907sgpt 起语义未变（距底 <100px 即回锚），账本退役后其输入再无归因过滤。此外 `MessageList.test.tsx` 既有用例「floating 后 isNearBottom 的 scroll → pinned」把该缺陷行为固化为规格，两道防线（论证/测试）对此通道均失明。

## 根因

`web/src/pages/conversation/MessageList.tsx` handleScroll 回锚分支（修复前 :533-543）：

```
movedUp（向上位移 && 未收缩）→ 脱锚 floating      ← F20261016inbs，正常
else if (nearBottom 距底 <100px) → 回锚 pinned    ← 缺陷通道
```

触发链：

1. 用户上拉两三行（40~90px）→ 向上位移 → 正确脱锚 floating
2. 距底仍 <100px。此后任何**非向上位移**的 scroll 事件——触摸板松手回弹、浏览器滚动锚定微调、内容收缩 clamp 落底——命中 `else if (nearBottom)` → 误判「用户滚回底部」→ 回锚 pinned
3. pinned 态下下一次 React commit（页面可见时常驻的 5s 对话列表轮询 `useConversationListPolling`、周期刷新等）触发贴底写入 `programScroll(el, el.scrollHeight)` → 跳到底部。「两三秒」延迟 = 下一个重渲染周期。

为什么恰好「轻拉两三行」必现：两三行 ≈ 40~90px < 100px 阈值；拉远（>100px）即出宽带反而不复现——与搭档主诉「拉一点点」完全吻合。

## 修复设计

**修法决策树①（既有语义内修）**：回锚语义本义是「用户滚回底部」——真滚到底的用户，回锚后的贴底写入无视觉位移（幂等）；有视觉位移的跳底恰证明用户不在底部。原 100px 宽带把「接近底部」误当「回到底部」。

- 新增常量 `REANCHOR_AT_BOTTOM_PX = 8`：回锚判定从 `isNearBottom(el)`（默认 100px）收紧为 `isNearBottom(el, 8)`——视觉贴底才回锚
- 8px 取值：宽于 0（亚像素/边框余量，clamp 落底恰等值场景由 `<` 改 `<=` 一并兜住），窄于一行高度（约 20px+）——任何可感知的上拉都不会误回锚
- 滚动条拖到底、内容收缩 clamp 落底、pinned 保持等合法回锚路径全部保留（负阈值不变）
- 跳底按钮（:745 `pinRef.current = true` + smooth 写入）不依赖 scroll 事件回锚，不受影响
- `isNearBottom` 唯一调用点即回锚分支（全仓核 verified），100px 默认值保留给未来「近底」语义，无其他调用方受影响

**机制识别检查点**：无新增配置/状态生命周期/定时任务/信号类型/持久化/决策分支/跨模块调用——仅收紧既有分支的判定阈值 + `<`→`<=`（clamp 恰等值容差）。命中清单零项，不涉净新增机制，走①无需四问。

## 测试

- 新增负例（回归锁）：`F20261029reanc：上拉两三行脱锚后，非用户位移源不回锚`——贴底基线 → 上拉 50px 脱锚 → 零位移 scroll（模拟静置期回弹/锚定微调的 scroll 事件）断言不回锚 → 拖到距底 2px 断言回锚
- 新增正例（防误杀）：`F20261029reanc：内容收缩 clamp 落底 → 回锚保持跟随`——收紧不得杀死合法回锚
- 修订旧用例：原「滚到底回锚（V5 下半）」用距底 50px 断言回锚——该形态已被证实为缺陷通道，改为「距底 50px 不回锚 + 拖到 2px 回锚」双断言（用例先手动置 floating，与 F20261027nmbf 用例同法，避开 mount 重置 effect 的 pinned 初始化）

## 验证（失败证据链）

红链（旧代码 + 新用例，文件快照法：`git show HEAD:MessageList.tsx` 覆盖工作区后跑测试）：

```
× F20261029reanc：上拉两三行脱锚后，非用户位移源不回锚
  AssertionError: 近底宽带内非用户位移不得回锚: expected true to be false
× 滚到底回锚（V5 下半）
  AssertionError: 距底 50px 不再回锚: expected true to be false
Tests  2 failed | 30 passed
```

绿链（修复版恢复后）：

```
src/pages/conversation/MessageList.test.tsx: Tests 32 passed (32)
src/pages/conversation/ 全目录: Test Files 32 passed, Tests 318 passed
```

## 预期 vs 实际对照

预期命中：根因为非用户位移源触发误回锚，验证标准（存在无用户输入守卫的 pin 写入路径且覆盖 <100px 静置）在 handleScroll 回锚分支逐字命中。红线证据中两条失败用例的 `expected true to be false` 即缺陷行为本体。

## 影响范围与残余风险

- 行为变化：floating 用户在距底 8~100px 区间不再自动恢复跟随——需滚到视觉贴底（或点跳底按钮/发新消息）才恢复。这正是修复目标；微信/Telegram 同语义（不在底部即不抢滚动条）
- 残余风险：若用户习惯「拉一点点然后等新消息自动跟上来」，该场景现在会保持 floating（顶部出现「新消息 N 条」浮窗，点击即回底）——语义与主流 IM 一致，观察使用反馈
- 8px 为拍板值（L1）：理论上超低 DPI/巨大字体下一行可能 <8px，届时微调常量即可，改动面单点

## Modification-Class

`Modification-Class: narrow-fix`（修法决策树①：既有回锚语义内收紧阈值，无机制增删）
