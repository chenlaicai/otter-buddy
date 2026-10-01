---
id: F20260930hsfx
title: 重启獭生交接压缩链修复（保留段空不废合成 + 降级 reason 贯穿）
summary: 「无 speak 有工具轮原料」不再连坐跳过叙事合成；降级原因枚举贯穿日志与档案文案；熔断计数口径收敛单点；文案诚实 + 层积岩清理
change_type: fix
capability_test: "tests/frameworks/agent/session-slicer.test.ts（slice 恒返回 + 原料口径）+ tests/frameworks/agent/unified-handoff-engine.test.ts（机械档案 reason）+ tests/interface-adapters/unified-handoff.test.ts（S1 事故形态/真空/S2/M2/M4 集成）"
intent:
  problem: "9/30 搭档手动重启獭生（synthesizePast=true）拿到机械档案。根因：前世 session 只活 6 秒（空 session），切片器 speakIndexes.length===0 → return undefined，agent-invoker 判 slice 空就连坐跳过整个叙事合成。搭档原话：「保留段没有消息就只是保留段，为什么要影响整个交接降级」。"
  expected_effect: "① 保留段空（无 speak 有工具轮原料）时合成照跑，保留段节只标注「前世无发言」；② 降级原因枚举（empty-session/jsonl-read-fail/synthesis-error/synthesis-timeout/over-window/circuit-open/user-off 7 个有效值）贯穿日志与机械档案文案，事后排查一眼定位；③ 熔断计数口径收敛到 noteHandoffOutcome 单点，消除「自重启炸两次合成被永久静默熔断」；④ 文案诚实（不预告合成、删错误时间框、完成文案补 reason）；⑤ 熔断场景直接机械档案（快速止损）且 reason 归因 circuit-open 优先于 user-off（修复真实熔断路径虚假归因）；⑥ 换模型重置熔断计数。"
  verify_by:
    type: capability_test
    reason: "S1-S3 切片/合成触发/熔断路径均由单测锁死（含本次事故形态回归）；M1-M5 与层积岩由对应单测断言覆盖。全量 vitest 4373 用例 + tsc + eslint 全绿。"
created_in_conversation: 74abdc91-d743-4cf9-816c-aacfee433c8f
tags: [handoff, session-slicer, narrative-synthesis, circuit-breaker, degrade-reason, self-restart]
modules: [src/interface-adapters/agent-runtime/, src/frameworks/agent/]
from: ["F20260929kws1", "F20260923hsyn", "F20260924thnk", "F20260924swin", "F20260920uhuc"]
causal_links: ["F20260929kws1"]
created_at: 2026-09-30
---

# 重启獭生交接压缩链修复（保留段空不废合成）

## 问题（事故实证）

9/30 搭档手动重启獭生（勾了「前世总结」`synthesizePast=true`），结果拿到机械档案。根因链：

1. 前世 session 只活了 6 秒（空 session，0 条 speak、全是工具轮）。
2. `session-slicer.ts` 的 `sliceSessionEntries` 在 `speakIndexes.length === 0` 时 `return undefined`。
3. `agent-invoker.ts` 的合成触发条件 `synthesizePast && slice && slice.messagesToSummarize.length > 0`——slice 为 undefined 时**整条合成被跳过**，直接落到机械档案。

搭档原话：「保留段没有消息就只是保留段，为什么要影响整个交接降级」。核心误判：把「保留段空（无 speak）」等同于「无可压缩内容」，连坐废掉了整个叙事合成——但工具轮原料是完整的，本该正常合成。

**对旧特性 kws1 的修正**：F20260929kws1 引入「保留段 = 最近 4 条 speak」时，对「无 speak」session 一并返回 undefined 走降级。本修复保留 kws1 的保留段口径不变，只改「slice 返回 undefined 的判定」——从「无 speak 即 undefined」收窄为「只有真空 session（0 条 entry）才 undefined」，并把 `messagesToSummarize` 语义从「第 4 条 speak 之前」改为「保留段之外的全量」（消除 gap 拦腰切断与保留段陈旧倒挂，mimo 盘点独家发现）。

## 修复项（S 级同一刀 + M 级 + 层积岩）

### S1 核心：保留段空不废合成
- `session-slicer.ts`：`sliceSessionEntries` 恒返回结构——真空 session（0 条 entry）才返回 undefined；「无 speak 有原料」返回 `{ keptEntries: [], messagesToSummarize: <全量消息>, ... }`。
- `agent-invoker.ts`：合成触发条件改为 `synthesizePast && 原料非空（hasMaterial）`，保留段空只影响档案展示节（标注「前世无发言」），不再废掉整个叙事合成。
- 原料口径：`messagesToSummarize` = 「保留段之外的全量消息」——有 speak 时从头到最老保留 speak 之前；无 speak 时全量。一次改完 gap 拦腰切断与保留段陈旧倒挂。

