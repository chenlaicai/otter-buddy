---
id: F20260929sawt
title: sleep-announce 断言锚修复与 wait 顺序引导强化
date: 2026-09-29
change_type: fix
capability_test: "tests/capability/sleep-announce.capability.test.ts（本 PR 修复对象本身——实跑 3/3，speak=call#1 wait=call#3 顺序正确）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
summary: 修 #1198 sleep-announce 既有红——双层根因：①spokeBeforeWait 断言锚结构性恒 false（speak entry seq 恒大于本回合 invoke_start，从 #1126 建立即红）②LLM 真实行为先 wait 后 speak（被旧断言掩盖）。修：断言改锚 invoke 事件流工具调用顺序 + wait description 顺序引导强化。实跑 0/3 → 3/3。
tags: [capability, test-fix, tool-prompt]
modules: [tests/capability/sleep-announce.capability.test.ts, src/interface-adapters/agent-runtime/tools/tool-factory.ts]
closes: 1198
intent:
  problem: "#1198 sleep-announce capability 实跑 0/3——2 条 timing=anchored speak@3 < wait-invoke@2 + 1 条 converged=false，issue 归因「大概率 #1126 合入后 LLM 行为漂移」"
  expected_effect: "capability 3/3 绿；时序断言真实测量 LLM 行为（而非结构性恒 false）；LLM 行为面 speak 先于 wait"
  verify_by:
    type: capability_test
causal_links:
  - rel: relates-to
    target: F20260928slan
    note: "本测试与 wait 工具均建于 #1126——时序断言从建立即结构性红，与 #1196 参数修正无关（issue 归因部分修正：既有红为真，但根因是断言缺陷而非单纯行为漂移）"
  - rel: relates-to
    target: F20260928mr5k
    note: "#1196 检视轮双参数归因（810/930 与 480/600 均 0/3）正确识别既有红——本 PR 补上真正的根因"
---

# sleep-announce 断言锚修复与 wait 顺序引导强化

## 问题（#1198）

sleep-announce.capability.test.ts 实跑 0/3：
- 2 条 `timing=anchored speak@3 < wait-invoke@2`
- 1 条 `converged=false`（wait 未被采纳）

## 根因（双层）

### 层 1：断言锚结构性恒 false（测试缺陷）

`spokeBeforeWait` 拿「首个 otter speak entry 的 sequenceNum」与「wait 所在 invoke 的首条 entry（= invoke_start）的 sequenceNum」比较。但 speak 本身是 invoke 内的工具调用——其落库 entry 的 seq 恒大于本回合 invoke_start（invoke_start 先落库）。当 speak 与 wait 同属一个回合（LLM 的自然形态）时，speak@N 恒 > invoke_start@2，**anchored 断言从 #1126 建立即不可能绿**。实证：0/3 中的 2 条 anchored 失败即此形态（speak@3 < wait-invoke@2 的 wait-invoke 锚就是 invoke_start@2）。

### 层 2：LLM 真实行为先 wait 后 speak（被层 1 掩盖）

断言修好后实跑仍 0/3（tools=["wait","speak"]，wait=call#1）——LLM 实际先调 wait 再 speak。issue 猜测的「行为漂移」为真，但旧断言的结构性缺陷让这个真问题从未被看见（两问题叠加，看到的红是假红，真红藏在假红后面）。

## 修复（双层对应）

1. **断言改锚 invoke 事件流**：`spokeBeforeWaitInInvoke`——wait 所在 invoke 的事件流里，speak 工具调用（assistant_toolcall name=speak）必须先于 wait 工具调用。数据面：`tool_execution_start` 对 speak/wait 同发 assistant_toolcall 事件（event-mapping.ts:111），顺序可判。跨 invoke 形态（speak 在更早回合）保留 entries seq 比较——那种形态下 speak entry 属于前一 invoke，seq 恒小于 wait invoke_start，比较语义正确。
2. **wait description 顺序引导强化**（tool-factory.ts:477）：「调用顺序必须：先调 speak(body) 告诉搭档你在等什么、为什么，speak 返回后再调用本工具开始等待（顺序反了搭档会先看到进度条黑盒）」——行为触发类引导必须在工具 description（F20260825hcpg 判断标准先例）。

## 验证（含检视处置后的统计口径订正）

**实证时间线（完整口径）**：
1. 修复前：0/3（2 anchored 假红 + 1 converged）
2. 仅修断言：0/3（真红显形：wait=call#1 speak=call#3——LLM 先 wait 后 speak）
3. 双层修 + 5s 场景：初跑 3/3，但检视獭-1210 独立复跑 **1/3**（#2 OK、#1/#3 LLM 用 bash sleep 3×2 合规等满 5s 未采纳 wait）——5s 场景存在逃逸口，wait 采纳率 ~2/3 在门槛边缘 flaky（检视 S1）
4. 场景改 20s（封堵逃逸：sleep 20 被守卫拦，唯一合规等待路径是 wait）+ A1 双计数修复（wait 序号从 call#3 归真为 call#2）后：**两轮独立采样 6/6 全绿**（speak=call#1 wait=call#2，tools=["speak","wait"] 六采样一致）

**检视处置记录（检视獭-1210，1 严重 3 建议）**：
- S1（采纳率 flaky）→ 采纳：场景 5s→20s 封堵逃逸口；实证口径如上订正
- A1（callOrder 双计数）→ 采纳：统一只解析执行序形态（tool_execution_start 直挂 payload.name），message_end blocks 形态不再重复计数
- A2（toolNamesFromEvents 只认 blocks 形态）→ 采纳：与 A1 一并统一到执行序形态
- A3（场景禁 bash sleep 措辞）→ 不采纳：与「不设限措辞，只断言行为不变量」的测试设计原则冲突——20s 时长本身已让 bash sleep 路径不可行（守卫拦 ≥5s），措辞禁令会把测试变成 prompt compliance 测试而非行为测试；6/6 实证支持

- 单测回归：agent-runtime + frameworks/agent 56 files / 970 tests 全绿；guard-bounce + retry-policy（引用 sleep 引导文案的测试）45/45 绿
- tsc 干净

## 影响范围

- sleep-announce capability 从「永久红」（被误读为 flaky）恢复为有效行为护栏
- wait 工具的顺序引导对生产全场景生效（不只测试场景）——所有「等待前先交代」的产品意图得到行为面保障
