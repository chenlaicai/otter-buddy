---
id: F20261125frags
title: kimi 流式拆碎 function_call 致 duplicated 400 死循环：beforeRequest 聚合碎片恢复参数
change_type: fix
created_at: 2026-11-25
created_in_conversation: 3e928c99-db1c-4683-94d0-8fe831bf6303
capability_test: "n/a: 仅净化发往 provider 的消息历史，不改变任何工具/生成式能力语义"
from: [F20261113etsan]
tags: [kimi, openai-responses, sanitizer, tool-call, stream-fragment]
modules: [src/frameworks/agent/assistant-message-sanitizer.ts, src/frameworks/agent/durable-session.ts, tests/frameworks/agent/assistant-message-sanitizer.test.ts]
intent:
  problem: "kimi k3.1-pro 流式模式把一次 function call 拆成多个 output_item（仅首个带 call_id/name，参数按片段分拆）；pi-ai 逐 item 建独立 toolCall block，碎片以空 call_id/空 name 落库，引擎照样执行产生 Tool-not-found error；下轮请求回放时多条 call_id:\"\" 的 function_call 被 kimi 判 400『tool call id :N is duplicated』（:N 为 kimi 名字:序号显示格式，空名字碎片 ≥2 即触发）——session 每轮必死、重启无效（新世继承历史 + 首轮响应又拆新碎片，#2024 实证 :267→:14 两连挂）。"
  expected_effect: "发往 openai-responses 端点的消息历史不再出现空 call_id 的 function_call/function_call_output；碎片参数按 argumentsError 原始串聚合恢复（真调用参数完整回填）；孤儿 error toolResult 剔除；存量中毒 session（含被继承的前世历史）无需数据清创即痊愈；其余 api 消息不受影响。"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "单测 17 项全绿：3359/3383 中毒形态聚合恢复、孤儿剔除、空 item 穿插归属、零拷贝路径、收敛域、无归属碎片丢弃、parse 失败保守退化、混合序列引用保持"
      - "curl 对照实验（真端点）：A 组污染回放（1 真 fc + 2 空 call_id 碎片 + 3 output）→ 400 `tool call id :2 is duplicated`（与线上 :267/:14 同格式一字不差）；B 组净化后回放（1 完整 fc + 1 output）→ 200 正常处理"
      - "回归：tests/frameworks/agent 65 文件 725 测试全绿（含 build 后 SIGKILL fixture）；tsc 0 error"
    rollback: "git revert 本 PR；仅请求前净化逻辑，无落库格式/schema 变更，无数据迁移"
    risk_note: "聚合仅限 api=openai-responses 的 assistant 消息 + call_id 段为空的 toolResult（该 id 构造 `${call_id}|${item_id}` 为 responses 路径专有，anthropic/completions 的 id 不含 | 前段非空，天然不命中）。残余如实交代：碎片落库后、下轮请求前仍会被引擎执行一次（error 噪音一轮，模型见聚合后完整参数可自愈重试）；聚合恢复的真调用其 toolResult 仍是残缺参数那次的结果——协议合法、语义错位，模型可消化。"
causal_links: []
summary: kimi 流式拆碎 function_call（同族第三形态，F20261113etsan 只修了空 text 半边），beforeRequest 出口聚合碎片恢复参数、剔除孤儿 error，覆盖存量与增量，curl 真端点对照 A400/B200 实证。
---

# kimi 流式拆碎 function_call 致 duplicated 400 死循环修复

## 案发现场（#2024，2026-11-25）

dev-connector-onboarding（kimi，otterId 553a03b7）两世连挂：系统睡眠冻结 708 分钟恢复后，
08:54 首次 400 `tool call id :267 is duplicated`；restart 保持 kimi 后新世首轮 6 秒内再挂
`:14 is duplicated`。换 glm 即活。另一对话在场大獭（94d41f8d）完成 curl 原始流复现
（/tmp/kimi-stream-test.sse）与 healing 初判。

## 根因链（证据锚点）

1. **kimi k3.1-pro 服务端流式缺陷**：一次 function call 拆成多个 output_item，仅首个带
   call_id/name，参数按片段分（curl 实锤：`{` / `"command": "grep -n` / `"` /
   `, "timeout": 120` / `}` 五段分属 5 个 item）。非流式正常。**同族第三形态**：
   F20261113etsan 已实锤该拆碎行为会产生空 output_text item（当时修了剥空 text 半边），
   function_call 被拆碎这半当时未暴露。
2. **pi-ai 忠实记录**：每 output_item.added 建独立 toolCall block（pi-ai openai-
   responses-shared.js:535，id=`${call_id}|${item_id}`）→ 碎片以空 call_id/空 name/
   arguments={} 落库；**原始参数片段无损保留在 block.argumentsError**（「Received
   arguments:\n」后）——聚合恢复的原料。
3. **引擎执行碎片**：空 name → harness「Tool not found」error toolResult 落历史
   （sqlite 553a03b7 实证：entries 3359 一真四碎、3383 三真十二碎、error toolResult ×12、
   引擎防环提醒「Consecutive identical call \"\" 6 times」）。
4. **回放被拒**：请求构造 split("|") 取 call_id（openai-responses-shared.js:265）→
   碎片变 call_id="" 的 function_call → 同请求多条空 call_id → kimi 400 duplicated
   （:N 为「名字:序号」显示格式，空名字出现 ≥2 次即触发）。
