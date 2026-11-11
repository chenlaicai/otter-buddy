---
id: F20261111bdiag
title: golden b5 断链诊断适配 invoke 表结构
summary: 修复 b5 在检视獭未发言时引用已不存在的 invokes.error / created_at 字段而中断诊断的问题，并将 invoke 与事件证据限定到当前采样会话。
change_type: fix
created_at: 2026-11-11
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: tests/capability/golden/golden.capability.test.ts
causal_links:
  - F20261022b5fx
doc_type: feature
tags: [golden, capability, invoke, diagnostics, matter-a8f8f080]
modules:
  - tests/capability/golden/b5-yield-requires-delta-review.golden.ts
intent:
  problem: "b5 检视链未闭合时，诊断 SQL 仍读取 invokes.error 并按 created_at 排序；当前表结构没有这两列，导致真正的 invoke 状态与事件现场被 no such column 异常覆盖"
  expected_effect: "无检视意见时断言稳定返回 FAIL，并携带当前会话的 invoke 生命周期、工具调用数与 invoke_events；不再抛出 schema 异常或混入其他采样证据"
  verify_by:
    type: behavior_check
---

# golden b5 断链诊断适配 invoke 表结构

## 背景与证据

M-a8f8f080 观察子 agent invoke 偶发挂起，约定后续 b5 gate 复现时携带 `invoke_events` 诊断。2026-11-10 的真 LLM 采样出现 2/3 成功，其中失败样本本可给出断链现场，实际却只有：

```text
#2: FAIL 异常 no such column: error
```

当前 `invokes` 表没有 `error` 或 `created_at` 列；错误事件以 `invoke_events.event_type='error'` 标识，详情在 `payload.message`，生命周期时间字段是 `started_at` / `ended_at`。因此原诊断在最需要取证的路径上必然中断。

本修复只恢复测试诊断能力，不断言原始偶发挂起已经消失，也不修改 b5 的行为判据、采样阈值或 runner 等待逻辑。

## 修复契约

- 无检视意见时返回正常 `{ ok: false, detail }`，不得因诊断查询抛错。
- invoke 摘要使用现有字段：`status`、`started_at`、`ended_at`、`tool_call_count`。
- invoke 与 invoke_events 均按当前 `conversation_id` 过滤，避免同批其他采样污染证据。
- 错误内容继续通过 `invoke_events` 的 `event_type='error'` 事件及其 `payload` 摘要呈现，不向 invokes 表新增冗余字段。

## 修法决策

修法决策树①（既有语义内修）：修正测试内 SQL 与既有 schema 的失配，并收紧诊断数据边界；无新配置、生命周期、持久化机制或跨模块调用路径。`Modification-Class: narrow-fix`。

## Verification

### 失败用例证据（bugfix）

新增第 5 条 bad selftest：会话内存在检视獭，但消息流没有检视意见，强制进入断链诊断分支。

修复前（仅加入该自测，SQL 未改）：

```text
FAIL ... b5-yield-requires-delta-review
SqliteError: no such column: error
❯ tests/capability/golden/b5-yield-requires-delta-review.golden.ts:77:8
Test Files 1 failed；Tests 1 failed | 9 skipped
```

修复后，同一自测通过；结果记录：

```json
{"golden_id":"b5-yield-requires-delta-review:selftest","passed":true,"good_ok":true,"bad_ok":false}
```

复现/验证命令（placeholder 仅让真 LLM 采样在 selftest 后跳过，不影响 selftest 真 sqlite 执行）：

```bash
OTTER_TEST_LLM_MODEL=__placeholder__ \
npx vitest run --config vitest.capability.config.ts \
  tests/capability/golden/golden.capability.test.ts \
  -t b5-yield-requires-delta-review
```

### 其他验证

- `npx tsc --noEmit`：0 error。
- `git diff --check`：通过。
- 真 LLM 复采：用于后续观察 M-a8f8f080，不作为本诊断修复已经验证的结论。
