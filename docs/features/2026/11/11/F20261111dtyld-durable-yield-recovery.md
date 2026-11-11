---
id: F20261111dtyld
title: durable 直出文本交棒纠错与历史回放隔离
change_type: fix
status: development
created_at: 2026-11-11
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: faux provider 驱动真实 durable runtime，验证确定性工具与事件契约"
intent:
  problem: "定时 invoke 的模型把结论写成普通 assistant text 后直接 yield，收到笼统无发言错误；同时历史 speak 被初始 watch 重放到当前 invoke_events，误导为工具已执行但未落库"
  expected_effect: "直出文本时 yield 返回专用可见性纠错；真实 speak 后允许 yield；每轮事件流只包含该轮 submit 边界后的 entries"
  verify_by:
    type: behavior_check
causal_links:
  - F20260821spcm
  - F20260913ctlv
summary: 按 #1837 durable transcript 实证收窄根因，修复直出文本交棒纠错和跨 invoke 历史事件重放，不绕过发言落库与交棒校验。
---

# durable 直出文本交棒纠错与历史回放隔离

## 生产现场与根因订正

受影响 invoke：`0b37820f-46a0-44d7-b6f3-0deaea43ebdc`（2026-11-11 08:30，每日对话健康检查）。

- 主库 entries 只有 invoke_start，两次 yield 都返回「还没有用 speak」。
- durable session 按当前 invoke 的 generation 时间过滤后，**实际 speak tool call 为 0**；实际 yield 为 2。
- 两次 yield 前的 assistant entry 都是 `thinking + text + toolCall(yield)`。模型自己也承认「I did speak multiple」，但 raw content 证明它输出的是普通文本，并未调用工具。
- invoke_events 中的 11 条 speak 是 watch 初始视图里的上一任务回放；其 entryId/sequenceNum 对应前两次已完成 invoke，不是本轮落库。

因此不是 `createSpeakEntry` 静默失败，也不能手工补 entries 或绕过 `lastSpeakMessageId`。真实缺陷是：①直出文本后的 yield 错误没有指出可见性误用，模型连续两次重复；②历史回放进入当前 invoke_events，制造出「已调用但无结果」的假证据。

## 修复契约

1. `yield` 在无本轮 speak 且当前 assistant 有非空普通文本时，返回专项错误：普通文本只有模型自己可见，必须用 `speak(body)` 正式重发后再 yield。无文本时保留原通用错误。
2. 每次 durable prompt 在 submit 前记录 watcher 当前最大 entry id；该轮 sink 忽略边界及之前的 entries。跨 invoke 的历史 assistant/tool result 不再写入当前 invoke 的流式事件。
3. 不改变正常 speak/yield 的落库、幂等、路由、terminate 与 `lastSpeakMessageId` 重置语义。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 普通文本 + 未 speak 的 yield | 返回 isError，文案含普通文本/仅自己可见/speak(body) | ✅ |
| 无文本且无 speak | 保留原通用错误 | ✅ |
| durable 直出→yield 错误→speak→yield | speak entry 与 yield entry 依次创建；三个 tool result 完整 | ✅ |
| 初始 watch 含历史与本轮 entry | 只发射本轮边界后的 tool_execution_start | ✅ |

## 验证记录

- 红测先行：旧实现的直出 yield 仍返回通用文案；回放探针实收 `historical-speak`、`current-speak` 两个事件，而预期只有 current。
- 修复后新增目标 **4/4** 通过，其中 durable 用例走真实 `DurableSession` + faux provider + 实际 `createTools`，不是仅测私有函数。
- durable/SIGKILL/纠错组合 **22/22**；agent + 工具相关套件在 build 后实跑，唯一环境性缺 dist 已在 build 后消除。
- 全量 **459 文件、5875/5875** 通过；`npm run build`、`npx tsc --noEmit`、目标 ESLint、docs/intent/tests/criteria lint 与 `git diff --check` 全绿（intent 仅存量 warning）。
- 本修复证明公开 durable 工具链契约；真实供应商模型是否按纠错文案立即改用 speak，以及生产同类定时派工回查，仍按 #1837 的部署后观察项执行，不在本地测试中提前宣称。
