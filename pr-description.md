## 问题描述

当前熔断器的 `maxToolCalls` 限制为 40，对于复杂任务（如代码分析、多文件处理、深度调试）来说过于严格，容易导致误杀。

## 决策转向说明

之前的 circuit-breaker-speak-steer-loop 事故修复（F20260728cbwt）明确记录"不动 maxToolCalls=40 额度：本次是误杀不是额度不足；额度调参属另一议题"。当时的设计决策是：先修复根因（speak 后 steer 注入导致 loop 复活），再单独处理额度调参。

现在根因修复已到位（speak 重复调用幂等终结、熔断器不对 speak 注入 steer、abort 路径 speaking 守卫），本 PR 是额度调参的后续议题。

## 解决方案

1. **提高限制**：将 `maxToolCalls` 默认值从 40 提高到 200
2. **保留重复检测**：继续保留连续相同调用检测（`maxConsecutiveIdentical=5`）和滑动窗口检测
3. **调整配置**：更新配置文件和默认值

## 修改文件

- `src/frameworks/agent/tool-call-circuit-breaker.ts`：更新默认配置
- `src/frameworks/config-service.ts`：更新配置加载默认值
- `config/config.yaml.example`：更新配置示例和注释
- `tests/frameworks/config-service.test.ts`：更新测试期望值

## 测试

所有相关测试已通过（143 个测试）。

## 注意事项

- `maxToolCalls` 限制作为最后安全网保留，防止真正的无限循环
- 真正的重复调用由连续相同检测和滑动窗口检测处理
- 复杂任务现在可以正常执行，不会被误杀
- warningThreshold=20 仅触发日志，steer 从 maxToolCalls+1（201）才开始，call 21-200 之间的 180 次调用由 consecutive/sliding-window 规则保护
