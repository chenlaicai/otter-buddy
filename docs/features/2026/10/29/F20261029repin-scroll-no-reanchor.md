---
id: F20261029repin
title: "移除「到底即回锚」机制——自动回底只由新消息触发（滚动跳底问题族根源清除）"
summary: "scroll 事件不再置 pin：回锚只剩两条路径——①尾部 append 且用户视觉贴底（追加前距底 ≤8px）②显式动作（跳底按钮/发言）。距底判定用追加前几何快照 distToBottomRef，会话归属守卫排除挂载水合/切会话误触发。"
change_type: fix
capability_test: "n/a: 滚动状态机行为由 vitest 红绿链锁定（4 用例旧实现必红），无 prompt/LLM 行为改动"
created_in_conversation: 9ae84389-031a-4da1-be13-0238bcdf6a29
created_at: 2026-10-29T18:55:00+08:00
causal_links:
  from: [F20261008scpg, F20261020wcsr, F20261027nmbf, F20261029reanc]
---

# 预注册

- 预期：floating 用户拖到底部后，任何 scroll 事件不改变 pin 状态（旧行为：100px 近底带内即回锚置 pin）；新消息 append 且追加前距底 ≤8px → 恢复跟随 + 贴底 + 清浮窗计数；>8px → 保持 floating、零滚动条写入、浮窗计数由父层 +1。
- 修复面：MessageList scroll-pin 状态机的**回锚触发面**（「到底即回锚」机制整体移除 + 「新消息恢复跟随」通路新建）。
- 反例：若 scroll 事件仍能置 pin（含任何阈值收紧形态），即为被否路径复活。
- 非目标：不动脱锚通路（wheel/touch/键盘上翻/向上位移）；不动哨兵分页/贴底补偿/prepend 兜底；不动父层计数逻辑（index.tsx `!pinRef.current` +1 条件不变）。

# 问题与根因

- 现象：用户轻拉两三行阅读后页面自动跳回底部（滚动跳底问题族，三轮修复不死：#1244 → #1700 两轮检视）。锚点：scroll-design-review.md（归因报告，本对话工作区）+ msg 0a2eabe7（搭档 29/10 17:08 裁决）。
- 根因（两层，归因报告结论）：
  - **设计层（根源）**：「宽松回锚=善意」假设错——「到底」被定义为距底 100px 近底宽带，用位置推断意图，违背设计自定的「意图驱动」原则（F20261008scpg 契约预见过该 clamp 回锚路径，当年以「方向善意」放行）；
  - **实现层（引爆）**：F20261020wcsr 账本退役论证只覆盖脱锚方向（程序写入构造性向下），回锚方向的归因保护随之消失，100px 宽带裸奔——触摸板回弹/浏览器 clamp 微调等非用户位移直达回锚判定 → 恢复跟随 → 下个刷新周期跳底。
- 流程教训：测试把缺陷行为固化成「规格」（旧用例断言「滚回底部→回锚」），设计契约没变成强制护栏，每轮修复只看当轮症状路径。

# 方案与取舍

- 语义（搭档 10/29 裁决，msg 0a2eabe7「不要有这个机制啊！自动回底只有在新消息出现时才触发呀，你应该把这个设计根源移除掉！」）：
  1. 用户上拉/上翻 → 页面绝对不碰滚动条（含拖到底、回弹；**scroll 事件永不置 pin**）
  2. 新消息出现时：视觉贴底（≤8px）→ 恢复跟随贴底 + 清计数；否则浮窗计数 +1，想回去点浮窗
  3. 跳底按钮 / 发言：显式动作照旧
- 实现：
  - **删**：handleScroll「到底即回锚」分支、`lastPinAtRestRef`、`isNearBottom` 100px 宽带 helper——scroll handler 只剩两件事（向上位移脱锚归因、向下位移解除连拉冷却）；
  - **增 re-pin effect**（useLayoutEffect，无 deps）：尾部 append 判定（`lastTailIdRef`）+ **会话归属守卫**（`lastTailConvRef`：挂载水合/切会话换消息集只采样不触发——初始加载≠新消息出现；同时消灭 layout effect 先于 passive「切换会话重置」effect 的 pinRef 竞态）+ 追加前距底判定（`distToBottomRef` ≤ `NEWMSG_REPIN_PX`=8）→ `pinRef=true` + `programScroll` 贴底 + `onPinnedToBottom` 清计数；
  - **增 `distToBottomRef`（追加前几何快照）**，三处刷新：handleScroll / contentObserver / re-pin effect 末尾。关键坑：useLayoutEffect 运行时新消息**已入 DOM**（React 先变异后跑 layout effect，与 paint 无关），实时距底=追加前距离+消息高——直接测会把贴底用户误判离底漏恢复跟随（主场景：上拉阅读后滑回底部停住，新消息到达），必须读追加前快照。
- 取舍：8px 阈值=视觉贴底的亚像素余量，**不是旧 100px 宽带复活**——判定时刻只有 append 一处，触发源是搭档钦定的「新消息出现」而非位置推断意图；回锚后在本 effect 内同步贴底（commit effect 同 commit 内先跑且早退，不能等它补；RO 链 rAF 双写幂等无害）。
- 已否决路径：#1700 8px 收紧（仍是「scroll 置 pin」，被判打补丁，作废关闭）；复活账本归因机制（成本重）；在 #1700 上叠改（混入被否中间态）。

# 验证

- **红绿链（机器证据）**：旧实现（origin/main `d9aacf88` 的 MessageList.tsx）替换回工作面跑 `vitest run MessageList.test.tsx` = **4 红 28 绿**（红的恰为 F20261029repin 四用例：到底不回锚 / 新消息回锚（8px 边界）/ 回锚清零幂等 / 新消息不抢滚动条（9px 边界））；换回新实现 = 32/32 绿。全量 `vitest run` = **815/815 绿**（81 文件）；`tsc --noEmit` 干净。
- **判别力教训（入档）**：B/B2 首版在旧实现上误绿——旧代码在 fireScroll（距底 8px，在旧 100px 带内）时刻已完成回锚+清零，终态与「append 触发」恰好相同；补「scroll 时刻仍 floating、零清零」中间断言锁定**触发归属**后才红。红锚要断言触发源，不能只断言终态。
- **存量测试迁移**（语义迁移非破坏）：V9「键盘脱锚」的「回锚后测输入框保护」前置从「滚回底部即回锚」改为显式置 pin（保留「scroll 不改 pin」回归断言）；spa-nav「A 上翻后收新发言」补几何模拟（jsdom 无布局，零几何会被距底判定当成「贴底」误恢复跟随——新语义按视觉位置判，几何必须忠实；新语义下 scroll 永不置 pin，几何桩不再污染 floating 状态）。

# 独立审视处置

（PR 对抗审视后回填）

# 影响与负向验收

- 影响面：`MessageList.tsx`（scroll-pin 状态机）、`MessageList.test.tsx`、`index.spa-nav.test.tsx`（几何模拟）、`index.tsx`（一处注释同步）。父层计数 +1 条件不变。
- 负向验收：①用户上翻后拖到底部停留——新消息到达前页面零滚动条写入、pin 保持 floating；②floating 离底收到 N 条消息——计数累加、视口零跳动；③切会话/首屏加载——不触发清计数、不触发贴底写入（水合守卫）。
- 已知边界（如实标注）：异步内容撑高（图片/iframe 加载）与 append 同帧竞争时，追加前快照可能略偏旧，方向偏「恢复跟随」（用户此前确在底部），由 contentObserver 刷新点收窄；jsdom 测试环境需忠实模拟滚动几何（spa-nav 用例已示范）。
