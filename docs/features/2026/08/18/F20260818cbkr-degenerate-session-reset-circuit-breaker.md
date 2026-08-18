---
id: F20260818cbkr
title: degenerate-session-reset-circuit-breaker
doc_type: feature

summary: |
  连续退化输出时熔断带污重试，改走重启獭生（session reset）后自动续跑。
  根因：mimo 自发复读 + degenerate 重试不清理 session 上下文，垃圾复读示范被反复喂回，
  形成"退化→带污重试→再退化→abort→用户手动续"死循环。
  复用既有 restartSession（归档 pi session + 前情摘要注入新 session）作为熔断动作。

causal_links:
  from:
    - F20260727guar   # degenerate_output guard（流式检测）
    - F20260806dgrf   # degenerate 重试机制（当前只重试一次即 abort）
    - F20260810rsta   # restart_otter 工具（restartSession 从 controller 提取共用）
    - F20260813rstrt  # pendingRestart 自重启延迟执行

status: draft
change_type: fix
tags: [agent, degenerate, circuit-breaker, session-restart, resilience]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - src/usecases/otter/manage-session.ts
created_in_conversation: 9bf7b011-ddbc-49b7-98dd-a44315cd83d9
---

# F20260818cbkr: 连续退化 → 重启獭生熔断

## 背景与需求

### 问题描述

对话《小獭的解散时机》（9bf7b011，2026-08-18 06:29–07:34）中，大獭（mimo-v2.5-pro）在约 1 小时内触发 6 次系统异常中断（4 次 failed + 2 次 aborted），用户被迫多次手动"继续"。每次异常的表现是同一条系统消息反复出现：

- `[系统] 检测到输出异常重复，正在自我纠正`（degenerate retry）
- `[系统保护] 检测到输出内容异常重复，已自动中断。`（retry 失败后 abort）

用户明确反馈"这个问题非常影响用户体验"。

### 根因分析

**两层叠加：模型层缺陷是直接根因，系统层设计放大了它。**

**1. 直接根因：mimo 自发的 mid-turn 文本复读（模型层）**

每次异常的形态完全一致——turn 中途的"进度旁白" text block 塌缩成逐字复读，直到被流式守卫掐断：

| 消息 seq | 时间 | 复读内容（截取） | 复读前触发点 |
|-----|------|---------------------|----------------|
| 6（首次） | 06:43 | "好，我看到了当前对话的 ID 是…让我看看当前对话的 ID。"×N | `link_memory` 报错 `entry not found` |
| 8 | 06:46 | "好，我已经读取了 otter-summon skill。现在我需要：…"×N | 无异常，工具全部成功 |
| 15 | 07:07 | "好，worktree 已创建。现在我需要：…"×N | 无异常，工具全部成功 |
| 19 | 07:14 | "好，我看到了 ConversationParticipant 接口。…"×N | 一长串 grep/read 之后 |
| 21 | 07:20 | "好，没有输出。让我看看完整的构建输出。"×N | grep 无匹配返回 `(no output) + exit code 1` |

关键判据：seq 8 / seq 15 复读发生前上下文干净、工具全部成功——证明这是 mimo 的自发退化倾向（干净上下文也会复读），与已知观察一致，不是污染驱动。次要诱因：工具错误/歧义结果（link_memory 报错、grep exit 1 呈现为错误）会诱发复读。

**2. 放大器：degenerate 重试不清理上下文（系统层）**

当前机制（orchestrator.ts `handleDegenerateRetry`）：检测到退化 → fail 消息 + 注入系统提醒 → **同一个 pi session 重新 invoke**。问题：

- **退化输出留在 session 上下文里**。session jsonl 中 7 条带完整复读文本的 assistant 消息（最长 33KB）被每次重试反复喂回，相当于给复读行为做 few-shot 示范——重试不是纠错，是加固。
- **只允许重试一次**（`retryCount === 0`），第二次退化直接 abort，没有下一步手段。
- **abort 后靠用户手动"继续"续命**，而"继续"仍带着被污染的 session，于是再次退化（seq 23/25 复现了 19/21 的完整循环）。
- 每次失败烧 2–2.5 分钟生成才被守卫捕获，6 次异常 ≈ 15 分钟纯浪费。

**已否决的替代方案**：重试时剥离/截断 session 中的退化输出。原因：otter 不管理底层 pi session，且修改已有 session 历史会破坏 KV cache 命中率。熔断只能走整段 session reset。

### 数据实锤

- 消息流：`messages` 表 conversation 9bf7b011 seq 8/15/19/23 failed、seq 21/25 aborted（`data/otter-buddy.db`）
- 复读原文与触发点：`message_events` 表同 conversation（`assistant_text` 事件）
- 垃圾留存证据：`data/sessions/2026-08-18T06-15-58-321Z_01a01383-*.jsonl` line 70/77/101/128/182/204/230（含复读文本的 assistant 消息）
- 模型：`mimo-v2.5-pro`，thinking high（session jsonl `model_change` 事件）
- 次要诱因实例：seq 21 中 `grep "error TS"` 无匹配 → `(no output) + Command exited with code 1` → 模型换姿势重试 3 次 → 退化
- healing_events 表 count=0：self-healing 只拦截不落事件，事后无可查询的退化记录

## 方案设计

### 技术方案

**核心：复用既有"重启獭生"机制（`manage-session.ts restartSession`）作为熔断动作，不新造 reset 基础设施。**

