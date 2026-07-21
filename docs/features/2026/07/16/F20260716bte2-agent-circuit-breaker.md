---
id: F20260716bte2
title: Agent 执行熔断机制
doc_type: feature

# 记忆索引
summary: |
  在 agent 执行链路中增加熔断器，当工具调用行为超过预设阈值时强制介入终止。
  利用 AgentHarness 原生钩子实现零修改工具类的集中管理。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716t2ab   # tool-skill-mechanism

# 元数据
status: development
change_type: feature
tags: [agent, circuit-breaker, safety, harness]
modules: [src/frameworks/agent/]

# 时间
created_at: 2026-07-16
---

## 设计方案

### 核心思路

在 agent 执行链路中增加**熔断器（Circuit Breaker）**，当 agent 的工具调用行为超过预设阈值时，强制介入终止当前轮次。

### 架构决策

**决策 1：熔断器位置**

| 方案 | 优点 | 缺点 |
|------|------|------|
| A: 工具层（每个工具的 execute 方法） | 无需修改外部库 | 需要修改所有工具，逻辑分散 |
| B: 执行层（PiHarnessFactory.invoke 包装） | 集中管理，单一职责 | 需要 harness 提供回调或钩子 |
| C: 平台层（Snail Shell agent 执行循环） | 最彻底，可监控所有 agent | 需要修改 Snail Shell 平台代码 |

**选择**：方案 B（利用 harness 原生钩子）

经架构师-2 验证，`@earendil-works/pi-agent-core` 的 AgentHarness 原生支持以下机制：
- `harness.on('tool_call', handler)` 可返回 `{ block: true, reason }` 直接拦截工具调用
- `afterToolCall` 可返回 `{ terminate: true }` 直接终止轮次
- `harness.steer(text)` 在当前 assistant turn 结束后注入消息

**优势**：
- **零修改工具类**：不会遗漏新工具
- **单一职责**：熔断逻辑集中在 PiHarnessFactory
- **更安全**：不改变工具执行路径

方案 C 作为**长期目标**：推动 Snail Shell 平台增加通用熔断能力。

**理由**：方案 B 利用 harness 原生能力，无需修改工具类，更安全可靠。方案 C 是正确的长期方案，但需要跨团队协调。

**决策 2：熔断阈值**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxToolCalls | 40 | 单轮最大工具调用次数 |
| maxConsecutiveIdentical | 5 | 连续调用相同工具的最大次数 |
| maxExecutionTimeMs | 300000 (5min) | 单轮最大执行时间 |
| warningThreshold | 20 | 触发警告的工具调用次数 |

**理由**：
- 40 次工具调用覆盖设计阶段的大量搜索场景（search_memory、get_message、list_messages）
- 5 分钟超时平衡了复杂任务需求和资源保护
- 连续相同工具调用 5 次通常意味着 agent 陷入了重试循环

**决策 3：熔断触发行为**

| 阶段 | 行为 |
|------|------|
| 警告（warningThreshold） | 记录日志，继续执行 |
| 熔断（超过任一硬限制） | 向 agent 注入系统消息："你已调用工具 N 次，请立即调用 set_final_body 结束发言" |
| 强制终止（注入后仍继续） | 调用 harness.abort()，标记消息为 aborted |

**理由**：渐进式干预比直接终止更温和。给 agent 一次自我纠正的机会，避免误杀正常执行。

### 行为规格

| ID | 当...时 | 应该... | 追溯 |
|----|---------|---------|------|
| B-1 | agent 单轮工具调用次数达到 warningThreshold | 记录警告日志，包含 otterId、stageId、调用次数 | ← UA-2 |
| B-2 | agent 单轮工具调用次数超过 maxToolCalls | 向 agent 注入系统提示，要求立即调用 set_final_body | ← UA-1, UA-2 |
| B-3 | agent 连续调用相同工具超过 maxConsecutiveIdentical 次 | 向 agent 注入系统提示，指出重复调用模式 | ← UA-3 |
| B-3b | 最近 K 次工具调用中，相同工具组合（集合相等）重复出现 M 次 | 向 agent 注入警告，指出循环模式（检测算法：滑动窗口 K=6, M=3） | ← UA-3 |
| B-4 | agent 单轮执行时间超过 maxExecutionTimeMs | 调用 harness.abort()，标记消息为 aborted | ← UA-1, UA-2 |
| B-5 | agent 在收到熔断提示后仍继续调用工具（超过 maxToolCalls + 3） | 调用 harness.abort()，标记消息为 aborted | ← UA-1 |
| B-5b | steer() 注入后 agent 仍在同一 turn 中执行工具调用 | 以 wall-clock 时间为硬边界（从 steer 注入起算 30 秒），超时则 abort | ← UA-1 |
| B-6 | 熔断触发时 | 记录完整的调用历史到日志，用于事后分析 | ← UA-3 |
| B-7 | 熔断触发时 | 在消息元数据中记录熔断原因（tool_call_limit / timeout / repetition） | ← UA-2 |
| B-8 | 单轮 token 消耗超过 tokenWarningThreshold（默认 50k） | 记录警告日志；如事件系统不支持实时 token，降级为在 B-6 熔断日志中记录最终 token 消耗量 | ← UA-2 |

