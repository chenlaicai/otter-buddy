---
id: F20260819spyd
title: speak-yield-split-completion
doc_type: feature

summary: |
  补完 speak+yield 双工具拆分：speak(body) 纯内容输出（appendSegment 直接落库、terminate=false），
  yield(to) 行动权移交（startSpeaking 设路由、terminate=true）。
  根因：PR #290 合入的是被 4c627be 半途折回的残骸——yield 工具被删但 prompt/白名单/no_yield
  外围残留，大獭被教用不存在的工具；且 orchestrator 读 msg.body 恒空导致 message.complete SSE
  body 为空、UI 终态消息空白。

causal_links:
  from:
    - F20260818sgmt

status: development
change_type: feature
tags: [agent, conversation, tool-protocol]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
capability_test: tests/capability/talking-stone-routing.capability.test.ts
created_in_conversation: ac7d5231-9bb9-433f-94d4-addcabd2ea6c
---

# F20260819spyd: speak + yield 双工具拆分补完

## 背景与需求

### 问题描述

用户重启系统后开新对话，发现两个问题：
1. 大獭仍输出旧格式 `{"body":"...","talkingStonePassedTo":["user"]}`——期望的 speak+yield 拆分没有生效
2. UI 只显示流式过程，说话消息不显示（气泡内容为空）

### 根因分析

**问题 1——拆分从未真正合入 main：**

时间线还原（均在 2026-08-18）：
- `2c91fd3`（08:04）：实现拆分——speak 变纯输出（terminate=false）+ 新增 yield 交棒工具
- `4c627be`（11:09）：message_segments 子表重构，**同一 commit 里把拆分折回单工具**
  （删除 yield 工具、speak 恢复 terminate=true 旧语义），但 commit message 仍声称"yield 只设 talkingStonePassedTo"
- PR #290（18:37 squash 为 b9eaa68）：从 `feat/speak-yield-split` 合入**折回后的状态**

main 由此进入不一致状态：
| 部件 | 状态 |
|------|------|
| tool-factory | 旧单工具 speak，无 yield 工具 |
| prompts BIG_OTTER/SMALL_OTTER | 仍教模型"先 speak 再 yield" |
| session-helpers 白名单 | 仍列 "yield"（死引用） |
| orchestrator/invoker | no_yield 退出原因 + 重试机制 |

大獭被 prompt 教用不存在的工具 → 行为混乱（新对话首回合无工具调用，no_yield 重试后才用旧格式调 speak）。

**问题 2——message.complete SSE body 恒空（#290 遗留 bug）：**

segments 重构后 `Message` 实体没有 `body` 字段（只有 `segments`），但
`orchestrator.ts` 的 `body: msg?.body ?? ''` 未同步更新；port 类型
`getMessageById(): Promise<{ status; body?; turnId? }>` 的可选 `body?` 声明让 TS 编译通过、
运行时恒 undefined → SSE `message.complete` 的 body 恒空串 → 前端终态消息内容为空，
把流式期间累积的文本也抹掉。列表 API 的 DTO 走 `aggregateBody(segments)` 所以刷新后正常。

### 数据实锤

- `git show b9eaa68:src/.../tool-factory.ts | grep -c yield` = 0（squash 树里无 yield 工具）
- 运行日志（2026-08-19 08:05 新对话）：第一回合无工具调用 → no_yield 重试提醒 → 第二回合旧格式 speak
- DB：消息 completed 且 segments 有内容，`message_events` 有完整 tool_result——后端链路通，断在 SSE body

## 方案设计

### 技术方案

恢复并适配拆分（在当前 main 的 segments 模型 + PR-B 规则下沉 + 熔断架构上重实现，
不 cherry-pick 旧实现）：

1. **speak(body)**：纯内容输出
   - `validateSpeakBody`（html-card 位置校验保留）→ `appendSegment` 直接落库（每次一条 segment，原子事务，比原 2c91fd3 的内存 buffer 更优——回合中断内容不丢）
   - `terminate=false`，返回 `details.__speakIntermediate` 标记
