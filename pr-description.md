## 问题描述

当前熔断器的 `maxToolCalls` 限制为 40，对于复杂任务（如代码分析、多文件处理、深度调试）来说过于严格，容易导致误杀。

## 决策转向说明

之前的 circuit-breaker-speak-steer-loop 事故修复（F20260728cbwt）明确记录"不动 maxToolCalls=40 额度：本次是误杀不是额度不足；额度调参属另一议题"。当时的设计决策是：先修复根因（speak 后 steer 注入导致 loop 复活），再单独处理额度调参。

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
- `docs/features/F20260810cb01-remove-maxtoolcalls-limit.md`：特性文档

## 测试

所有相关测试已通过（136 个测试）。

## 注意事项

- 真正的重复调用由连续相同检测和滑动窗口检测处理
- 复杂任务现在可以正常执行，不会被误杀
