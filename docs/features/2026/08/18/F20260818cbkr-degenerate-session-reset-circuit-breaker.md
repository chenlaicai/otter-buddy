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

status: design
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

`restartSession(otterId, summary)` 一步完成：归档当前 session（含底层 pi session reset——复读垃圾随之清除；工作记忆全量转历史——内容不丢，丢的是 working 层活性，与既有重启獭生语义一致）→ 创建新 session 并写入前情摘要 → invoke 时由 `agent-invoker.ts` 将 `session.summary` 注入 DynamicContext（身份 + 前情冷启动上下文现成）。竞态认领已处理；pi 锁方面，reset 走锁管理器串行化，熔断触发时 invoke 已 await 返回（guard abort 路径 driver.invoke 已结束），无 in-flight 等待。

**触发条件（两级，数据源统一为 healing_events）**：

每次 degenerate guard 触发（含 retry 失败与 abort）都写一条 healing_events（T5）。两级触发都从该表推导，不依赖消息 body 字符串匹配（文案硬编码且散落在 orchestrator.ts/retry-policy.ts 两处，改文案即静默失效；且 aborted 状态的退化按 body 匹配会漏）。

1. **一级（本次事故直接形态，必须做）**：degenerate retry 本身再次 degenerate——即 `routeGuardAbort` 中 `guardReason === 'degenerate_output' && retryCount > 0` 的路径，从 `abortTerminal` 改为 `熔断重启`。
2. **二级（abort 后用户手动继续又退化，覆盖 seq 23/25 形态）**：invoke 前查 healing_events，该 otter 最近 2 个 turn 内 ≥2 次 degenerate 事件（retry 失败与 abort 各计一次）→ 先 restart 再执行。窗口参数依据：一级触发已覆盖"turn 内连续两次退化"，二级只需兜"abort 后手动继续又退化"，两轮即熔断，用户最多再经历一次 abort。

   - **挂载点**：`invokeConversationInner` 的 buildDynamicContext 阶段（与既有 getActiveSession 查询同期）。invokeConversation 共 4 个调用方（dispatch 链 / scheduler / message-controller 手动重试 / inbound recruit），挂入口全覆盖——含手动重试按钮路径，不会绕过熔断。
   - **turn 粒度推导**：healing_events 无 turn 字段，按 message_id JOIN messages 取 turn_id 去重计数。
   - **跨 conversation 计数（有意决策）**：同一 otter 多对话时退化事件互相累计。session 与退化倾向都是 otter 级的，restart 也是 otter 级动作，按 otter 计数语义正确。

**熔断执行路径（关键：restart 后必须是全新 invoke，且熔断信号必须穿透 orchestrator 边界）**：

`sessionSummary` 只在 `invokeConversation` 入口构建 DynamicContext 时注入一次（agent-invoker.ts buildDynamicContext），executeTurn 循环内所有 attempt 复用同一份 context——orchestrator 内 continue 重试拿不到新 session 的前情摘要。因此：

1. `routeGuardAbort` 检测到一级触发条件 → 对当前 messageId 走 `failMessage` + 熔断说明文案（retry 时创建的第二条消息不能残留在 streaming 态）→ TurnResult 返回熔断标记（如 `_circuitBreak` 判别字段），executeTurn **不在循环内消费、直接上抛**
2. `invokeConversationInner` 检测到熔断标记 → 调 `restartSession`（TurnCallbacks 回调，由 agent-invoker 装配，对齐 `sendSystem`/`startNewMessage` 模式；orchestrator 不直接依赖 ManageSession）→ 写 healing_events `circuit_break` 事件（context JSON 存新 session id）→ 以新 session 发起**全新 invoke**
3. 新 invoke 入口正常走 buildDynamicContext，前情摘要随新 session.summary 注入

**与 RetryWithNewMessageSignal 的区别（实现红线）**：现有 `_retryWithNewMessage` 信号在 executeTurn 的 while 循环**内部**被消费（更新 currentInput 后 continue），从不跨出 orchestrator。熔断信号是**跨层信号**——若照现有信号写法在循环内拦截，恰好复刻"orchestrator 内 continue"错误。TurnResult 类型需扩展判别字段，invokeConversationInner 需新增检测分支。