5. **restart 无效**：durable session 历史被新世继承 + 新世首轮又拆新碎片。

未决疑点（如实标注）：冻结前正常、恢复后才拆碎——推测超时重试轮长请求或服务端降级
路径触发（中低置信，服务端内部不可见）；第一世拆碎后有一轮未 400——kimi 校验间歇性，
未深挖（低置信，不影响本修复——出口恒净化后请求恒合法，不依赖校验规律）。

## 修复

`src/frameworks/agent/assistant-message-sanitizer.ts` 新增 `aggregateFragmentedToolCalls`：

- **碎片判定（两型）**：Responses 协议合法 function_call 的 call_id/name 两者必非空，
  空即异常——**双空碎片**（call_id 段与 name 均空，服务端拆碎的实测形态）与**单空
  畸形**（恰一空，防御性形态未实证）。
- **聚合恢复**：仅双空碎片参与聚合——原始串（argumentsError 提取）按序并入同消息内
  最近真 toolCall 的原始串；拼接后 parse 成功 → arguments 回填、argumentsError 清除；
  失败 → 真 block 保持原状（保守退化，死循环切断优先于参数完美恢复）。碎片与真调用
  之间的空 text/thinking 块不打断归属链（kimi 空 message item 穿插形态，curl 实证）。
  单空畸形**剔除但不聚合**——它有独立 call_id，并入最近真调用有错归属风险。
- **孤儿剔除（与剔除对称）**：toolCallId call_id 段为空或 toolName 为空的 toolResult
  一律剔除（无论 isError——对应的 toolCall 已被剔除，保留即破坏配对；实测形态全是
  Tool-not-found error）——保住 fc/output 紧邻配对（既有教训：kimi 校验邻接）。
- **收敛域** `api === "openai-responses"`：与 stripEmptyAssistantText 同收敛逻辑。
- 落点 `durable-session.ts` GenerationTask beforeRequest 钩子，先聚合再剥空 text，
  每次请求（含熔断恢复轮）前净化——存量中毒 session 无需数据清创即痊愈，历史记录
  原样可审计。

不做的：不改 pi-ai/kimi 端行为（上游可另报，长期项）；不在落库时改历史（保留现场）。

## 设计取舍

- **修法决策树定位 ①narrow-fix**：扩展 F20261113etsan 已建立的 beforeRequest 净化
  层规则集（同一落点、同一模式、同一收敛逻辑），非净新增机制。
- **机制识别检查点**：命中「新增决策分支」项——判定为**纯运行时临时分支**（净化
  结果仅用于当次请求内存替换，不写入数据库/配置/记忆/文件），按检查点定义不涉净
  新增机制，走①。
- **聚合 vs 剔除**：argumentsError 保留了无损原始片段（3359 逐 block 实证五段拼接
  = 合法 JSON），聚合恢复完整参数优于仅剔除（模型见完整参数可正常续轮）；parse
  失败退化剔除，死循环切断是底线。单空畸形只剔除不聚合：检视反例实锤（name-only
  畸形若仅删 toolCall 留其 output，fc/output 配对即破——判定必须对称）。
- **孤儿判定对称性**：toolResult 的剔除谓词（call_id 段空或 toolName 空）与 toolCall
  的剔除谓词（双空碎片 + 单空畸形）逐形态对称，无「call 被删而 result 留下」的缝隙。
- **为什么不在落库层**：pi-durable 的 afterResponse 钩子只观察不可改写；落库前拦截
  需 patch 外部 SDK（pi-ai 是 earendil-works 开源包）。beforeRequest 是 otter-buddy
  可控的最早可写落点，且天然覆盖存量。

## 验证

- 单测 17 项全绿（含 3359/3383 真实中毒形态 fixture、空 item 穿插、保守退化、
  零拷贝、收敛域、混合序列引用保持）。
- curl 真端点对照实验：
  - A 组污染回放（1 真 fc + 2 空 call_id 碎片 + 3 output）→ **400**
    `Invalid request: tool call id :2 is duplicated`（与线上 :267/:14 同格式，
    死因一字不差复现）
  - B 组净化后回放（1 完整 fc + 1 output）→ **200** 正常处理
- 回归：tests/frameworks/agent 65 文件 725 测试全绿；tsc 0 error。
- 最简实现检查：已过——复用既有净化函数模式（纯函数 + undefined 零拷贝语义），
  无新依赖、无新文件（同文件追加），无更简替代（剔除-only 方案代码更少但放弃
  参数恢复，已否）。

## 残余与后续

- 碎片落库后、下轮请求前仍被引擎执行一次（error 噪音一轮）——pi 工具执行循环在
  SDK 内部，otter-buddy 层不可拦；模型见聚合后完整参数自愈重试。需要升级为
  零噪音再考虑 onProviderStreamEvent 影子聚合（复杂度显著上升，暂不做）。
- 聚合恢复的真调用其 toolResult 仍是残缺参数那次的结果——协议合法、语义错位，
  模型可消化。
- 长期：给 earendil-works/pi 提上游 issue（pi-ai 流解析对空 call_id function_call
  item 的聚合缺失）——待搭档定夺，不阻塞本修复。
