---
id: F20260909csfx
title: 压缩钩子合成 otterId 修复——bootstrap 写死 "current" 致自定义七段算法必现降级
summary: F20260903cmpk 上线后首次真实压缩触发（2026-09-09 10:16:56，348.9K token 到线）暴露必现 bug——bootstrap 把字面量 "current" 当 otterId 注入合成闭包，session restore 抛 "No session or config found"，自定义七段算法 100% 降级 Pi 默认。修复：钩子触发时从 otterInvokeStorage 取真实 otterId 透传合成闭包。
change_type: fix
created_in_conversation: 4dce2a9e-3935-43a2-95cc-c08a8993ac1a
capability_test: "n/a: 修复是参数透传链路（bootstrap→registry→hook→invoker），单测覆盖 otterId 透传断言 + null 降级分支；端到端已由 F20260903cmpk capability 用例覆盖钩子落盘链路"
intent:
  problem: "压缩钩子合成走完整 invoke 链路（session restore/模型解析/工具装配全依赖真实 otterId），但 bootstrap 注释误判「otterId 仅用于记日志」写死占位符，导致自定义算法上线 6 天从未真正运行过"
  expected_effect: "threshold 压缩触发时日志出现 [compaction-hook] custom synthesis adopted（此前只会出现 synthesis failed）；otterId 为 null 的异常态降级放行 Pi 默认且不调合成"
from:
  - F20260903cmpk
---

# 压缩钩子合成 otterId 修复

## 背景与发现经过

搭档问「最近几天是否有触发压缩，替代算法效果如何」。排查发现：

1. **首次真实触发发生在 2026-09-09 10:16:56**（#770 上线第 6 天）：大獭在 signal-convergence 开发会话水位涨到 348,862 token（kimi 窗口 1M − reserve 700K = 348,576 触发线），threshold 原因触发，`agent_compaction_total{reason="threshold"}` +1。
2. **自定义算法 100% 失败**：日志 `[compaction-hook] synthesis failed, falling back to Pi default`，error = `No session or config found for otter: current. Call create() first.`。
3. **降级兜底完整生效**：Pi 默认算法接管，348.9K → 52.6K token（6.6x），六段式摘要落盘（session jsonl compaction 条目 `fromHook: false`），质量抽查合格（F 文档号/commit hash/守卫教训均保留）。

## 根因

`src/bootstrap/platforms.ts:231` 把字面量 `"current"` 当 otterId 写死：

```ts
agentGateway.setCompactionSynthesis((prompt) => agentInvoker.buildCompactionSynthesisFn("current")(prompt));
```

原注释假设「otterId 仅用于记日志」——实际 `buildSynthesisFunction` 内部走 `agentInvoke.invoke(otterId, ...)` 完整链路：session restore（`session-restore.ts:54` 抛错点）、模型解析、工具装配全部依赖真实 otterId。占位符在第一步 restore 就炸，异常被钩子 catch 降级——**只要压缩触发，自定义算法必现失败**，前 6 天未触发所以未暴露。

#770 的 capability e2e 测的是钩子→Pi 落盘链路（假模型、直传自定义结果），没走合成闭包，故未覆盖此回归。

## 修复

otterId 真实来源：压缩必在某次 invoke 中途触发（Pi 在 LLM 响应前检查阈值），此时 `otterInvokeStorage` 必有当次 invoke 的 otterId——钩子里已用它取 displayName，同一条通道。

- `compaction-hook.ts`：`CompactionHookDeps.synthesize` 签名改 `(otterId, prompt)`；`handleSessionBeforeCompact` 新增 `otterId` 参数，为 null 时降级放行（防御 store 缺失异常态，留 warn 日志）
- `model-runtime-registry.ts`：钩子 handler 从 store 取 `otterId` 传入
- `pi-session-factory.ts`：`setCompactionSynthesis` 签名同步
- `platforms.ts`：占位符删除，闭包透传 otterId；注释替换为事故教训

## 验证

- 单测 10/10（新增 2 断言：otterId 透传等值检查 + null 降级不调合成）
- capability e2e 1/1（F20260903cmpk 存量用例回归）
- 全量 3124/3124，tsc 0 错，eslint 0 错
- 下次真实压缩触发时验证日志 `[compaction-hook] custom synthesis adopted`（纳入每周一「上下文管理机制观察」任务既有检查清单）

## 影响面

- 行为变化：threshold 压缩摘要从「必现 Pi 默认」恢复为「七段合成优先、失败降级 Pi 默认」的设计本意
- 无 schema/API 变更；存量 session 不受影响
- 每周一观察任务（id 25ac8b80）口径不变，下次触发即首次真正验证七段算法
