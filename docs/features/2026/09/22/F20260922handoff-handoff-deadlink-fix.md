---
id: F20260922handoff
title: "压缩=交接链路三处死链修复：readCurrentSessionEntries/acquireSessionLock 实现 + 水位状态写回复活"
type: BugFix
module: agent
created: 2026-09-22
summary: "压缩=交接链路三处死链修复：端口方法实现 + 水位状态写回复活"
created_in_conversation: c619e648-e98b-4ea0-9b8d-b2a5cea3865d
causal_links:
  - F20260920uhuc
---

# F20260922handoff：压缩=交接链路三处死链修复

## 问题

F20260920uhuc「压缩=交接」统一重构合入（#1049）后，三条链路死锁导致**叙事合成从未被尝试、水位交接从未触发**——全部产出机械档案：

1. **致命①**：`readCurrentSessionEntries` 在 `SdkInvokePort` 声明可选（sdk-invoke-port.ts:112），`agent-invoker.ts:986` 用 `?.` 消费，但唯一实现体 `PiSessionFactory` 没有该方法 → jsonl 切片永远为空 → 合成分支永远不进。
2. **致命②**：`setLastCtxTokens`（handoff-support.ts:24）全仓库零调用。#886 删掉唯一调用（当时时机权在 Pi 钩子），#1049 把时机权收回 invoke 边界改读 `getLastCtxTokens`，忘了把 setter 接回去 → 水位触发器从未触发。
3. **伴生③**：`acquireSessionLock`（sdk-invoke-port.ts:110）同样声明可选但实现体缺失 → 交接冻结窗口静默跳过。②修活后即成并发竞态隐患。

测试为何没拦住：单测注入的 mock port 自带这些方法，TS 结构类型对「实现体缺可选方法」沉默——「mock 掩盖生产接线」经典案例。

## 修复

修法排序①（既有机制语义内修，无新增机制）。Modification-Class: narrow-fix。

### ① `PiSessionFactory.readCurrentSessionEntries`（pi-session-factory.ts）

- 池内已有 live sessionManager 时直接用（`poolMeta.get(otterId).session.sessionManager`），避免重复 open 句柄。
- 池外（交接时旧世 session 可能已不在池）走 `sessionRestore.restoreOrCreate` 只读打开 jsonl。
- 喂给已有的 `readSessionEntries`（session-slicer.ts——SessionManager.open 只读，getEntries 无写放大）。
- 任何失败 warn + 返回 undefined（调用方降级机械档案，D9 同源）。

### ② `PiSessionFactory.acquireSessionLock`（pi-session-factory.ts）

- 取 invoke 同源的 `lockManager.acquire("session:<otterId>")`——交接窗口与 invoke 互斥的真实保障。
- 取锁前 `setHandoffMode(key, true)`（交接模式 waiter 超时延长至 120s），**复位放在返回的 release 闭包内**（release 时先复位 handoffMode 再放锁）——交接模式覆盖整个持锁期。⚠️ 首版曾把复位放外层 `finally`，在 acquire 返回瞬间复位，交接窗口内 waiter 仍是默认 30s 超时（「交接窗口假超时」语义反转）——大獭终审打回，已修（commit 2）。
- acquire 抛错路径：`acquired` 标志判定，未拿到锁时 finally 复位 handoffMode，防泄漏。
- 交接窗口期间该獭 invoke 全部锁排队（冻结语义），交接完成释放后由新世消化。

### ③ `setLastCtxTokens` 写回（agent-invoker.ts）

- `createAttemptDriver` 增加 `ctxTokensBox` 旁路盒：`driver.invoke` 拿到 `result.ctxTokens` 写入盒中（`TurnResult` 不带 ctxTokens 字段，闭包直改外部 let 不可行）。
- `invokeConversationInner` 收尾处（`runWithTrace` 闭包内、return 前）读 `(driver as {_lastCtxTokens?})._lastCtxTokens`，有限值则 `handoffState.setLastCtxTokens(otterId, v)`。
- 数据源：`buildPromptResult`（circuit-breaker-helpers.ts）已从 session jsonl 末条 assistant usage 提取 ctxTokens，同右栏 invoke.tick 实时口径。
- 边界：换世后首 invoke 无 usage（新 session）→ ctxTokens 缺失 → 不写回 → 下轮不触发水位（自然语义，新世上下文为空）。熔断/自重启递归路径由递归 invoke 自身写回，外层跳过无害。

## 回归测试（防复发）

- `tests/frameworks/agent/handoff-deadlink-smoke.test.ts`：**真实 PiSessionFactory 实例**（真 schema DB，不 mock port）断言 `readCurrentSessionEntries` / `acquireSessionLock` 存在且为函数——生产装配再漏接线此处直接红。另覆盖无 session 獭返回 undefined、锁取放闭环。
- `tests/interface-adapters/agent-invoker.test.ts`「水位触发端到端」describe：
  - invoke 结果带 ctxTokens → `handoffState.getLastCtxTokens` 有值（水位触发器数据源复活）。
  - 预置超阈值 ctxTokens → 第二段 invoke 入口先触发统一交接（`restartSession` 被调）再执行 invoke，交接清旧值后本轮写回新值。
  - 未超阈值 → 不触发交接，ctxTokens 仅写回。
- `handoff-deadlink-smoke.test.ts` 补充（大獭终审打回后新增）：
  - **交接模式覆盖整个持锁期**：持锁期间 `handoffModeKeys` 含该 key、release 后复位（锁死 finally-瞬间复位的语义反转 bug——变异验证：回退到旧形态本用例必红）。
  - acquire 抛错路径复位 handoffMode（防泄漏）。

## 设计取舍

机制识别检查点判定（修法排序前置）：**未命中任一项**——本次为既有机制（SdkInvokePort 可选方法、SimpleLockManager 交接模式、HandoffState 水位状态）的接线补全，无净新增机制；机制语义在 F20260920uhuc 方案期已定案，本次仅落实实现。判定结论：n/a（纯 narrow-fix）。

## 验证

- 全量 vitest：3665 通过 / 1 失败（`tests/scripts/validate-commit-date.test.ts`，pre-existing——`git stash -u` 基线复跑同样失败，与本次无关）。
- `npx tsc --noEmit`：0 error。
- `npm run lint`：0 error / 8 warnings（全部 pre-existing，位于 web/，本次未触碰）。
- 最简实现检查：已过——①②③均为既有机制内最小接线，无新文件/新依赖；④测试用既有 createTestDb/mockSendEntry 模式。

## 影响范围

- 仅 `PiSessionFactory`（+2 方法）与 `AgentInvoker`（driver 盒 + 收尾写回）两处生产代码；无 schema/配置/接口变更。
- 交接冻结语义生效后，交接窗口内（最坏 60s 合成上界 + turn 尾）同獭 invoke 将锁排队 120s——符合 F20260920uhuc 方案「锁超时对齐约束」。
