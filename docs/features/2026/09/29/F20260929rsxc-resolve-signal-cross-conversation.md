---
id: F20260929rsxc
title: resolve_signal 跨对话裁决通道（悬置信号消费闭环）
date: 2026-09-29
change_type: feature
capability_test: "n/a: 纯工具参数扩展（verify_by=static_only：signal-tools 21 用例含跨对话新形态 ×6 + signal 域 103 回归全绿——判定面为确定性参数/权限逻辑，无 LLM 行为）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
summary: 修 #1041 跨对话悬置信号裁决无通道——resolve_signal 加 conversationId 可选参数（显式跨对话裁决），aging worker suggestion 给出可执行调用（含 signalConversationId context）。权限面由工具持有性保证（仅 big 型），隐式跨对话仍拒 + conversationId 拼错串话防护。
tags: [signal, tool, aging, cross-conversation]
modules: [src/interface-adapters/agent-runtime/tools/signal-tools.ts, src/usecases/signal/signal-aging-worker.ts, tests/interface-adapters/agent-runtime/tools/signal-tools.test.ts]
closes: 1041
intent:
  problem: "#1041 signal-aging-worker 落了悬置告警但无执行通道——resolve_signal/query_signals 都只查当前对话，跨对话 pending 信号只能 sqlite 直查发现且无工具能改状态（#1013 blocked 信号、#1015 修复后的 objection 均悬置实证）"
  expected_effect: "大獭在任意对话可显式裁决跨对话悬置信号（完整 ID 或指定对话内短 ID）；aging 告警 suggestion 直接给出可执行参数；隐式跨对话仍拒（防误操作）"
  verify_by:
    type: static_only
causal_links:
  - rel: relates-to
    target: F20260826mwrd
    note: "resolve_signal 原始建立（C2 裁决写路径，本对话限定）——本 PR 扩展跨对话通道，权限模型不变（仅 big 型持有）"
  - rel: relates-to
    target: F20260917trig
    note: "signal-aging-worker（悬置老化告警）的告警从此有消费通道——「传感器→处置队列」链路在跨对话场景闭合"
---

# resolve_signal 跨对话裁决通道（悬置信号消费闭环）

## 背景（#1041）

signal-aging-worker 发现悬置信号（objection/blocked 超 24h 未裁决）后落 healing event，但裁决动作无执行通道：`resolve_signal` 只解析当前对话的 pending 信号（短 ID 前缀搜本对话 + 完整 ID 校验 conversationId 拒绝跨对话）。生产实证：#1013 blocked 信号、PR #1015 修复后的 objection 均悬置至今（sqlite 直查确认）——「aging 告警在生产告，但消费方永远只能在信号所在对话恰好被唤醒时才能裁决」。

## 方案（issue 方案 1，方案 2 aging 自裁决归二期）

### resolve_signal 扩参

- 新增可选 `conversationId` 参数：显式指定信号所在对话
- **短 ID 前缀匹配**：搜索域从「本对话」扩为「显式 conversationId ?? 本对话」
- **完整 ID 路径**：`checkResolvable` 的对话校验放宽为三元——本对话 ✓ / 显式 conversationId 匹配 ✓ / 其他 ✗（拒绝信息带回信号实际所属对话 ID，引导正确传参）
- **形态不做 UUID 强校验**：真防线在对话匹配校验（拼错即拒，防串话）；UUID 校验对测试夹具与兼容面过度防御

### 权限模型（不变）

- resolve_signal 仅 big 型持有（manifest orchestration 组 + session-helpers small 白名单排除）——跨对话裁决权天然在大獭（编排者），与「裁决权在大獭」的原设计一致
- 显式 conversationId 要求 = 双重确认（防误把本对话信号 ID 撞到跨对话裁决）

### aging worker 联动

- suggestion 从「调 query_signals 查详情并 resolve_signal 裁决」升级为**可执行调用**：`resolve_signal(signalId=完整ID, conversationId=..., status=..., resolution=...)`
- context 新增 `signalConversationId` 字段（原只有 signalId）

## 验证

- signal-tools 21 用例全绿（原 14 + 跨对话新形态 6 + 旧「跨对话拒绝」用例改写为「短 ID 本对话无匹配」）
- 跨对话形态覆盖：完整 ID 裁决成功 / 指定对话内短 ID 展开 / 隐式跨对话拒（引导传参）/ conversationId 拼错串话防护（错误信息带实际对话 ID）/ 本对话显式传参幂等
- signal 域 + coding-tools + tool-universe 103 回归全绿、tsc 干净

## 影响范围

- 悬置信号消费闭环：aging 告警 → 大獭任意对话显式裁决 → 状态落库——#1013/#1015 类悬置可清
- 本对话裁决行为零变化（不传 conversationId 时全链路同旧）
- 隐式跨对话仍拒（防御纵深保留）——误操作需要两个条件同时错（完整 ID + 拼错的 conversationId 恰好匹配另一信号），实际不可达
