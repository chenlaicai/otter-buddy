---
id: F20261101tcdlc
title: toolCallCount 兜底死链收口 + getToolCallCount 全链退役（#1116）
change_type: fix
status: implemented
created: 2026-11-01
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/ports/sdk-invoke-port.ts
  - src/frameworks/agent/pi-session-factory.ts
summary: "#1116（#763 修复残留）：orchestrator err 路径 `errMeta._toolCallCount ?? driver.getToolCallCount(...)` 两半缺陷——①#763 后 factory catch 恒写 number 快照，?? 右半对经 factory 的错误永不触发（死链）；②错误亦可从 _acquirePooled 阶段抛出（attachGuards 之前），旧兜底 Map 重查落裸 otterId 键，读到同 otter 其他活跃 invoke 的计数（跨 invoke 污染，比 0 更糟）。修复语义：无快照 ⟺ 抛错在工具运行之前 ⟺ 本 invoke 计数必为 0 → `?? 0` 即真实值，getToolCallCount 五处生产代码 + 16 处测试 mock 全链退役。"
tags: [agent, orchestrator, dead-code, tool-call-count]
capability_test: "n/a: 纯 A 类代码逻辑（错误路径计数语义），无 LLM 行为变更"
from:
  - F20260922tcrc
created_at: 2026-11-01

intent:
  problem: "toolCallCount Map 兜底链存在重查竞态与 orchestrator 死链（#1116），修复残留未清"
  expected_effect: "getToolCallCount 全链退役后相关竞态面归零：死链代码删除、调用点清空、相关测试基线不再触达"
  verify_by:
    type: behavior_check
---

# toolCallCount 兜底死链收口 + getToolCallCount 全链退役（#1116）

## 问题

#763（F20260922tcrc）修复了 factory catch 的 Map 重查竞态，但留下两处同族残留（PR #1113 审视建议 A2，issue #1116）：

**缺陷 1（死链）**：`orchestrator.ts:91` `toolCallCount = errMeta._toolCallCount ?? driver.getToolCallCount(otterId, invokeId)`——#763 后 factory catch 恒写 `number` 类型 `_toolCallCount`（`activeEntry?.toolCallCount ?? Map重查 ?? 0`），`??` 右半对经 factory 的错误**永不触发**。「快照 + 兜底」双防线实为单防线，兜底是假装存在的防线。

**缺陷 2（污染面）**：错误亦可从 factory catch **之外**抛出——`_acquirePooled` 阶段（嵌套 invoke 撞 streaming 抛错 / `Otter config not found` / lock 超时抛错）。这类错误不带 `_toolCallCount`，兜底触发后走 `getToolCallCount` 的 Map 重查：先查 `${otterId}:${messageId}` 键（必 miss——条目在 attachGuards 时才注册），再退查**裸 `otterId` 键**——嵌套场景恰是外层 invoke 活跃条目在场场景，会读到**别的 invoke** 的计数。跨 invoke 污染，比 0 更糟。

## 修复

**语义拍板**（一行核心判断）：`无 _toolCallCount 快照 ⟺ 抛错点在 attachGuards/工具运行之前 ⟺ 本 invoke 零次工具调用 ⟺ 0 就是真实值`。无需区分「快照 0」与「无快照」——两者在本 invoke 语义下同值。

- `orchestrator.ts` err 路径改 `errMeta._toolCallCount ?? 0`（附 Why 注释）
- `getToolCallCount` 全链退役：
  - `types.ts` AttemptDriver 接口字段删除
  - `agent-invoker.ts` driver 转发实现删除
  - `sdk-invoke-port.ts` SdkInvokePort 接口声明删除
  - `pi-session-factory.ts` 实现删除（其 `?? this.activeSessions.get(otterId)` 的裸键回退正是污染面）
  - 16 处测试 mock 死字段清理（多为 `getToolCallCount: () => 0` 占位）

## 测试

`tests/usecases/conversation/agent-turn-orchestrator/toolcall-count-fallback.test.ts`（2 用例，真实 `executeTurn` 驱动）：

- **无快照形态**（acquire 阶段抛错，无 `_toolCallCount` 字段）：driver 携带会返回 7 的污染源 → 断言终态 `emitInvokeEnd` 载荷与中断文案计数为 **0**、不出现「7 次」。修复前红：`expected 0 to be 7`（旧兜底真实消费了污染值）
- **快照形态**（factory catch 形态，`_toolCallCount: 5`）：断言快照优先透传，终态载荷 5、文案含「5 次工具调用」（锁 #763 主修复行为不回退）

## 验证

- tsc 0 错；受影响面 20 文件 194 用例全绿；全量 423 文件 5596 用例零回归
- `grep -rn getToolCallCount src/ tests/` 零残留（退役面完整）
- 已过最简检查：删除（−5 处生产 + 16 处 mock）即最简——无新增代码路径

## 影响范围

- err 路径计数：经 factory 的错误行为不变（快照恒在，兜底从未触发过）；acquire 阶段错误计数从「可能污染值」变「确定 0」——**用户可见变化仅此一处**：中断文案与前端统计不再可能出现别人的计数
- 成功路径 `attempt.toolCallCount`（countBox 事件流计数）不受影响
- `SdkInvokePort` 接口面收窄：外部无第三方实现（mahjong otter-adapter 只用 invoke/abort）

## 设计取舍

- **机制判定**：纯存量缺陷修复 + 死代码退役，无新机制引入——机制预算四问不触发，无后续机制与退役条件需声明
- **为何退役而非修复兜底**：兜底的唯一理论职责（acquire 阶段错误计数）经语义推演恒为 0——保留一条永远返回 0 的重查链等于保留污染面，没有任何收益
- **为何不区分「快照 0」与「无快照」**（issue 原文「需单独评估」项的答案）：两者在本 invoke 语义下同为 0 值；factory 侧已用 `?? 0` 归一，orchestrator 侧再区分只会引入一个永远不成立的分支
- **测试 mock 清理携带面**：接口字段删除后 mock 若保留字段不报错（多余属性不触发 TS excess check——mock 均 `as unknown as` 断言），清理是纪律不是编译需要；红测文件中保留一处戏剧化 setup 注释说明「污染源 7」的来源语义

## 关联

- issue #1116；上游主修复 F20260922tcrc（#763 / PR #1113）；issue #752（中断归因上下文）
