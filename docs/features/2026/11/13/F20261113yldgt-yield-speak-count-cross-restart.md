---
id: F20261113yldgt
title: yield 拒绝文案戳破跨重启 speak 计数归零，引导补 speak 而不排查工具
summary: P1 回归 #1871 根因重新定性——不是 durable speak 未落账（持久化层无 bug），而是模型跨世重启/自动重试后把「历史里说过」误当本轮已发言，直接 yield 被计数器按 invoke 归零正确拒绝后，又去排查工具而非补一句 speak。修复只改 yield 拒绝文案与 description，戳破计数归零语义并给恢复指引。
change_type: fix
capability_test: tests/interface-adapters/agent-runtime/tools/yield-orphan-text.test.ts
tags: [session, yield, speak, tool-factory, cross-restart]
modules: [src]
created_at: 2026-11-13

intent:
  problem: "yield 门按「本轮 invoke 必须新 speak」计数，跨服务重启/自动重试后计数归零；模型却把历史发言误当本轮已发言，直接 yield 被拒后连续重试 yield 或去查代码/解散小獭，从不补 speak，invoke 最终 failed（#1871 实证：109 次工具调用、0 条 speak）"
  expected_effect: "yield 被拒时返回的报错明说「本轮 invoke 尚未落账 speak、计数在每次 invoke（含重启/重试）都会归零」，并指示补一次 speak 再 yield、勿排查工具；yield 工具 description 前端同步给出同一恢复指引"
  verify_by:
    type: behavior_check
---

# F20261113yldspk：yield 拒绝文案戳破跨重启 speak 计数归零

## 根因重定性（#1871）

初判「durable speak 可见但未落账」是错的。主库 `entries` + durable session 双库对账证实：

1. **所有成功执行的 speak 均落库**。抽查 `aed3b098`(seq6040)、`c01be7e9`(seq6048)、`d723c5c5`(seq6058) 三个 entryId/sequenceNum 与 speak 工具返回值一致。
2. **11-13 00:51–01:23 失败 invoke**（`214e7740`，109 次工具调用，failed「重试后仍未调用 yield」）全程 **0 条 speak**——不是 speak 丢了，是模型**根本没调 speak**：它 00:55:19 `create_otter` 建完小獭后直接连发 yield，被拒 3+ 次，随即钻牛角尖查代码、解散小獭、开 #1871，直至 invoke 崩掉。

结论：持久化层无 bug。失败因是**模型跨世重启后上下文残留「我已说过」的错觉**，yield 门正确拒绝；但报错文案太通用（「你还没有用 speak 输出任何内容」），模型不信、选择排查而非补 speak。

## 修复（最小化，不动计数逻辑/持久化）

- `src/interface-adapters/agent-runtime/tools/tool-factory.ts` `validateMessageHasContent` 兜底拒绝文案改为直击误判：明确「本轮 invoke 尚未落账 speak」+「speak 计数在每次 invoke（含服务重启/自动重试）都会归零」+「请在本轮再调用一次 speak(body) 输出结论，然后立刻再 yield；不要排查工具、不要重复空 yield」。
- `createYieldTool` description 前端加恢复指引一句：「若 yield 被拒『尚未落账 speak』，直接补一次 speak 再 yield，勿排查工具」。
- 回归测试 `yield-orphan-text.test.ts` 第二用例断言新文案（收紧：从 1 条 `toContain` 扩到 4 条锚点断言）。

## 验证

- `vitest run tests/interface-adapters/agent-runtime/tools/` 全量 27 文件 212 用例全绿（含 yield-orphan-text 2/2）。
- `npx tsc --noEmit` 0 错误。

## risk_note

只改提示文案与工具 description，无运行时行为/状态机变更；revert 即回滚。