**熔断上限（防止无限 restart 循环）**：`circuit_break` 事件由 agent-invoker 在 restartSession 返回新 session 后、发起全新 invoke 前写入（顺序 await 保证新 invoke 查询时事件已落库）；healing_events 无 session 字段，session id 存 `context` JSON，并为 otter_id 补索引（现仅有 status/severity/created/type 四索引）；errorType 枚举需扩展 `degenerate`/`circuit_break`。新 session 的 invoke 若再次触发 degenerate guard，查得"当前 session 由熔断创建"→ 不再 restart，直接 `abortTerminal`。上限状态跨 invoke 存续，不依赖进程内存。

**pendingRestart 交互（不做跨层清除）**：pendingRestart 存于 pi-session-factory 每次 invoke 新建的 ToolContext（frameworks 层），orchestrator/agent-invoker 无访问途径，跨层清除不可实现。实际风险分析：自重启检查在 `session.prompt()` 正常返回路径上执行，guard abort 走异常路径时自重启天然跳过（实现阶段验证 `_checkSessionError` 行为）；即使自重启已先执行，熔断的 healing_events 判定（新 session 无退化历史 → 不命中熔断）防止二次归档。若实现阶段验证发现确有双重窗口，再在 ToolContext 增加只读查询回调。

**熔断动作失败的降级**：restartSession 失败（archive 抛错 / reset 抛错 / 事件写入失败）时回退 `abortTerminal`，系统消息说明"熔断失败已中断"，healing_events 记录失败原因。失败场景多为 DB/锁异常，不引入延迟重试；降级后行为与现状等价，不会更糟。

**前情摘要构成**：

```
[熔断重启] 上一世因连续输出退化被系统熔断，上下文已清空。
当时任务：{用户原始消息摘要}
已进行到：{该 turn 已完成的工具调用要点（如：特性文档已写、worktree 已建、已改文件清单）}
请从中断处继续，不要重新规划。
```

**素材来源（注意不能直接用 RouteContext）**：一级触发时 `currentInput.userMessageContent` 已被 retry 覆写为系统提醒文案，orchestrator 内拿不到用户原始消息——TurnInput 需保留 `originalUserMessage`（或经回调查 messages 表最近用户消息）；工具调用明细 orchestrator 只有计数，需经 message_events 查询该 messageId 的 tool 事件。素材查询失败时降级为仅含熔断原因的短摘要，不因摘要构建失败阻塞熔断。

**用户体验**：熔断发生时发系统消息说明"检测到连续退化，已重启獭生（清空污染上下文），自动继续执行中"，替换死循环的 abort 文案。用户无感知自动恢复。

### 目标

- T1: degenerate retry 再次退化时，自动 restartSession 并续跑，不再直接 abort
- T2: 重启后新 session 携带前情摘要，otter 能从中断处继续任务而非从零开始
- T3: 用户在整过程中无需手动"继续"干预
- T4: abort 后手动继续仍退化的形态（二级触发）同样被熔断覆盖
- T5: 退化事件落 healing_events（修复 count=0 的观测缺失）

### 成功标准

- 复现"degenerate retry 再退化"场景时，观察到的消息序列是：第一条消息 fail（自我纠正文案）→ retry 消息 fail（熔断说明文案，不残留 streaming）→ 系统消息（熔断说明）→ restartSession + circuit_break 事件落库 → **全新 invoke**（含前情摘要）→ speak 成功，全程无人工干预
- 新 session 的 invoke prompt 中含前情摘要，otter 输出体现任务连续性（不重新做已完成的步骤）
- 单元测试覆盖：一级触发、二级触发、熔断上限、摘要注入

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1 一级熔断 | 单测：mock invoke 连续两次返回 degenerate_output guard abort | 第二次返回熔断信号，agent-invoker 调 restartSession 后以新 session 全新 invoke |
| AT-2 | T1 熔断上限 | 单测：熔断创建的新 session 再次 degenerate（healing_events 含 circuit_break 关联） | 走 abortTerminal，不再 restart |
| AT-3 | T2 前情摘要 | 单测：触发熔断，检查 restartSession 入参 summary；新 invoke 的 DynamicContext | summary 含熔断原因 + 任务进度要素；新 invoke 的 sessionSummary 注入生效 |
| AT-4 | T4 二级熔断 | 单测：healing_events 构造最近 2 turn 内 2 次退化事件后 invoke | invoke 前先 restart |
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
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | 修改 | routeGuardAbort 二次退化返回熔断信号（跨层上抛）；retry 消息收尾；TurnInput 保留 originalUserMessage |
| src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts | 修改 | 熔断文案、摘要构建纯函数 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 修改 | 装配 restartSession 回调；检测熔断信号 → restart + 写 circuit_break 事件 + 全新 invoke；二级触发查询挂载 |
| src/usecases/otter/manage-session.ts | 不改 | restartSession 已满足需求；事件写入在 invoker 层 |
| src/entities/…/healing-event.ts + src/frameworks/db/schema.ts | 修改 | errorType 枚举扩展 degenerate/circuit_break；healing_events 补 otter_id 索引 |

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