### S2 降级原因枚举贯穿
- 定义 `HandoffDegradeReason` 枚举：`empty-session` / `no-speak-has-material` / `jsonl-read-fail` / `synthesis-error` / `synthesis-timeout` / `over-window` / `circuit-open` / `user-off`。
- 日志（agent-invoker 合成各分支 + collectJsonlSlice）+ 机械档案文案（`buildMechanicalArchive` 的「说明」节，原「synthesizePast=false / 失败 / 超时」三并列拆分）都带具体 reason。
- 效果：事后排查一眼定位是哪种降级，不再三并列混淆。

### M1 文案诚实
- 进度文案只说确定的事（「正在重启獭生，前世档案生成中」），不预告「前世总结中」（可能随后降级为机械档案）。
- 删掉「预计 5-15 秒，最长约 1 分钟」（合成实际超时上限 300s，给的时间框是错的）。
- trigger 分场景：只有水位才说「上下文已满」（自重启是配额切换/污染重置，熔断是快速止损）。
- 完成文案补降级 reason（机械档案不再笼统）。

### M2 熔断计数口径收敛
- `handoff-state.ts` 提供统一入口 `noteHandoffOutcome(kind)`（`synthesis-failed` / `succeeded`）。
- 水位(:314 catch)/熔断(:1636 catch)/自重启(:1746 catch) 三处原吞失败不计数——现收敛到单点计入；自重启 bare fallback(:1692) 原不清零——现清零。
- 消除「自重启炸两次合成被永久静默熔断」（计数永远到不了 2，熔断形同虚设）。

### M3 短命代处理
- 档案谱系标注短命代（寿命/消息数低于阈值时）。当前由 `genNAware.oneLineAchievement` 机械追加谱系行承载，短命代空档案时跳过该行避免误导；本修复同步 S1 后「无 speak 有原料」的叙事摘要末尾补「前世无发言」标注，告知新世保留段空不是丢失。

### M4 熔断场景直接机械档案
- `agent-invoker.ts` 熔断路径的 `synthesizePast: true` 硬编码改为 `false`——熔断语义是快速止损，不拖交接锁跑最长 300s 合成；换世后由新世在正常 invoke 里走水位/手动交接补叙事（若仍需要）。

### M5 熔断可见 + 换模型解锁
- 熔断开启时完成文案明示「连续失败熔断开启」（不再笼统「机械档案」）。
- `modelAlias` 变更时重置熔断计数（此前模型卡死连炸 2 次熔断后，换模型本可解锁却被旧计数永久锁住）。

### 层积岩顺手铲
- `synthesizePast` 默认值 4 处散布（水位入口/自重启/otter-controller/tool-factory/bootstrap clients 的内联 `= true` / `!== false`）→ 收敛 `HANDOFF_SYNTHESIZE_PAST_DEFAULT` 单点。
- `lockMode 'none'` 死分支删除（原注释自认无调用方，所有触发路径均 'acquire'）。
- 「首哑复活」死枚举删除（trigger 联合类型 + narrative-synthesis-engine 注释，全仓无传值）。
- 两套保留段实现量纲统一——DB 兜底 `collectRecencyWindowFallback` 从「20 speak + 20 user 混排」向 jsonl 口径对齐（最近 4 条 speak 纯 text，单条截 1500）。
- 注释口径修正（「连续 ≥2 次交接失败」→「连续 ≥2 次合成失败」，与实际清零语义一致）。
- `otterName` 重复查询合并（原 1047 与 1118 两处 `queryOtter.getById` → 并入原料 Promise.all 一次）。
- `runShadowSynthesis` 的 `setTimeout` timer 补 `clearTimeout`（原从不 clear，合成正常返回后计时器仍挂 300s，Node 句柄保活）。

## 影响范围

**行为变更（有意为之）**：
- 「无 speak 有工具轮原料」的交接：从「机械档案」变为「叙事档案 + 保留段节标注前世无发言」——这正是本次事故场景的预期修复。
- 熔断场景（circuit-break restart）：从「尝试合成（最长 300s）」变为「直接机械档案（秒级）」——快速止损语义。
- 完成文案：机械档案时补具体降级 reason。

**不变**：
- 真空 session（0 条 entry）：仍跳过合成走机械档案（empty-session reason），无原料可合成跳过合理。
- 保留段口径（最近 4 条 speak 纯 text，单条截 1500）：kws1 不变。
- 熔断阈值（连续 ≥2 次合成失败）：hsyn 不变，只收敛计数入口。
- 交接锁（acquire + 120s handoff 模式）：不变。

## 测试（锁行为）

新增/更新用例覆盖「测试必补」清单：
- slice 恒返回结构：无 speak 有原料 → `keptEntries=[]` + `messagesToSummarize=全量`（S1 核心）。
- 真空 session（0 消息）→ 机械档案 + reason=empty-session，合成跳过合理。
- 无 speak 但有工具轮原料 → 合成照跑，保留段节标注无发言（本次事故形态回归）。
- 机械档案文案带具体降级 reason（8 种枚举逐一断言，不再三并列混淆）。
- 熔断计数对称性（统一交接内合成失败计入 noteHandoffOutcome，连续两次后熔断开启跳过合成）。
- 熔断场景 synthesizePast=false 直接机械档案（M4，零合成调用）。

全量 `vitest run` 4369 用例 + `tsc --noEmit` + `eslint` 全绿。
