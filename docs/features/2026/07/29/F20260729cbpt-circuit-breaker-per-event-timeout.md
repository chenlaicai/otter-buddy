---
id: F20260729cbpt
title: circuit-breaker-per-event-timeout
doc_type: feature

summary: |
  熔断器去掉 invocation 级总超时（maxExecutionTimeMs），改为 per-event 超时
  （maxPerEventTimeMs，默认 10 分钟），通过 resettable timer 实现：每次
  tool_execution_start 重置计时器，超时触发 circuit_break:event_timeout。
  同时区分 UI 消息：超时 →「单次工具调用超时」，循环 →「工具调用异常循环」。

causal_links:
  from:
    - F20260728cbwt   # 事件驱动两档制改造（引入 maxExecutionTimeMs 作为 B-4 规则）

status: final
change_type: bugfix
tags: [circuit-breaker, timeout, per-event, ui-message]
modules:
  - src/frameworks/agent/tool-call-circuit-breaker.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/frameworks/config-service.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - config/config.yaml.example
  - tests/frameworks/agent/tool-call-circuit-breaker.test.ts
  - tests/frameworks/agent/circuit-breaker-helpers.test.ts
  - tests/interface-adapters/agent-invoker.test.ts

created_at: 2026-07-29
---

# F20260729cbpt 熔断器 per-event 超时改造

## 术语定义

| 术语 | 定义 |
|------|------|
| **invocation 超时（已移除）** | 旧机制 B-4：从 session 创建起计，总耗时超过 `maxExecutionTimeMs`（默认 5 分钟）即 terminate。配置键 `maxExecutionTimeMs` 同步移除 |
| **per-event 超时** | 新机制：每次 `tool_execution_start` 启动/重置 resettable timer，单次工具调用超过 `maxPerEventTimeMs`（默认 10 分钟）即 abort |
| **resettable timer** | `circuit-breaker-helpers.ts` 中的 `setTimeout`，每次工具调用开始时 clear 旧 timer + set 新 timer |

## 事故现象

2026-07-29 03:01（本地），对话 **t002** 中搭档让大獭回到主线继续工作（确认 package-lock.json diff 并提 PR）。03:07:06，大獭被中断，用户侧消息：

```
[系统保护] 检测到工具调用异常循环，已自动中断。
```

关键事实（session 转录逐条核对）：

1. 大獭 12 次工具调用，**每条命令都不同**（read skill → git status → git log → git branch → git checkout → git worktree → npm install → git diff）——正经的开发准备流程，不是死循环。
2. 耗时约 5 分 8 秒（03:01:58 → 03:07:06），刚好超过 `maxExecutionTimeMs: 300_000`（5 分钟）。
3. 触发的是 `checkExecutionTimeout`（B-4 规则），不是行为循环检测（B-3/B-3b），但 UI 消息一视同仁地显示「检测到工具调用异常循环」，用户无法区分原因。

这是 t002 对话第三次被熔断器中断。前两次（F20260728cbtf、F20260728cbwt）修的是误报（工具名字段 bug、steer 死线），本次是超时阈值过短 + 消息不区分。

## 根因分析

### 根因一：invocation 级超时语义错误

`maxExecutionTimeMs` 限制的是整次 invocation 的总耗时，而非单次工具调用的耗时。但 agent 做复杂任务（读 skill、创建 worktree、npm install）时，总耗时自然超过 5 分钟——这不是「挂死」，是「任务复杂」。真正的挂死保护应针对**单次工具调用卡住不返回**，而非总耗时。

### 根因二：UI 消息不区分

`buildAbortBody` 对所有 `[circuit-breaker]` 前缀返回同一条消息「检测到工具调用异常循环」，无论是超时、连续相同、还是滑动窗口。用户看到这条消息会以为 agent 在死循环，实际上 agent 在正常工作。

## 变更

### 设计：per-event 超时

去掉 invocation 级 `checkExecutionTimeout`（从 `ToolCallCircuitBreaker` 中删除 B-4 规则、`startTime` 字段、`maxExecutionTimeMs` 配置），改为在 `attachCircuitBreaker` 中实现 per-event 计时器，只计单次工具执行时间：

```
每次 tool_execution_start 事件：
  1. clear 旧 timer（如有）
  2. set 新 timer = setTimeout(() => doAbort("circuit_break:event_timeout"), maxPerEventTimeMs)
  3. 继续走熔断器 check 逻辑

每次 tool_execution_end 事件：
  → clear timer（工具执行完成，停止计时）

timer 触发（工具执行超时）：
  → doAbort("circuit_break:event_timeout")

unregister 时：
  → clear timer
```