### 第一轮（2026-08-18，审查者：独立 agent 挑剔獭，焦点：正确性 / 边界条件 / 架构合规）

4 严重发现、4 建议发现。全部处置如下：

| 发现 | 级别 | 处置 |
|------|------|------|
| 1. 前情摘要不会注入 orchestrator 内 continue 的重试（sessionSummary 仅在 invokeConversation 入口构建一次） | 严重 | 已修：方案明确熔断走"信号返回 → agent-invoker 全新 invoke"路径，并写明为什么不能 orchestrator 内 continue |
| 2. "无需新增计数器"与熔断上限（AT-2）自相矛盾（restart 后新 TurnInput，retryCount 归零） | 严重 | 已修：上限状态载体为 healing_events 的 circuit_break 事件（关联新 session id），跨 invoke 存续；删除"无需新增计数器"表述 |
| 3. 二级触发靠消息 body 字符串匹配不可靠且漏 aborted 状态 | 严重 | 已修：两级触发数据源统一为 healing_events；窗口参数改为"最近 2 turn 内 ≥2 次"，按目标形态重新推导 |
| 4. restartSession 失败路径未考虑（熔断时 turn 已在失败态，抛错即三不管） | 严重 | 已修：失败降级回退 abortTerminal + 系统消息说明 + healing_events 留痕；不引入延迟重试 |
| 5. orchestrator 直接依赖 ManageSession 打破上下文隔离 | 建议（更好） | 已采纳：restartSession 走 TurnCallbacks 回调由 agent-invoker 装配；agent-invoker.ts 补入改动范围 |
| 6. "invoke 已退出、无 in-flight"论证缺失（reset 走锁管理器） | 建议 | 已修：方案中补论证（guard abort 路径 driver.invoke 已 await 返回）；实现阶段 AT-5 实测验证 |
| 7. pendingRestart 双重 restart 风险 | 建议（更好） | 已采纳：熔断执行前消费/清除 pendingRestart；靠 healing_events 推导天然防重复触发 |
| 8. working 记忆全量降层语义未提示 | 建议（更好） | 已采纳：方案中补"内容不丢、丢的是 working 层活性"说明 |

审查者核验确认的事实性声明（无需修改）：degenerate retry 只允许一次（orchestrator.ts retryCount===0 分支）；restartSession 含 pi session reset 与记忆转历史；摘要注入点语义准确（行号 375-376）。

### 第二轮（2026-08-18，审查者：独立 agent 拾遗獭，焦点：第一轮修复新增设计的自身缺陷）

5 严重发现、4 建议发现。全部处置：

