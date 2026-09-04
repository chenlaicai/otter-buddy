---
id: F20260904ghst
title: '幽灵 sender 根治：发言者身份三元组统一 + 存量回填'
summary: 发言者身份错位是系统创建以来的顽疾（49 条 user 海獭 + 614 条 system+UUID）。根源是三个角色概念共用裸 string 通道无类型区分，发言人、触发者、任务属主都可塞进同一个 senderId 字段。本次修复重试链路身份改传 otterId、sendMessage.start 加幽灵 sender 门禁 fail-fast、scheduler system 消息 senderId 归一、resume 兜底不再造假身份、存量数据一次性回填迁移。
change_type: fix
capability_test: 'n/a: 数据完整性修复，行为由 38 个迁移测试 + guard-bounce 回归锚 + send-message 门禁用例守护（见验证节）'
created_in_conversation: 00f4bbbe-a398-4475-b1b5-ee358236afe3
tags: [sender-identity, ghost-sender, migration, orchestrator, scheduler, resume]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/send-message.ts
  - src/usecases/conversation/resume-interrupted-service.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/frameworks/db/migration.ts
  - tests/usecases/conversation/send-message.test.ts
  - tests/interface-adapters/agent-invoker-guard-bounce.test.ts
  - tests/frameworks/db/migration.test.ts
---

# F20260904ghst: 幽灵 sender 根治：发言者身份三元组统一 + 存量回填

## 背景与问题

搭档 2026-09-04 在《工具优化》对话发现一条「user 海獭」发言（seq50，76.7k tokens，103.4s）。
全库排查发现这不是孤例，而是**系统创建以来的三类身份错位顽疾**：

| 症状 | 数量 | 最早 | 触发路径 |
|------|------|------|----------|
| `sender_type='otter' AND sender_id='user'`（幽灵獭） | 49 条 | 2026-08-19 | orchestrator 重试新建消息 / 服务重启恢复链路 |
| `sender_type='system' AND sender_id=大獭UUID`（杂交系统消息） | 614 条 | 2026-07-27 | scheduler 定时任务 createSystemMessage 透传 task.senderId |
| `sender_name=''`（无快照名） | ~1700 条 | 2026-07-27 | 历史消息（8/24 F20260824snrs 快照机制前的存量） |

第三类（空名）是良性的——层 3 前端按 senderId 反查兜底，本次不动，只修前两类。

## 根源分析（为什么持续出现）

**概念根源**：系统的「发言者」其实是三个不同角色，但它们共用 `senderId: string` 一个裸通道，无类型区分、无写入约束——任何调用方都能把任何角色的值塞进去：

1. **发言人（speaker）**：这条消息是谁说的。otter 消息必须是真实 otterId。
2. **触发者（trigger/sender）**：谁导致这次发言。用户触发时是 `'user'`（或渠道 ID）、链式触发时是上游獭。
3. **任务属主（owner）**：scheduler 场景任务归谁。是大獭 UUID。

三个角色三个语义，一个字段三种值——**谁传错都没人拦**。具体注入点：

- **注入点 1**（幽灵獭主犯）：`orchestrator.ts` 两处重试新建消息（degenerate retry ~L644、guard bounce ~L819）调用 `startNewMessage(convId, ctx.input.senderId, [ctx.input.senderId])`——把「触发者」当「发言人」传。服务重启恢复链路（resume）触发时 senderId 反查 turn 内用户消息落空，兜底字面量 `?? "user"`（resume-interrupted-service.ts:279），双重放大。
- **注入点 2**（杂交系统消息）：`scheduler-service.ts` createSystemMessage / notifyTaskErrored 把 `task.senderId`（任务属主）当消息 senderId 传，system 消息长出大獭 UUID。
- **放大器**：`send-message.ts start()` 收到任何 senderId 都静默落库（senderName 查不到就空串），身份错误无告警直达 DB。

**为什么一直没被发现**：错误消息里 27/49 条是 failed/aborted 状态（重试场景天然多失败），UI 不显眼；614 条 system+UUID 不影响展示（system 名走前端）；没有对 sender_id 与 sender_type 一致性的校验或统计。直到一条 completed 的幽灵消息顶着「user」名字发了正式 PR 汇报，才被搭档看见。

## 方案设计

三道防线，按「堵新增 → 防再发 → 洗存量」排列：

### 防线 1：重试链路身份修正（堵新增主路径）