### 约束条件

| ID | 约束 | 原因 |
|----|------|------|
| C-1 | 熔断器配置必须可通过配置文件覆盖 | 不同部署环境可能需要不同阈值 |
| C-2 | 熔断器不得影响正常执行路径的性能 | 避免为了防护而降低正常任务的执行效率 |
| C-3 | 熔断事件必须有可观测的日志输出 | 便于运维监控和问题排查 |
| C-4 | 熔断器必须在 agent 轮次结束时重置 | 避免上一轮的状态影响下一轮 |

### 实现指引

**核心组件**：

1. **ToolCallCircuitBreaker**（新类）
   - 维护调用计数器、时间记录、重复检测、滑动窗口
   - 提供 `check(toolName)` 方法，每次工具调用时检查是否触发熔断
   - 提供 `reset()` 方法，轮次结束时重置状态
   - 提供 `getCallHistory()` 方法，返回调用历史用于日志
   - 实现 B-3b 滑动窗口检测（K=6, M=3）

2. **PiHarnessFactory 修改**
   - 在 `createHarness()` 中注册钩子：
     - `harness.on('tool_call', circuitBreakerGuard)` — 拦截工具调用
     - `harness.on('tool_result', circuitBreakerMonitor)` — 监控结果
   - B-2/B-3 熔断时调用 `harness.steer(text)` 注入提示
   - B-5 超过 maxToolCalls + 3 时返回 `{ terminate: true }` 终止轮次
   - B-5b steer 注入后 30 秒 wall-clock 超时 abort

3. **AgentInvoker 修改**
   - 在 `invokeConversation()` 开始时创建 CircuitBreaker 实例
   - 将 CircuitBreaker 传递给 PiHarnessFactory
   - 在 `invokeConversation()` 结束时记录熔断状态到消息元数据
   - B-8 记录最终 token 消耗量到日志

**配置注入**：

配置文件路径：`config/circuit-breaker.json`（或项目约定的配置目录）

```json
{
  "circuitBreaker": {
    "maxToolCalls": 40,
    "maxConsecutiveIdentical": 5,
    "maxExecutionTimeMs": 300000,
    "warningThreshold": 20,
    "slidingWindowSize": 6,
    "slidingWindowRepeat": 3,
    "steerTimeoutMs": 30000,
    "tokenWarningThreshold": 50000
  }
}
```

配置加载逻辑：启动时读取配置文件，合并默认值，运行时不可热更新。

## 不兼容更新

无。此变更为新增功能，不改变现有行为。

## 验收标准

| ID | 标准 | 验证方法 |
|----|------|---------|
| AC-1 | 工具调用次数超过 maxToolCalls 时，agent 收到熔断提示 | 单元测试：mock harness，验证注入消息内容 |
| AC-2 | agent 收到熔断提示后仍继续调用，被强制终止 | 单元测试：验证 harness.abort() 被调用 |
| AC-3 | 执行时间超过 maxExecutionTimeMs 时，agent 被终止 | 单元测试：使用 setTimeout 模拟超时 |
| AC-4 | 连续调用相同工具超过阈值时，agent 收到警告 | 单元测试：连续调用相同工具，验证注入消息 |
| AC-5 | 熔断事件有日志输出 | 手动验证：检查日志格式和内容 |
| AC-6 | 熔断器配置可通过配置文件覆盖 | 手动验证：修改配置文件后重启，检查行为 |
| AC-7 | 正常执行不受熔断器影响 | 集成测试：正常任务完成不触发熔断 |
| AC-8 | 跨工具交替循环被检测到（B-3b） | 单元测试：模拟 A-B-C-A-B-C 模式，验证触发警告 |
| AC-9 | steer() 注入后 wall-clock 超时生效（B-5b） | 单元测试：模拟 steer 后 agent 继续执行，验证 30 秒后 abort |
| AC-10 | token 消耗记录在熔断日志中（B-8） | 手动验证：检查熔断日志包含 token 消耗信息 |

## 决策记录

| 日期 | 决策 | 正方论点 | 反方论点 | 最终选择 |
|------|------|---------|---------|---------|
| 2026-07-16 | 熔断器实现位置 | harness 原生支持 on('tool_call') 和 steer()，零修改工具类 | 平台层更彻底，但需要跨团队协调 | 利用 harness 钩子（快速交付），长期推动平台层 |
| 2026-07-16 | 熔断触发行为 | 渐进式干预（警告→提示→终止）更温和 | 直接终止更简单，避免 agent 无视提示 | 渐进式（给 agent 自我纠正机会） |
| 2026-07-16 | 默认阈值选择 | 40次/5分钟覆盖设计阶段大量搜索场景 | 可能需要根据实际场景调整 | 采用默认值 40，支持配置文件覆盖 |
| 2026-07-16 | steer 超时边界 | steer() 语义是 turn 结束后注入，需 wall-clock 硬边界 | 增加复杂度 | 30 秒 wall-clock 超时，从 steer 注入起算 |
