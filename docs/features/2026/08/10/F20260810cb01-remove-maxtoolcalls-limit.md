---
id: F20260810cb01
title: remove-maxtoolcalls-limit
doc_type: feature
summary: |
  移除熔断器的 maxToolCalls 限制。根因：speak 重复调用幂等终结等根因修复已到位，
  maxToolCalls 限制不再需要——完全依赖重复检测机制。
status: implemented
change_type: fix
tags: [agent, circuit-breaker]
modules:
  - src/frameworks/agent/circuit-breaker.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260810cb01 移除熔断器最大工具调用限制

## 问题背景

当前熔断器的 `maxToolCalls` 限制为 40，对于复杂任务（如代码分析、多文件处理、深度调试）来说过于严格，容易导致误杀。

### 根本原因

原设计初衷是防止"重复"工具调用导致的无限循环，但 `maxToolCalls` 限制不区分是否重复，对正常工作调用次数也做了限制。

### 先前决策

circuit-breaker-speak-steer-loop 事故修复（F20260728cbwt）明确记录"不动 maxToolCalls=40 额度：本次是误杀不是额度不足；额度调参属另一议题"。当时的设计决策是：先修复根因（speak 后 steer 注入导致 loop 复活），再单独处理额度调参。

现在根因修复已到位（speak 重复调用幂等终结、熔断器不对 speak 注入 steer、abort 路径 speaking 守卫），本 PR 是额度调参的后续议题。

## 解决方案

**完全移除 maxToolCalls 限制**，完全依赖重复检测机制：

1. **保留**：连续相同调用检测（`maxConsecutiveIdentical=5`）
2. **保留**：滑动窗口检测（跨工具交替循环检测）
3. **移除**：`maxToolCalls` 和 `warningThreshold` 配置

### 为什么移除而不是提高

- 真正的"重复"（同一命令反复失败、同一编辑反复重试）会被连续相同检测捕获
- 真正的"循环"（A-B-C-A-B-C）会被滑动窗口检测捕获
- `maxToolCalls` 限制是"误杀"的根源，应该移除

## 修改文件

- `src/frameworks/agent/tool-call-circuit-breaker.ts`：移除 maxToolCalls 和 warningThreshold 配置
- `src/frameworks/config-service.ts`：移除配置加载逻辑
- `config/config.yaml.example`：更新配置示例和注释
- `tests/frameworks/agent/tool-call-circuit-breaker.test.ts`：移除相关测试
- `tests/frameworks/agent/circuit-breaker-helpers.test.ts`：移除相关测试
- `tests/frameworks/config-service.test.ts`：更新测试期望值

## 测试

所有相关测试已通过（136 个测试）。

## 决策记录

- **决策**：完全移除 maxToolCalls 限制
- **理由**：重复检测机制已足够覆盖真正的重复/循环场景，maxToolCalls 限制会误杀正常工作流程
- **决策者**：搭档
- **日期**：2026-08-10
