---
id: F20261019rpay
title: 触发消息重放标记与真实时间戳（#1553 消息重放当新消息）
summary: 派发链后续 hop 反复以同一 messageId 点火时，触发消息被拼在消息末尾、用本轮时刻且无历史标记，导致 LLM 把 30 分钟前的旧话当「刚发的新消息」当新指令处理；修复为触发消息若属已消费旧消息的重放则强制带「历史」标记并用其真实 createdAt。
change_type: fix
capability_test: "n/a: bugfix 行为由 tests/usecases/conversation/dispatch-chain-engine.test.ts 三个单元用例验证（重放标记/新鲜不标/非 entry 不误标，含修复前失败证据）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-19T20:30:00+08:00
intent:
  problem: "issue #1553：conversation 3241317b 的同一条用户消息（seq 3775，09:42 发）在派发链中被当新消息反复呈现 11 次，agent 记录「同一条消息第 N 次到达」，LLM 将 30 分钟前的旧话当新指令——与 #1431「旧话当新授权」同型。"
  expected_effect: "触发消息若为已消费旧消息的重放，带「历史」标记 + 真实发送时刻，LLM 依 historyNote（旧消息不得作为新授权/新裁决依据）不再当新消息处理；新鲜消息呈现不变。"
  verify_by:
    type: behavior_check
tags: [dispatch-chain, message-presentation, bugfix, replay]
modules: [src/usecases/conversation/dispatch-chain-engine.ts]
causal_links:
  - "issue #1553（2026-10-19）：案发现场与重放时间线（对话 3241317b，11 次重放）"
  - "#1431 方案 B：注入行时间戳 + 历史行标记规范（本修复复用其 historyNote 语义）"
---

# 触发消息重放标记与真实时间戳（#1553）

## 根因分析（已核实，DB + invoke_events 双证）

**现象**（issue #1553）：conversation `3241317b-99d6-4d78-9248-ff208a7461bc` 的同一条用户消息「高危这个你拉个新glm…」被当新消息反复呈现 11 次（09:42–12:45），agent 多次记录「同一条消息第 N 次到达」。

**关键事实修正**（与 issue 描述的差异）：
- issue 称「时间线 user entries 同文 11 条」——**实测库里只有 1 条 user entry**（seq 3775，`entries` 表唯一）。所谓「11 条」是**重放呈现**（LLM context 反复注入），不是 11 条独立投递。游标 `conversation_participants.last_read_seq=3930` 已越过 seq 3775，排除「未读重注入」。
- 11 次呈现 = 派发链 hop 反复以同一 messageId 点火的时刻（invoke_start 时间线吻合）。

**代码定位**（当前 main f0f4f9fb）：
1. `buildMessageWithContext`（`src/usecases/conversation/dispatch-chain-engine.ts:917,925`）把触发消息拼在消息末尾，用 `fmtTime()`（=本轮时刻 `now`）且**不带「历史」标记**；而真正的历史行用 `（历史 · fmtTime(m.createdAt)）`。于是 09:42 发的消息在 10:14 的 hop 里被渲染成 `[chen]（19/10 10:14）`——像用户刚发的新消息。
2. `invoke_events` 铁证（invoke `417691cb`，10:14）：`user_injection` payload 末尾触发消息为 `[chen]（19/10 10:14）高危…`（无历史标记、用本轮时刻），而历史行均为 `[系统]（历史 · 19/10 09:47）…`。

**为什么是重放而非新消息**：触发 entry 已被消费（游标已越过），后续 hop 点火时 `getUnreadEntries` 不再返回它，但 `buildMessageWithContext` 仍以 `userMessageContent`（`buildSignalText` 产物）形态在末尾重新拼入——重复以「新鲜触发」呈现。

## 修复方案（demand #2 核心）

`buildMessageWithContext` 呈现触发消息时新增「新鲜 vs 重放」判定：

1. **新鲜**（触发 entry 在本轮未读批 `unreadAll` 内）→ 呈现用其真实 `createdAt`（≈now，表现不变），不加标记。
2. **重放**（触发是真实 entry 但不在未读批 = 已消费的重复呈现）→ **强制带「历史」标记 + 真实 `createdAt`**：`（历史 · fmtTime(createdAt)）`，与历史行同款格式，`historyNote` 已声明「标注历史的行是本轮之前的消息…旧消息不得作为新授权/新裁决依据」。
3. **非 entry 触发**（retry/resume 传 invokeId，`getEntryById` 为 null）→ 保持原新鲜呈现，不误标。