| 发现 | 级别 | 处置 |
|------|------|------|
| S1. "对齐 RetryWithNewMessageSignal 模式"类比不成立——该信号在 executeTurn 循环内消费，从不跨出 orchestrator；照抄会复刻已否决的 continue 错误 | 严重 | 已修：方案改为显式设计跨层信号（TurnResult 判别字段上抛 + invokeConversationInner 检测分支），并加"实现红线"段落写明与现有信号的区别 |
| S2. 摘要素材声明为假——retry 时 userMessageContent 已被覆写为系统提醒文案；工具调用明细 orchestrator 只有计数 | 严重 | 已修：素材来源改为 TurnInput 保留 originalUserMessage + message_events 查询 tool 事件；修正原声明 |
| S3. circuit_break 事件写入方自相矛盾（正文说 restartSession 写，改动范围说 manage-session 不改）；healing_events 无 session 字段、无 otter_id 索引、errorType 枚举缺项 | 严重 | 已修：写入方定为 agent-invoker（restart 返回后、新 invoke 前，顺序 await 防竞态）；session id 存 context JSON + 补 otter_id 索引 + 枚举扩展，均入方案与改动范围 |
| S4. "最近 2 turn"在 healing_events 上不可直接推导（无 turn 字段）；跨 conversation 计数是隐含决策 | 严重 | 已修：推导路径定为 JOIN messages 取 turn_id 去重；跨 conversation 计数显式记录为有意决策 |
| S5. pendingRestart 跨层清除不可实现（标记在 frameworks 层每次 invoke 新建的 ToolContext 里）；真实风险窗口与方案描述不符 | 严重 | 已修：删除跨层清除设计，改为论证（guard abort 异常路径自重启天然跳过，实现阶段验证 _checkSessionError；healing_events 判定兜底防二次归档） |
| B1. 二级触发挂载点未指定（invokeConversation 有 4 个调用方） | 建议（更好） | 已采纳：挂 invokeConversationInner 的 buildDynamicContext 阶段，与 getActiveSession 同期 |
| B2. 手动重试路径可能绕过熔断 | 建议 | 已采纳：入口挂载覆盖手动重试，方案写明 |
| B3. retry 创建的第二条消息收尾未定义（会残留 streaming） | 建议（更好） | 已采纳：熔断信号返回前 orchestrator 对当前 messageId failMessage + 熔断文案 |
| B4. 成功标准的行为序列描述含糊 | 建议 | 已采纳：成功标准改为明确的消息级序列 |

## 设计决策

### 为什么不做"重试时剥离 session 中的退化输出"

用户拍板否决：otter 不管理底层 pi session；修改已有 session 历史会破坏 KV cache 命中率。熔断只能走整段 reset。session reset 的 KV cache 冷启动是一次性成本，远低于现状（每次带污重试烧 2–2.5 分钟生成且大概率再失败）。

### 为什么复用 restartSession 而非新造 reset

restartSession 已解决：pi session 清理、工作记忆转历史、前情摘要注入、竞态认领。熔断场景 invoke 已 guard abort 退出，无 pi 锁等待问题。

### 为什么熔断后必须全新 invoke 而非 orchestrator 内 continue

非权衡，是代码事实决定的唯一解：sessionSummary 仅在 invokeConversation 入口的 buildDynamicContext 注入一次，executeTurn 循环内复用同一份 DynamicContext。continue 路径拿不到新 session 摘要，T2 必然失败。

### 为什么熔断信号是跨层新信号而非复用 RetryWithNewMessageSignal 模式

RetryWithNewMessageSignal 在 executeTurn 循环内部被消费（更新 currentInput 后 continue），从不跨出 orchestrator；熔断信号必须穿透到 invokeConversationInner 才能触发 restart + 全新 invoke。第二轮审视指出照现有信号写法实现会复刻 continue 错误，故显式设计 TurnResult 判别字段 + invoker 检测分支，并在方案中写为实现红线。

### 为什么二级触发按 otter 计数（跨 conversation 累计）

session 与退化倾向都是 otter 级的，restart 也是 otter 级动作；A 对话的退化说明该 otter 的 session 上下文已污染，B 对话 invoke 前熔断语义正确。

### 为什么不做 pendingRestart 跨层清除

标记存于 pi-session-factory 每次 invoke 新建的 ToolContext（frameworks 层），orchestrator/agent-invoker 无访问途径。经论证：guard abort 走异常路径时自重启检查天然跳过；即使自重启已执行，healing_events 判定（新 session 无退化历史）兜底防二次归档。跨层清除成本高且大概率不必要，删除该设计。

### 为什么状态载体选 healing_events（而非消息 body 匹配 / 内存计数器）

排除法：body 匹配——退化文案硬编码在 orchestrator.ts/retry-policy.ts 两处，改文案即静默失效，且 aborted 状态（事故 seq 21/25 形态）按 body 匹配会漏；内存计数器——进程重启即丢，与持久化观测割裂。healing_events 是 T5 本来就要建的，上限判定、二级触发、观测三用一源。

### 为什么熔断失败降级选"回退 abortTerminal"而非"延迟重试一次"

熔断失败场景多为 DB/锁异常，重试大概率再失败；降级到现状等价行为保证不会更糟。产品层面含义：用户此时看到的仍是中断消息（附"熔断失败"说明），体验回到现状水平。

### bash 工具结果语义修正（关联但独立）

seq 21 实证 grep 无匹配返回 `(no output) + exit code 1` 会诱发模型循环重试后退化。属工具结果呈现问题，独立于本熔断特性，另行处理（PR 范围聚焦原则）。