2. **yield(to)**：行动权移交
   - 前置守卫：segments 为空时报错指导先 speak（替代丢回合走 no_yield 重试，即时反馈）
   - `validateAndResolve`（name→id）→ C9 派工软守卫 → `startSpeaking(messageId, { talkingStonePassedTo })`（body 可选化，不传则只设路由+状态）→ `terminate=true`
3. **SSE speak.intermediate**：agent-invoker 在 `tool_execution_end(speak)` 检测 `details.__speakIntermediate` → 广播；前端三处 handler 累积到消息气泡
4. **退出分类天然适配**：status 'speaking' 只有 yield 的 startSpeaking 才设置——未 yield 结束即 no_yield 重试（`buildYieldRetryMsg` 文案更新为 speak+yield 两步指导）
5. **message.complete body 修复**：port 类型改为返回 `segments: MessageSegment[]`，orchestrator 用 `aggregateBody(msg.segments)`（两处：success + user_abort 路径）

### 目标

- T1: speak 只负责内容，可多次调用、即时落库即时呈现
- T2: yield 只负责交棒，路由校验/软守卫/CAS 幂等终结保留
- T3: prompt ↔ tool-factory ↔ session-helpers 三方一致，无死引用
- T4: message.complete SSE body 恢复，UI 终态消息正常渲染

### 成功标准

- 单元测试全绿（speak/yield 工具契约、orchestrator、invoker）
- 真实 LLM 能力测试：大獭召唤→派工→子獭回传路由正确（3 采样 ≥2）
- 确定性能力测试（录音网关）：speak→yield 两段协议下全链路（落库→SSE→完成）正常

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1/T2 工具契约 | 单元测试 speak-tool.test.ts | speak 落库不终止；yield 校验+终止 |
| AT-2 | T2 真实路由 | talking-stone-routing 能力测试 | 子獭完成后传回大獭不传 user |
| AT-3 | T3 协议一致性 | 录音网关 parity 能力测试 | 每轮 speak+yield 两请求，工具表含两工具 |
| AT-4 | T4 SSE body | 手动/UI 验证 message.complete | 终态消息气泡有内容 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-2 | tests/capability/talking-stone-routing.capability.test.ts |
| AT-3 | tests/capability/model-visible-parity.capability.test.ts |

## 实现细节

### 代码修改

- `tool-factory.ts`：重写 createSpeakTool（appendSegment + terminate=false + __speakIntermediate）；新增 createYieldTool（空内容守卫 + validateAndResolve + C9 + startSpeaking + terminate=true）；create_otter 文案改教 yield
- `otter-tool-client.ts` / `conversation-repository.ts` / `send-message.ts` / `sqlite-conversation-repository.ts`：startSpeaking 的 body 可选化（不传只设路由+状态）
- `agent-invoker.ts`：speak.intermediate SSE 发射（tool_execution_end 检测标记）
- `orchestrator.ts`：两处 `msg?.body` → `aggregateBody(msg.segments)`；handleSpeakRetry → handleYieldRetry（含文案）
- `retry-policy.ts`：buildSpeakRetryMsg → buildYieldRetryMsg（"先 speak 输出，再 yield 交棒"）
- `types.ts`（orchestrator callbacks）：getMessageById 返回 segments（消灭掩盖编译错误的 `body?`）
- `talking-stone.ts` / `dispatch-guard.ts`：错误文案与派工提醒改 yield 语义
- `api-contract/sse/events.ts`：speak.intermediate 事件类型
- `web/src/pages/conversation/index.tsx`：三处 speak.intermediate handler（常驻通道/发送流/轮询流）
- prompts/skills：零改动——PR #290 已把 BIG_OTTER/SMALL_OTTER/otter-summon/RECRUITING_INTAKE 带到拆分态（这正是当初不一致的另一半）

### 逻辑变更

