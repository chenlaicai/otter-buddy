---
id: F20260826d464
title: dissolve-duplicate-signature-fix
doc_type: feature
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
summary: |
  修复 ToolCallCircuitBreaker 批量解散/重启小獭时误报"重复调用"的问题。
  buildToolSignature 对 dissolve_otter/restart_otter/create_otter 未区分实体 ID，
  导致批量操作被连续相同签名计数器误判为卡壳循环。
tags: [circuit-breaker, tool-signature, dissolve, batch-ops]
modules: [src/frameworks/agent/tool-call-circuit-breaker.ts, tests/frameworks/agent/tool-call-circuit-breaker.test.ts]
status: development
created_at: 2026-08-26
---

# F20260826d464 - 批量解散小獭误报"重复调用"修复

## 1. 问题现象

### 1.1 事故现场（大獭 8/25 实证）

8/25 11:16 大獭两波 issue 处理收尾，批量解散 8 只小獭（4 开发 + 4 检视）：
- 8 只小獭全部 dissolve 成功，每只均有 dissolved 确认
- worktree list 干净、分支零残留
- 但系统连续 **8 次**提示「重复 dissolve_otter 调用」，与事实不符

### 1.2 影响

- 误导编排獭判断：大獭被迫额外花轮次核实真实解散状态
- 批量解散场景（≥4 只）是每日 issue 处理的常态路径，误报会持续出现

## 2. 根因分析

### 2.1 定位

**根因文件**：`src/frameworks/agent/tool-call-circuit-breaker.ts`  
**根因函数**：`buildToolSignature()`（第 138 行起）

### 2.2 机制

`ToolCallCircuitBreaker` 通过 `buildToolSignature()` 构建工具调用的行为签名，
判断是否为"连续相同调用"（卡壳检测）。

**原逻辑**：`dissolve_otter`、`restart_otter`、`create_otter` 没有签名区分逻辑，
`buildToolSignature()` 直接返回工具名（如 `"dissolve_otter"`），无论传入什么 `otterId`。

**后果**：批量解散 8 只小獭时，熔断器看到 8 次连续相同签名 `"dissolve_otter"`。
`maxConsecutiveIdentical` 默认值为 5，第 6 次起触发 steer 警告：
`Consecutive identical call "dissolve_otter" 6 times. Break the pattern.`

该 steer 消息注入 `session.steer()` 后，AI 将其解读为"重复调用"提示并输出给大獭。

### 2.3 为什么之前没发现

- 批量解散 1-2 只时不会触发（低于阈值 5）
- 3 只以下偶尔触发但被忽略
- 8/25 首次出现 8 只批量解散场景，问题才暴露

## 3. 修复方案

### 3.1 代码变更

**文件**：`src/frameworks/agent/tool-call-circuit-breaker.ts`  
**位置**：`buildToolSignature()` 函数（约第 148 行）

为 `dissolve_otter`、`restart_otter` 添加 `otterId` 参数区分：
```typescript
if (toolName === "dissolve_otter" || toolName === "restart_otter") {
  const id = a.otterId;
  return typeof id === "string" && id ? `${toolName}: ${id}` : toolName;
}
```

为 `create_otter` 添加 `name` 参数区分：
```typescript
if (toolName === "create_otter") {
  const name = a.name;
  return typeof name === "string" && name ? `${toolName}: ${name}` : toolName;
}
```

### 3.2 测试验证

**新增测试用例**（`tests/frameworks/agent/tool-call-circuit-breaker.test.ts`）：

| 测试 | 验证点 |
|------|--------|
| `dissolve_otter 签名含 otterId` | 不同 otterId 产生不同签名 |
| `dissolve_otter 无 otterId 时退化为工具名` | 参数缺失时不崩溃 |
| `restart_otter 签名含 otterId` | restart 同理 |
| `create_otter 签名含 name` | create 同理 |
| `批量解散 8 只 otter 不误报` | 回归测试：8 次连续 dissolve 全部 allow |
| `真正重复解散同一只 otter 仍能检测` | 边界：卡壳检测不丢失 |

### 3.3 验证结果

```
Test Files  1 passed (1)
Tests  33 passed (33)
```

全部 33 个测试通过（含 6 个新增 + 27 个原有），agent/ 目录 193 个测试无回归。

## 4. 影响范围

### 4.1 修复范围

- `buildToolSignature()`：新增 3 个工具签名逻辑
- 仅影响签名构建，不影响熔断逻辑本身

### 4.2 顺带核查

排查了其他可能受影响的工具：
- `yield`：已有独立处理（line 126），无需修改
- `get_active_participants`：只读查询，连续调用不太可能（且无区分参数）
- 其他工具：无批量场景，暂不处理

## 5. 回归防护

- 测试覆盖：批量解散 8 只 + 真重复检测 + 无参数退化
- 不改变现有签名逻辑：bash/read/write/edit/speak 签名不变
- 熔断阈值和行为不变
