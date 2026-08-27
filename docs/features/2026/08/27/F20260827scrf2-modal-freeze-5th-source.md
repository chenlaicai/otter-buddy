---
id: F20260827scrf2
title: 弹窗背景冻结第五源治理——SSE 回调直连 setState 的延迟队列收口
change_type: fix
tags: [web, ui, glass, css, react, performance]
modules: [web/src/pages/conversation/index.tsx, web/src/pages/conversation/hooks/useDeferredOps.ts, web/src/pages/conversation/hooks/useScheduledTasks.ts]
from: [F20260825scrf, F20260827rspt]
created_in_conversation: be190532-2eb0-4635-9adb-a2430d3040ef
summary: F20260825scrf 冻结三源后生产仍闪——SSE 回调里 setAllOtters/徽标计数直接 setState 绕过全部冻结 gate（多獭流式每 turn 触发，第五变化源）。8/25 验证环境未复现是因对话无小獭增量、fill-only 提前 return。治理：useDeferredOps 通用延迟队列（弹窗期入队、关窗与 batcher 同窗口 flush）收口 7 处调用点 + 定时任务轮询 enabled gate。
---

# F20260827scrf2：弹窗背景冻结第五源治理

## 背景与需求

### 问题描述

F20260825scrf（PR#456）合入并通过人工验收后，用户 8/27 反馈日常环境（3000 端口生产服务）弹窗打开 + 底下流式时**仍然闪烁**。

### 排查过程（本轮）

1. **排除版本错位**：确认 3000 端口进程 08:58 启动、dist 08:58 构建、冻结链路代码（getShouldDefer / modal-open / S-1/S-2 修复）全部在产物中——跑的确实是修复版，问题真实存在于当前版本。
2. **排除 main 回归**：PR#456 squash merge（645434d5）后 main 的 UI 改动（#511 快览卡修复实为优化、EXP 动效 500ms 一次性）均非持续变化源。
3. **系统清查全部 setState 路径**：发现 **SSE 事件回调里的 `setAllOtters` 直接 setState，绕过全部冻结 gate**——batcher defer、轮询 gate、refreshMessages 守卫都不覆盖它。

### 根因（第五变化源）

多獭协作流式场景，每个 turn 的 SSE 事件序列都会触发参与者状态更新：

| SSE 事件 | 调用点（main 83750b87） | 语义 |
|---|---|---|
| `message.start`（GET 订阅） | index.tsx:478 | fill-only upsert 发言者 |
| `message.start`（POST 发送流） | index.tsx:745 | fill-only upsert 发言者 |
| `message.aborted` | index.tsx:573 | fill-only upsert 发言者 |
| `message.complete` 附近 | index.tsx:854 | fill-only upsert 发言者 |
| SSE `onDone` | index.tsx:914 | getParticipants 全量替换（mergeOttersIfChanged） |
| `tool.result`（dissolve_otter） | refreshParticipantsAfterDissolve | getParticipants 全量替换 |
| 新消息到达 | 徽标计数 ×2 | setNewMessagesCount |
| 定时任务轮询 | useScheduledTasks 30s interval | setTasks |

每次 setAllOtters → RightPanel + 消息区 re-render → scrim 背后像素变化 → backdrop-filter 重算 → 闪烁。

**为什么 8/25 人工验收没复现**：验证环境是全新空库、单一对话、只有搭档+大獭两个参与者——`convOtters.some(o => o.id === otterId)` 恒为 true，fill-only upsert 提前 return prev，**没有 state 变化**。生产环境是多獭协作对话，每 turn 有小獭发言增量，fill-only 路径每次都真实写入。**这是"验证环境通过但生产还闪"的完整解释**——验收盲区第二课：验证环境必须复现真实使用形态（多参与者流式协作）。

## 方案设计

**思路**：与 F20260825scrf 同构——弹窗期冻结、关窗追上、零丢失。用通用延迟操作队列收口全部"自动触发的 setState"：

1. **useDeferredOps hook**（新文件）：`runOrDefer(op)`——弹窗期（isDeferred() 为真）把 setState 闭包入队不执行，`flush()` 关窗时按序重放。闭包捕获入队时刻快照（added、isAtBottom），重放语义 = 到达时刻语义。
2. **7 处调用点接 runOrDefer**：4 处 fill-only upsert（统一为 `upsertOtterIfAbsentDeferred`）+ onDone 参与者刷新 + dissolve 刷新 + 徽标计数 ×2。
3. **关窗 flush 同窗口**：`batcher.flush()` 与 `flushDeferredOps()` 在同一 effect 按序执行——流式内容与参与者/徽标一次性追上。
4. **定时任务轮询 gate**：useScheduledTasks 加 `enabled` 参数（默认 true），弹窗期暂停加载与 30s 轮询。
5. **用户主动操作不冻结**：弹窗确认按钮的 setAllOtters（创建/解散小獭 1171/1180）保持直执——这些是用户在前台主动触发的期望反馈。

### 关键取舍

- **取"延迟重放"而非"跳过"**：fill-only upsert 跳过虽安全（关窗 onDone 补齐），但 onDone 全量刷新跳过会丢一次参与者收敛时机；延迟重放对两类语义都无损失。
- **取"闭包快照"语义**：徽标计数的 isAtBottom 在事件到达时刻捕获，与原实现语义一致（defer 期间用户滚动不改变该消息是否计数的判定）。
- **不冻结 30s 轮询之外的手动操作**：enabled gate 只管轮询，toggle/create 等用户操作照常（弹窗内操作自己的列表）。

## 修改文件

| 文件 | 改动 |
|------|------|
| web/src/pages/conversation/hooks/useDeferredOps.ts | 新增：通用延迟操作队列 hook |
| web/src/pages/conversation/index.tsx | 7 处 SSE/回调 setState 接 runOrDefer；关窗 flush 同窗口；useScheduledTasks 传 enabled |
| web/src/pages/conversation/hooks/useScheduledTasks.ts | 加 enabled 参数（弹窗期暂停加载与 30s 轮询） |
| web/src/pages/conversation/hooks/useDeferredOps.test.tsx | 新增 4 测试：立即执行/入队重放/闭包快照语义/幂等 flush |

## 测试覆盖

- useDeferredOps：非弹窗期立即执行、弹窗期入队 flush 按序重放、闭包捕获入队时刻状态、重复 flush 幂等。
- 全量：27 文件 221 测试全过（main 基线 217 + 新增 4），tsc 通过。

## 验收标准

- [x] 所有测试通过
- [x] TSC 通过
- [ ] **多獭对话流式期间开弹窗 30 秒无闪烁**（本轮验收必须用多参与者对话——单参与者场景上轮已证明测不出本缺陷）
- [ ] 关窗后参与者列表/徽标/定时任务状态完整追上
- [ ] CI 通过

## 影响范围

影响模块：frontend 对话页 SSE 事件处理
影响文件：4 个（3 实现 + 1 测试）
破坏性变更：无（非弹窗期行为逐字节等价；弹窗期新增延迟，关窗追上）

## 验证

- 单元测试：221 全过（新增 4）
- 类型检查：tsc 通过
- 人工验证：待搭档验收（重点：多獭协作对话 + 流式 + 弹窗 30 秒）

## 参考

- 问题来源：用户 8/27 反馈（F20260825scrf 合入后生产仍闪）
- 前轮：F20260825scrf（PR#456，冻结三源；SSE 直连 setState 路径未覆盖）
- 教训沉淀：验证环境必须复现真实使用形态（多参与者）——单参与者场景 fill-only 提前 return，测不出第五源