- **只计执行时间**：timer 在 `tool_execution_start` 启动，在 `tool_execution_end` 清除。LLM 两次工具调用之间的思考时间不计入——只有单次工具实际执行超过阈值才触发
- **针对单次调用**：如果某次工具调用卡住不返回（如 npm install hang），10 分钟后触发 abort
- **最后一次调用也覆盖**：如果最后一次工具调用超时，timer 自然触发 abort（无需等到下一次事件）
- **与熔断器解耦**：超时逻辑不在 `ToolCallCircuitBreaker` 类中，而是在事件层（`circuit-breaker-helpers.ts`），职责清晰

### UI 消息区分

`buildAbortBody` 按 abort reason 细分：

| reason | UI 消息 |
|--------|---------|
| `circuit_break:event_timeout` | 「[系统保护] 单次工具调用超时，已自动中断。」 |
| `circuit_break:ignored_steer` / `circuit_break:tool_call_limit` | 「[系统保护] 检测到工具调用异常循环，已自动中断。」 |

### 代码

- **tool-call-circuit-breaker.ts**：删除 `checkExecutionTimeout()`、`startTime` 字段、`maxExecutionTimeMs` 配置；新增 `maxPerEventTimeMs` 配置（默认 600_000）
- **circuit-breaker-helpers.ts**：`attachCircuitBreaker` 中新增 per-event timer 逻辑（`tool_execution_start` 启动、`tool_execution_end` 清除）；terminate 路径和 unregister 时清除 timer；导出 `clearEventTimer` 供外部 abort 使用
- **pi-session-factory.ts**：`_attachGuards` 中 `wrappedAbort` 调用 `clearEventTimer`，确保 OutputGuard/用户 abort 时 timer 不泄漏
- **config-service.ts / config.yaml.example**：`maxExecutionTimeMs` → `maxPerEventTimeMs: 600000`
- **agent-invoker.ts**：`buildAbortBody` 中 `[circuit-breaker]` 分支按 reason 细分消息

### 新旧配置映射

| 旧 | 新 | 说明 |
|----|----|------|
| `maxExecutionTimeMs: 300_000` | `maxPerEventTimeMs: 600_000` | 语义从「invocation 总超时 5 分钟」变为「单次工具调用超时 10 分钟」，无兼容桥 |
| B-4 `checkExecutionTimeout` | per-event timer（circuit-breaker-helpers） | 从熔断器类中移出，改为事件层 per-event timer（start→end） |
| `circuit_break:timeout`（trigger） | `circuit_break:event_timeout` | trigger 名变更 |

## 设计决策

1. **去掉 invocation 超时 vs 提高阈值**：搭档拍板去掉 invocation 级超时，改为 per-event。理由：invocation 总耗时不是挂死信号，单次工具调用卡住才是；10 分钟对任何单次操作都足够，但不对总任务时长设限。
2. **超时逻辑放在 circuit-breaker-helpers vs ToolCallCircuitBreaker 类**：放在 helpers 的事件层。理由：per-event timer 是事件驱动的时序逻辑，不属于熔断器的「行为模式检测」职责；类只管签名/连续/滑窗，timer 在 subscribe 回调中管理。
3. **UI 消息区分 vs 统一消息**：按 reason 细分。理由：用户（搭档）反馈看不出是超时问题，无法判断是否需要调整配置或报告 bug。
4. **只计工具执行时间 vs 含 LLM 思考时间**：只计 `tool_execution_start` → `tool_execution_end` 之间的执行时间。理由：resettable timer 在 start 重置会把 LLM 思考时间也计入（思考 9 分 59 秒 + 工具执行 1 秒 = 超时），语义不精确；`tool_execution_end` 清除 timer 后，只有单次工具实际执行超时才触发。
5. **`wrappedAbort` 清除 timer**：外部 abort（OutputGuard/用户）时立即清除 per-event timer，避免 timer 泄漏。通过 `timerRef` 延迟引用模式实现（`wrappedAbort` 定义在 `attachCircuitBreaker` 之前，`timerRef.clear` 赋值在之后，JavaScript 单线程保证安全）。

## 测试

- 删除 1 个旧 invocation 超时测试（`checkExecutionTimeout` 已移除）
- 新增 5 个 per-event 超时测试：
  - 单次工具执行超时触发 `circuit_break:event_timeout`
  - `tool_execution_end` 清除 timer，LLM 思考时间不计入
  - 单次工具执行超过阈值即触发（不含思考时间）
  - `unregisterToolCall` 后 timer 不再触发
  - `clearEventTimer` 可由外部调用清除 timer
- 新增 1 个 agent-invoker 测试：`circuit_break:event_timeout` 呈现「单次工具调用超时」文案
- `npm run build` 编译通过；`npm test` 全量 697 个测试通过