判定不依赖猜测：用「触发 id 是否在本轮未读批 + `getEntryById` 是否为真实 entry」双信号区分，无时间阈值启发式。

**检视獭关键修正（异体对抗，delta1 轮）**：初版修复不可达主场景——案发 11 次重放全在链内 hop≥2，而 `executeChainInner` 原先 `triggerMessageId: depth === 1 ? … : undefined`（dispatch-chain-engine.ts:237）→ hop≥2 无 id，`resolveTriggerPresentation` 首行短路，修复失效。单测手动传 id恰好绕开真实路径。**修正**：`triggerMessageId` 透传所有 hop（行 240），`executeOneHop` 内 `excludeIds.add(triggerMessageId)` 同步保证 hop≥2 不双份；并补 executeChain 两 hop 集成用例直攻主路径。

**demand #1（同一 messageId 不应重复触发新回合）的定性**：11 次点火是派发链 hop（每 hop 唤醒下一只是编排本职，不是重复投递，21 hop 照跑是预期）。真正缺陷是触发被误当新消息 → LLM 反复当新指令处理。本修复通过「重放即标记」让 LLM 识别旧话不再当新指令（historyNote 语义兜底），从语义面消除「重复触发新回合」。issue 关闭标准「重放不再触发新回合」的准确口径是「LLM 不再把重放当新指令重复应答」（已在 issue 侧同步），而非「hop 不再跑」（那会破坏编排）。

## 验证

**失败用例证据（bugfix Verification 硬规则）**：
- 修复前（`git stash` 源改动后复跑）：`重放触发（真实 entry 但不在本轮未读批）→ 带「历史」标记 + 真实 createdAt` 失败——`AssertionError: expected '## 在场成员\n\n## 当前时间\n- 2026-10-19 20:3…' to contain '（历史 · '`
- 修复后：4 个用例全过（`Tests 4 passed`）。
- **集成用例（直攻主路径）**：`executeChain 两 hop，hop2 重放触发带「历史」标记`——临时回退 line 237 截断后复跑，hop2 失败 `AssertionError: expected '…' to contain '（历史 · '`，证实该用例真实校验 hop≥2 主场景（非手动传 id 绕路径）；恢复截断修复后通过。

**回归**：全量 `npx vitest run` —— `Test Files 400 passed, Tests 6323 passed | 6 skipped`，零失败零回归（6 skipped 为既有跳过项）。既有 `buildMessageWithContext` 测试不传 `triggerMessageId`，新判定分支对其为 no-op，表现不变。

**最简实现检查**：已过阶梯——改单文件 `buildMessageWithContext` 呈现层 + 判定复用现有 `getUnreadEntries`/`getEntryById`，无新依赖、无新表、无新机制；比「引入幂等键 + 重放台账」更简且不改语义。已采简弃繁。

**负面向验收条目**：本次变更改变了什么——①触发消息时间戳从「本轮时刻」改为「真实发送时刻」（新鲜消息也受影响，但新鲜时两者同分钟，表现一致；更准确）。②不绕过任何既有保护，只新增重放标记；未删任何旧契约。③`entryRepo` 依赖类型新增可选 `getEntryById`（向后兼容，测试桩可不注入，降级为不判重放=原行为）。

**Golden Gate**：n/a——本次为 `src/` TypeScript 代码修复（消息呈现逻辑），非 prompt/skill/协议层软代码变更，无 golden 场景可跑。呈现文本（「历史」标记）走 `historyNote` 既有口径，无新 prompt 约定。

## 测试改动声明

新增 `tests/usecases/conversation/dispatch-chain-engine.test.ts` 中 4 个用例（未删改既有用例）：
1. 重放触发 → 带「历史」标记 + 真实 createdAt（修复前失败、修复后通过）
2. 新鲜触发 → 无「历史」标记（回归护栏）
3. 非 entry 触发 → 不误标（回归护栏）
4. executeChain 两 hop 集成用例（#1553 主场景：链内 hop≥2）→ hop2 重放触发带「历史」标记（临时回退 line 237 截断后失败、修复后通过——直攻真实路径，防单测绕路径盲区）