`orchestrator.ts` 两处 `startNewMessage` 的 senderId 参数改传 `ctx.input.otterId`（发言人），
`talkingStonePassedTo` 保持 `[ctx.input.senderId]`（触发者——重试彻底失败兜底时发言石回传触发者，语义正确）。

`resume-interrupted-service.ts:279` 的兜底 `?? "user"` 改为 `?? ""`——纯獭链恢复时触发者是系统，
宁空不造假身份（空串不参与链调度，buildRoster 走非访客分支，前端按默认搭档名渲染）。

### 防线 2：写入门禁（防再发，fail-fast）

`send-message.ts start()`：senderId 查不到真实 otter 时抛 `not_found` DomainError，不再静默落库。
这是层 2（usecase）收敛点——下游四个链路（主 invoke / degenerate retry / guard bounce / scheduler 直投）
全部经过此处，一处门禁全链路生效。

### 防线 3：存量回填迁移（洗数据）

`migration.ts backfillGhostSenders`：
- 症状 B：`UPDATE ... WHERE sender_type='system' AND sender_id != 'system'` 归一为 'system'。
- 症状 A：幽灵獭回填为**同 conversation 内 sequence 更小的最近一条正常獭消息的 sender**——重试场景中被恢复/被重试的发言者就是幽灵消息的真正作者；找不到则跳过不误伤。sender_name 同步回填。
- 幂等：症状命中才 UPDATE；生产库副本实测 49+614 全部回填，二次运行零写入。

## 变更清单

| 文件 | 变更 |
|------|------|
| `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts` | 两处 startNewMessage senderId 改传 otterId（degenerate retry + guard bounce） |
| `src/usecases/conversation/send-message.ts` | start() 加幽灵 sender 门禁（not_found）+ senderName 直取 otter.name |
| `src/usecases/conversation/resume-interrupted-service.ts` | senderId 兜底 "user" → ""（不造假身份） |
| `src/usecases/scheduler/scheduler-service.ts` | createSystemMessage / notifyTaskErrored 的 senderId 归一 'system'（task.senderId 保留在 scheduled_tasks 表，业务字段不动） |
| `src/frameworks/db/migration.ts` | backfillGhostSenders 一次性迁移（幂等） |
| `tests/usecases/conversation/send-message.test.ts` | 门禁回归用例 + seed 适配 |
| `tests/interface-adapters/agent-invoker-guard-bounce.test.ts` | mock 捕获 start 入参 + 幽灵 sender 断言（重试新消息 speaker=otterId） |
| `tests/frameworks/db/migration.test.ts` | 迁移 4 用例（症状A/B/不误伤/幂等） |

## 验证

- **全量测试**：3015 passed / 241 files（含新增 4 个门禁用例 + 4 个迁移用例 + guard-bounce 断言扩展）
- **生产库副本实测**（/tmp/ghost-test.db 复刻迁移逻辑）：症状 A 49 条全部回填（fixed=49, skipped=0）、症状 B 614 条归一、幂等复跑零写入；现场样本（今天 seq50 那条）正确变回 `sender_id=13b0a07b（大獭）`
- **幂等性**：迁移按症状命中，重跑无命中即无写入（38 测试含二次迁移用例）
- **最简实现检查**：已过——无新依赖、无新表、无 schema 变更；门禁复用已有 getById 查询；迁移复用既有一次性补丁模式（PRAGMA/条件检测）
- pre-existing 声明：无（基线全绿）

## 影响范围与风险

- **行为变更**：start() 现在会拒绝幽灵 sender（fail-fast）——若仍有未发现的注入点，错误会显式暴露（DomainError not_found）而非静默落库。这是设计意图：宁可显式失败，不可静默污染。
- **数据回填**：49 条幽灵獭按「同会话前一条正常獭」启发式溯源。重试场景下该启发式准确性高（重试主体就是前一发言者）；理论上存在链式多獭交错时归属偏差的可能，但相比「顶着 user 名义」的确定错误，归属到相邻发言獭是更优近似。
- **不动的部分**：~1700 条空 sender_name 存量（良性，前端兜底）；`scheduled_tasks.sender_id` 业务字段（任务归谁，非消息发言者）。

## 后续

- 若启动后发现 healing 台账出现「幽灵 sender 拒绝落库」的 not_found 报错，说明仍有未发现的注入点——按报错上下文定位（这正是门禁的观测价值）。
