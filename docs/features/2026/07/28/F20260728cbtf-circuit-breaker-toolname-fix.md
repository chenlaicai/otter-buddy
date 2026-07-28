---
id: F20260728cbtf
title: circuit-breaker-toolname-fix
doc_type: feature

summary: |
  修复工具调用熔断器从 pi-coding-agent SDK 事件取工具名时字段名取错的 bug：
  circuit-breaker-helpers 读取 e.name，但 SDK tool_execution_start 事件的字段是
  toolName，导致所有调用被记为 "unknown"，连续相同工具检测必然误报，steer 死线
  最终误杀健康调用（事故现场：对话 t002，详见 R20260728cbfx）。
  修复为 e.toolName ?? e.name ?? "unknown"，并补 attachCircuitBreaker 集成路径测试。
  顺带修复 CI PR 标题校验：支持 R 开头（research 类 PR）。

causal_links:
  from:
    - F20260716bte2   # agent-circuit-breaker（熔断器引入，bug 源头）
    - F20260727guard  # OutputGuard（误杀的对外呈现路径）
    - R20260728cbfx   # 事故排查报告（根因分析）

status: final
change_type: bugfix
tags: [circuit-breaker, pi-sdk, tool-call, steer, ci, incident-fix]
modules:
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - tests/frameworks/agent/circuit-breaker-helpers.test.ts
  - .github/workflows/ci.yml

created_at: 2026-07-28
---

# F20260728cbtf 熔断器工具名字段取错修复

## 术语定义

| 术语 | 定义 |
|------|------|
| **tool_execution_start** | pi-coding-agent SDK 在工具开始执行时派发的事件，载荷为 `{ type, toolCallId, toolName, args }` |
| **B-3 连续相同检测** | 熔断器规则：同一工具连续调用超过 `maxConsecutiveIdentical`（默认 5）次即注入 steer |
| **steer 死线（B-5b）** | steer 注入后起算的 30s wall-clock 硬边界，到期强制 abort |
| **attachCircuitBreaker** | circuit-breaker-helpers 中把熔断器挂到 session 事件流的装配函数 |

## 背景

对话 t002（2026-07-28）中，大獭执行「确认 git diff 并提 PR」任务时被「[系统保护] 输出异常，已自动中断」误杀。完整事故现象、证据链与根因分析见排查报告 **R20260728cbfx**（docs/research/）。

### 根因（一句话）

`attachCircuitBreaker` 订阅 SDK 事件时读 `e.name`，而 SDK `tool_execution_start` 事件的工具名字段是 **`toolName`**——取值恒为 `undefined`，每次工具调用都被记为 `"unknown"`，B-3 连续相同检测因此必然误报，steer 死线在模型正常生成长文本期间强制 abort 了健康调用。

同进程内 `agent-invoker.ts` 对同一事件的取值写法是 `e.name ?? e.toolName`（正确），两处不一致说明该 hook 编写时未对照 SDK 实际事件形状验证，且此前只有 breaker 单元测试、没有覆盖事件装配路径的集成测试。

## 变更

### circuit-breaker-helpers.ts

```ts
// 修复前
const e = event as { type?: string; name?: string };
circuitBreaker.check(e.name ?? "unknown");

// 修复后（toolName 为 SDK 实际字段，name 保留为兼容兜底）
const e = event as { type?: string; toolName?: string; name?: string };
circuitBreaker.check(e.toolName ?? e.name ?? "unknown");
```

### tests/frameworks/agent/circuit-breaker-helpers.test.ts（新增）

补上此前缺失的装配层测试面——直接以 SDK 事件形状驱动 `attachCircuitBreaker`：

| 场景 | 预期 |
|------|------|
| SDK 事件下 bash/read/edit 交替 12 次（事故场景复现） | 不 steer、不 abort，history 记录真实工具名 |
| SDK 事件下同名单工具连续 4 次（阈值 3） | steer 一次，reason 含真实工具名 |
| 旧版 `name` 字段事件 | 兼容，history 记录正确 |
| 字段均缺失 | 兜底 `"unknown"` |
| 超 maxToolCalls + 3 | terminate，调用 abort |

### .github/workflows/ci.yml

PR 标题校验正则从 `^\[F[0-9]{8}...` 扩展为 `^\[[FR][0-9]{8}...`，支持 research 类 PR 以 R 编号开头（如 `[R20260728cbfx] …`），并同步更新报错提示与示例。当前仓库已存在 F（feature）与 R（research）两类编号文档，CI 此前只认 F。

## 设计决策

**为什么 `toolName` 在前、`name` 兜底，而不是与 agent-invoker 的 `e.name ?? e.toolName` 顺序对齐？**

SDK 类型定义（`ToolExecutionStartEvent`）中只有 `toolName`，`name` 在任何已发布版本的事件中都不存在——agent-invoker 的写法历史上能工作纯属兜底的运气。修复后以真实字段优先，语义更诚实；`name` 保留仅为防御未知旧事件源，不影响行为。

**为什么本次不一起修 steer 死线语义问题？**

「模型听从 steer 停止调工具、转入长文本生成时 30s 死线照样触发」是另一处设计缺陷（惩罚的正是 steer 想诱导的行为），但修法涉及行为取舍（何时 clearSteerDeadline、与 OutputGuard 流式超时的分工），已在 R20260728cbfx 的遗留问题中记录，单独立项处理。本次只修确定性的字段名 bug，把误报源头掐掉后，死线缺陷的触发概率也随之大幅下降。

## 测试

- `npm run check`（lint + tsc）通过
- `npx vitest run` 全量 607 个测试通过（含新增 5 个）
