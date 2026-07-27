---
id: F20260727guard
title: 文本生成退化检测与流式超时
doc_type: feature

# 记忆索引
summary: |
  在 Pi SDK message_update 事件流中检测重复内容，防止模型陷入退化重复输出循环（degenerate repetition loop）。
  同时增加流式超时检测，作为退化检测的兜底机制。

# 因果链路
causal_links:
  from:
    - F20260716bte2   # agent-circuit-breaker

# 元数据
status: development
change_type: feature
tags: [agent, output-guard, safety, streaming]
modules: [src/frameworks/agent/]

# 时间
created_at: 2026-07-27
---

## 问题场景

### 真实事故：对话 t001（2026-07-27）

**时间线：**

| 时间 | 事件 |
|------|------|
| 10:23:29 | 用户发送：`@大獭 小獭2号可以退场了；然后你重新拉一个架构师小獭进来...` |
| 10:23:42 | 第一次 LLM 调用完成（13秒），生成 2 个 tool call：`dissolve_otter` + `read` skill 文件 |
| 10:23:42 | 两个工具执行成功，第二次 LLM 请求发出（携带工具结果） |
| 10:23:42 ~ 10:44:24 | **模型进入退化重复输出循环，持续 21 分钟** |
| 10:44:24 | 用户手动点击中断 |

**退化输出详情：**

- 模型将同一段 5 句话重复了 **598 次**
- 总文本量：**414,234 字符（410KB）**
- 重复内容：
  ```
  Good, 小獭二号已退场。Now let me create the architect otter and have it review the feature document.
  Let me think about what this review involves:
  - This is a feature design document review (not code review)
  ...
  ```
- thinking 阶段正常（621 字符），text 阶段退化

**资源消耗：**
- 时间：21 分 22 秒
- Input tokens：31,183
- Output tokens：4,016（中断时计数）
- 估算成本：~$0.12

**为什么现有熔断器未触发：**

`ToolCallCircuitBreaker` 的 5 条检测规则全部只监控工具调用：
- B-1/B-2/B-5: 工具调用次数 → 未触发（第二次 LLM 调用未产生工具调用）
- B-3: 连续相同工具 → 同上
- B-3b: 滑动窗口循环 → 同上
- B-4: 执行时间超限 → **熔断器只在 `tool_execution_start` 事件时检查，纯文本生成不触发**

## 设计方案

### 核心思路

在 Pi SDK 的 `message_update` 事件流中监控文本增量，通过两种机制防止退化输出：

1. **片段重复检测**：累积文本按固定长度切片，检测相同片段是否超过阈值
2. **流式超时**：连续 N 秒无新内容则 abort，作为兜底

### 架构决策

**决策 1：实现位置**

| 方案 | 优点 | 缺点 |
|------|------|------|
| A: 修改 createEventHandler() | 集中在一个地方 | 混合了事件转发和安全监控职责 |
| B: 独立 session.subscribe() | 职责分离，与熔断器模式一致 | 多一次订阅 |

**选择**：方案 B。与 `attachCircuitBreaker` 模式一致，OutputGuard 是有状态的独立类，有自己的生命周期，不应塞入 `createEventHandler` 的闭包中。

**决策 2：流式超时与工具执行的交互**

问题：工具执行期间 `message_update` 事件停止，流式超时会误触发。

解决：OutputGuard 同时订阅 `tool_execution_start` 事件，在工具执行期间暂停超时计时器。工具执行结束后，下一个 `message_update` 自然恢复计时器。

**决策 3：检测算法**

使用固定长度片段的精确匹配：
- 片段长度 100 字符（默认）
- 每 20 个片段检查一次（避免频繁检查）
- 最新片段在历史中出现 50 次以上则触发

退化重复输出的特征是**完全相同的文本无限循环**，精确匹配足够且性能最优。

### 配置

```yaml
circuitBreaker:
  outputGuard:
    enabled: true           # 是否启用
    segmentLength: 100      # 片段长度（字符）
    maxRepeatedSegments: 50 # 重复多少次触发
    checkInterval: 20       # 每 N 个片段检查一次
  streamingTimeoutMs: 120000 # 流式超时（2分钟）
```

### 文件变更

| 文件 | 变更 |
|------|------|
| `src/frameworks/agent/output-guard.ts` | 新建：OutputGuard 类 + attachOutputGuard() |
| `src/frameworks/config-service.ts` | AppConfig 增加 outputGuard + streamingTimeoutMs |
| `config/config.yaml.example` | 增加配置示例 |
| `src/frameworks/agent/pi-session-factory.ts` | 集成 attachOutputGuard |
| `src/frameworks/agent/circuit-breaker-helpers.ts` | buildResult 增加 outputGuardMetadata |
| `src/interface-adapters/agent-runtime/agent-invoke-port.ts` | AgentRunResult 增加 outputGuardMetadata |
| `tests/frameworks/agent/output-guard.test.ts` | 新建：15 个测试用例 |

## 风险与缓解

**风险 1：合法重复内容的误触发**
- 默认配置（片段 100 字符 × 重复 50 次 = 5000 字符完全相同）在正常输出中极不可能出现
- 如需调整，可通过配置文件修改阈值

**风险 2：长时间工具执行导致超时误触发**
- 已通过 `pauseTimer()` 在 `tool_execution_start` 时暂停计时器
- 默认 2 分钟超时足够宽裕

**风险 3：性能影响**
- 每 20 个片段做一次比较，最多 50 次 100 字符字符串比较，开销可忽略
