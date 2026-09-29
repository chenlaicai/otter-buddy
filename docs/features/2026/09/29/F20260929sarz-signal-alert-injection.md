---
id: F20260929sarz
title: 信号裁决提醒注入：当场处理可见性保证（#1227 M1）
date: 2026-09-29
change_type: feature
capability_test: "n/a: 纯系统侧注入链路（verify_by=static_only：registry 7 用例 + signal/agent 域 1031 回归全绿——注入是确定性管道行为，非 LLM 行为；大獭收到提醒后的裁决动作属协议行为由既有 resolve_signal 测试覆盖）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
summary: 修 #1227 当场处理机制缺口 A/B 的可见性面——信号落账即登记提醒，大獭下一轮 invoke 头部注入「N 条 pending 待裁决」（短 ID + 处置指引），裁决成功自动注销。同构 healingAlertRegistry 先例（内存队列 + takeAll + big 獭消费 + 借用式注入）。
tags: [signal, injection, orchestration, timeliness]
modules: [src/usecases/signal/signal-alert-registry.ts, src/interface-adapters/agent-runtime/tools/signal-tools.ts, src/interface-adapters/agent-runtime/agent-invoker.ts, src/usecases/ports/sdk-invoke-port.ts, src/frameworks/agent/session-helpers.ts, tests/usecases/signal/signal-alert-registry.test.ts]
closes: 1227
intent:
  problem: "#1227 搭档拍板第一性原理路线：异议信号必须当场处理完。排查实证两个缺口——A：小獭发信号后 yield 不回大獭时信号在场但无人被点名；B：对话收尾后无销账时机（9/16 信号实质已处理但未销账，aging 对尸体报警）。协议层有裁决义务但无物理可见面"
  expected_effect: "小獭发 signal 后，大獭在该对话的下一轮 invoke 头部必然看到「N 条 pending 待裁决」+ 可执行处置指引——协议义务从纸面变物理注入；裁决后提醒消解，不重复打扰"
  verify_by:
    type: static_only
causal_links:
  - rel: relates-to
    target: F20260826mwrd
    note: "同构 healingAlertRegistry 模式（C3 Part 4：registry + takeAll + big 消费 + 借用式注入）——信号版复用整套架构，仅数据源（signal_events 落账）与注销语义（裁决联动）不同"
  - rel: supersedes
    target: F20260929rsxc
    note: "PR #1225（跨对话裁决兜底）被搭档拍板否决关闭——当场可见性取代事后补救；本 PR 是其替代路线的 M1 落地"
---

# 信号裁决提醒注入：当场处理可见性保证

## 背景（#1227，搭档拍板第一性原理路线）

> 「这个异议信号就应该当场处理，那就不存在遗漏到后期兜底处理这个问题！」

排查实证的两个结构性缺口：
- **A（路由缺口）**：小獭 speak 嵌 `<signal>` 落账后，若 yield 不回大獭（自续/传他獭/被打断），信号在场但无人被点名——大獭协议义务是「下一轮派工前必须裁决」，但大獭可能长时间不进场
- **B（生命周期缺口）**：对话自然收尾后无销账时机——9/16 唯一 pending 信号实质已被 PR #1015 修复，但无人销账，aging 24h 后对着尸体报警

根因共同面：**协议层有裁决义务，物理层没有可见性保证**——信号落账是静默的，大獭不看台账就不知道有 pending。

## 方案（M1：提醒注入，同构 healingAlertRegistry）

```
小獭 speak 嵌 <signal>
  → interceptSignalReport 落账（fire-and-forget）
  → signalAlertRegistry.register（落库成功才登记）
  → 大獭下一轮 invoke（本对话）
      → takeAll 消费 → renderSignalAlerts
      → DynamicContext.signalAlerts → 头部注入：
        「⚖️ 裁决义务提醒（N 条 pending 信号）
         - 短ID（objection/medium，from 小獭短ID）：payload 前缀
         处置：resolve_signal(signalId=短 ID, ...)。裁决完自动消解」
  → resolve_signal 成功 → dismiss(信号 ID) → 下轮不再提醒
```

关键设计（全部沿 healingAlertRegistry 已验证口径）：
- **内存队列非落库**：提醒是「未送达的提示」，送达即删；signal_events 台账是持久化真相源。进程重启丢队列 = 错过一次提醒，台账完整 + aging 24h 兜底——接受
- **键为 conversationId**：intercept 时不知谁是大獭，消费侧（agent-invoker 查 otterType）解析
- **跨对话滞留**：大獭在信号归属对话的下一轮才看到（大獭跨对话 invoke 是常态）——接受，aging 兜底仍在
- **落库成功才登记**：台账没有的信号不提醒（fire-and-forget 链内的顺序保证）
- **借用式注入**：消费即删，下一轮不重复（session-helpers buildMessageWithContext 的既有模式）

M2/M3/M4（yield 路由强化/收尾销账闸/回合结束闸）不落：硬闸误伤面大，先软性保证可见性——提醒注入后大獭的裁决行为由协议+提醒双保证，观测实际悬置率后再决定是否加硬闸。

## 验证

- registry 7 用例（送达即删/裁决注销/积压上限/跨对话隔离/渲染文案/落账闭环/裁决幂等联动）全绿
- signal 域 + signal-tools + frameworks/agent 53 files / 1031 tests 全绿（注入面无回归）
- tsc 干净

## 影响范围

- 大獭头部注入新增一个提醒段（只在有 pending 信号时出现，借用式不重复）
- 小獭侧零改动（signal 发送格式/流程不变）
- aging worker 不变（24h 兜底告警继续——M1 是「当场」的主防线，aging 是漏网后的次防线）