`restartSession(otterId, summary)` 一步完成：归档当前 session（含底层 pi session reset——复读垃圾随之清除、工作记忆转历史不丢失）→ 创建新 session 并写入前情摘要 → invoke 时由 `agent-invoker.ts` 将 `session.summary` 注入 DynamicContext（身份 + 前情冷启动上下文现成）。竞态认领、pi 锁等待（熔断场景 invoke 已退出，无 in-flight）均已处理。

**触发条件（两级）**：

1. **一级（本次事故直接形态，必须做）**：degenerate retry 本身再次 degenerate——即 `routeGuardAbort` 中 `guardReason === 'degenerate_output' && retryCount > 0` 的路径，从 `abortTerminal` 改为 `restartSession + 最后一次重试`。无需新增计数器，改动收敛在 orchestrator 一处。
2. **二级（abort 后用户手动继续又退化，覆盖 seq 23/25 形态）**：按 otter 维护滑动窗口退化计数（如最近 3 个 turn 内 ≥3 次 degenerate_output），命中则下次 invoke 前先 restart。计数可从消息历史推导（failed 且 body 为退化标记的消息），避免新状态。

**前情摘要构成**（唯一需要设计的新内容）：

```
[熔断重启] 上一世因连续输出退化被系统熔断，上下文已清空。
当时任务：{用户最近一条消息摘要}
已进行到：{该 turn 已完成的工具调用要点（如：特性文档已写、worktree 已建、已改文件清单）}
请从中断处继续，不要重新规划。
```

素材 orchestrator 上下文中均有（用户消息 + turn 内工具调用记录）。

**用户体验**：熔断发生时发系统消息说明"检测到连续退化，已重启獭生（清空污染上下文），自动继续执行中"，替换死循环的 abort 文案。用户无感知自动恢复。

**熔断上限**：restart 后的重试若第三次仍退化，`abortTerminal`（此时可确认非上下文污染问题，继续烧 token 无意义）。

### 目标

- T1: degenerate retry 再次退化时，自动 restartSession 并续跑，不再直接 abort
- T2: 重启后新 session 携带前情摘要，otter 能从中断处继续任务而非从零开始
- T3: 用户在整过程中无需手动"继续"干预
- T4: abort 后手动继续仍退化的形态（二级触发）同样被熔断覆盖
- T5: 退化事件落 healing_events（修复 count=0 的观测缺失）

### 成功标准

- 复现"degenerate retry 再退化"场景时，观察到的行为序列是：fail → retry → fail → 系统消息（熔断说明）→ restartSession → 新 session invoke → speak 成功，全程无人工干预
- 新 session 的 invoke prompt 中含前情摘要，otter 输出体现任务连续性（不重新做已完成的步骤）
- 单元测试覆盖：一级触发、二级触发、熔断上限、摘要注入

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1 一级熔断 | 单测：mock invoke 连续两次返回 degenerate_output guard abort | 第二次触发 restartSession（session 被归档、新 session 创建），随后再 invoke 一次 |
| AT-2 | T1 熔断上限 | 单测：restart 后第三次仍 degenerate | 走 abortTerminal，不再 restart |
| AT-3 | T2 前情摘要 | 单测：触发熔断，检查 restartSession 入参 summary | 含熔断原因 + 任务进度要素 |
| AT-4 | T4 二级熔断 | 单测：构造消息历史含密集退化标记后 invoke | invoke 前先 restart |
| AT-5 | T3/T2 真实行为 | 隔离实例（独立端口 + 独立 DB + 真实 LLM）重现退化场景（可用长任务 + mimo 触发），观察全链路 | 自动恢复链路走通，otter 输出体现任务连续性 |
| AT-6 | T5 观测 | 触发退化后查 healing_events | 有对应事件记录 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1~AT-4 | 单元测试（tests/ 下常规用例，非能力测试） |
| AT-5 | n/a: 熔断触发与重启编排为纯代码逻辑（A 类）；真实 LLM 场景为一次性人工验证（隔离实例），无常驻行为断言 |

## 实现细节

### 代码修改

[实现阶段填写]

### 逻辑变更

[实现阶段填写]

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | 修改 | routeGuardAbort 二次退化走 restart 分支 |
| src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts | 修改 | 熔断文案、摘要构建纯函数 |
| src/usecases/otter/manage-session.ts | 预计不改 | restartSession 已满足需求 |
| src/frameworks/db/（healing events 写入） | 修改 | 退化事件落库 |

## 验收结果

### 测试结果

[验收阶段填写]

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 | 待验收 | ❓ |
| T2 | 待验收 | ❓ |
| T3 | 待验收 | ❓ |
| T4 | 待验收 | ❓ |
| T5 | 待验收 | ❓ |

## 对抗审视记录

[审视阶段填写]

## 设计决策

### 为什么不做"重试时剥离 session 中的退化输出"

用户拍板否决：otter 不管理底层 pi session；修改已有 session 历史会破坏 KV cache 命中率。熔断只能走整段 reset。session reset 的 KV cache 冷启动是一次性成本，远低于现状（每次带污重试烧 2–2.5 分钟生成且大概率再失败）。

### 为什么复用 restartSession 而非新造 reset

restartSession 已解决：pi session 清理、工作记忆转历史（记忆不丢）、前情摘要注入（invoke 时进 DynamicContext）、竞态认领。熔断场景 invoke 已 guard abort 退出，无 pi 锁等待问题。

### bash 工具结果语义修正（关联但独立）

seq 21 实证 grep 无匹配返回 `(no output) + exit code 1` 会诱发模型循环重试后退化。属工具结果呈现问题，独立于本熔断特性，另行处理（PR 范围聚焦原则）。
