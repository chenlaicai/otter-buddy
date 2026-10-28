---
id: F20261028hltab
title: "halt 首次送达接回执行终止，解开 busy 重启死锁（#1674）"
summary: "halt 原先只阻断工具，模型持续 speak 时 busy 永不释放且 restart 被拒；现首次送达接回既有 abort 收尾，保持上下文，不新增 force/超时机制。"
change_type: fix
capability_test: "n/a: A 类执行生命周期与确定性 abort 接线修复，无 prompt/LLM 行为触发语义改动"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-28T12:58:00+08:00
causal_links:
  from: [F20260826mwrd]
---

# 预注册

- 预期：忙碌守卫与 halt 状态独立，restart 未识别「halt 已送达但仍 busy」。
- 验证：源码与最小测试稳定复现 halt 送达后执行仍在运行。
- 反例：若 halt 已能退出只是状态未清，则修状态清理，不新增强制机制。

# 问题与根因

issue #1674 现场：目标獭收到 halt 后持续输出独白，restart 因 running invoke 409，只能 dissolve 重建。

根因：`haltToolCallGuard` 只生成工具级 block；speak 豁免让模型可以无限续轮，执行循环并未被强制结束。`restartWithUnifiedHandoff` 对 running invoke 的拒绝本身是正确的正常路径保护，不应绕过。

# 方案与设计取舍

首次 halt 送达在 per-invoke context 标记，并由 `attachGuards` 接回现有 `wrappedAbort('halt')`。这样沿用既有 invoke finally、active session 清理和 guard-abort 终态，不新增 force、TTL、后台任务或存储。

- 重复 block 幂等；普通未 halt 的忙碌 restart 仍拒绝。
- `halt` 不属于可自动重试的 guard 原因，终态明确「可改派或重启」。
- 不从 tool_call 扩展处理器 fire-and-forget `session.abort()`：SDK 会 waitForIdle，存在 Promise 自等待风险；处理器仅发同步 abort 请求。
- 覆盖 invoke 开始前已打标的入口窗口。
- 已发 speak 保留；abort 当刻尚未产生的「进度快照」不补造，重启/改派可从保留上下文继续。

机制检查：仅复用现有状态、函数与模块调用；无新增配置、生命周期、定时器、信号类型、持久化或新跨模块路径。修法决策树① narrow-fix。

# 验证

修前失败证据：`npx vitest run tests/usecases/signal/halt-core.test.ts` → 17 tests，**1 failed / 16 passed**；新增「halt 首次送达即请求结束本轮执行」用例中 running 仍 true。

修后：`npx tsc --noEmit` 通过；定向 5 文件 **102 passed**：halt-core、halt-injection-wiring、halt-lifecycle-927、retry-policy、circuit-breaker-helpers。

| 场景 | 操作 | 预期 |
|---|---|---|
| 首次 halt | 非 speak 工具边界送达 | block + 请求既有 abort，本轮退出 |
| 重复 halt | 同 invoke 再 block | 不重复 abort，不覆盖退出原因 |
| 未 halt | 正常工具调用 | 原行为不变 |
| halt 终态 | guardReason=halt | 不自动重试，明确可改派/重启 |

最简检查：复用现有 abort 与 invoke context，无新依赖；已过最简检查。

# 影响与负向验收

不放宽 restart busy 保护，不删除旧 session，不改变工具参数。Abort 是控制面停止，不撤销已完成的工具副作用。生产副本真启动不涉及（无 DB/schema 变更）；UI/Golden Gate 不适用（无 UI/prompt 变更）。