- 消息内容不再由单次 speak 原子写入，而是多次 appendSegment 增量累积；完整性由 yield 前置守卫 + completeMessage 的 isValidCompletedMessage 不变量双层保证
- startSpeaking 语义从"内容+路由一体"变为"纯路由移交"（内容职责已归 speak）

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | speak 重写 + yield 新增 |
| src/usecases/conversation/agent-turn-orchestrator/*.ts | 修改 | body 修复 + yield 命名/文案 |
| src/usecases/conversation/{send-message,conversation-repository,talking-stone,dispatch-guard}.ts | 修改 | body 可选化 + 文案 |
| src/frameworks/db/conversation/sqlite-conversation-repository.ts | 修改 | startSpeaking 空 body 跳过 INSERT |
| src/usecases/ports/otter-tool-client.ts | 修改 | startSpeaking params.body 可选化 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 修改 | speak.intermediate 发射 |
| api-contract/sse/events.ts | 修改 | 事件类型 |
| web/src/pages/conversation/index.tsx | 修改 | 前端 handler ×3 |
| tests/interface-adapters/speak-tool.test.ts | 重写 | 拆分语义 24 cases |
| tests/capability/helpers/model-visible.ts | 修改 | speakScript/yieldScript 两段脚本 |
| tests/capability/model-visible-parity.capability.test.ts | 修改 | 每轮两请求断言 |

## 验收结果

### 测试结果

- `npm test`：106 文件 / 1246 测试全绿（拆分前 1239）
- `npm run build`：通过
- 能力测试（真 LLM + 真 boot）：
  - talking-stone-routing：**3/3 成功**（子獭传回大獭不传 user）
  - model-visible-parity（录音网关确定性）：3/3 通过（speak→yield 两段协议全链路）
- 真实 LLM 行为观察（调试用例，已删）：大獭先试 yield 被守卫拦（"先 speak 再 yield"）→ speak → yield 成功交棒——守卫的即时反馈机制按设计工作

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 speak 纯输出 | 单元 + 真实 LLM 观察均符合 | ✅ |
| T2 yield 交棒 | 路由能力测试 3/3 | ✅ |
| T3 协议一致性 | parity 工具表断言 + 全局术语排查 | ✅ |
| T4 SSE body | aggregateBody 单元覆盖 + 待用户 UI 复验 | ❓（合并后 UI 复验） |

## 附带：文档门禁存量违规修复

pre-commit 的 lint:docs 被三处**已合入 PR 的存量违规**阻断（与本特性无关）：
- F20260817b3pr 文件路径与 ID 日期不匹配（08/18 → 08/17，git mv）
- F20260818drtc 缺 frontmatter（补齐）
- F20260818sgmt 缺 summary（补蒸馏摘要）

不修则任何 commit 无法通过门禁，随本 PR 一并带入。

## 对抗审视记录

- 调试运行发现 yield 空内容守卫被真实 LLM 触发并正确引导（先 speak 后 yield）——守卫从"防御性设计"变为"经过实战验证的即时反馈"
- create_otter 工具文案仍教旧协议（talkingStonePassedTo 在 speak 里）——真实 LLM 调试时发现，已修正（prompt↔工具描述不一致的同类问题）

## 设计决策

- **appendSegment 直落 vs 内存 buffer**：选直落。2c91fd3 原实现用 speakBodyBuffer 内存累积、yield 时拼接写入——回合中断（abort/api_error）内容全丢。segments 模型下每次 speak 即时落库，中断后消息带已有内容进终态，且天然支持多段拼接
- **yield 空内容守卫放工具层而非 complete 层**：completeMessage 的 isValidCompletedMessage 会 throw 并被 orchestrator 吞掉走 no_yield 重试（丢回合）；工具层报错让模型立即收到反馈、原地补救
- **speak.intermediate 从 invoker 发射而非工具内**：ToolContext 无 broadcaster 访问；invoker 的 onEvent 是所有工具事件的汇合点，借 tool_execution_end 携带的 details 标记发射，零新依赖
