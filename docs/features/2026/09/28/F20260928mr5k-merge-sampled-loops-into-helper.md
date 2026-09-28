---
id: F20260928mr5k
title: capability 手写采样循环收编到 expectSampledBehavior 预算护栏（#1195）
change_type: refactor
tags: [capability, test-infra, budget-guard]
modules:
  - tests/capability/memory-recall.capability.test.ts
  - tests/capability/otter-lifecycle.capability.test.ts
  - tests/capability/sleep-announce.capability.test.ts
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
summary: "#1195：把绕过 #1187 budgetMs 护栏的手写采样循环全部收编到 expectSampledBehavior（memory-recall + otter-lifecycle 两处），sleep-announce 参数违反 n×worst≤budget 契约一并修正——全仓 capability 采样统一走预算护栏"
intent:
  trigger: "搭档指令：ok，你顺手搞定（2026-09-28 19:51，指 #1195）"
  purpose: 消除 #1187 僵尸机制的最后缺口（手写循环无预算保护），统一全部 capability 采样护栏面
from:
  - F20260928zq7d
---

# 手写采样循环收编（#1195）

## 背景

PR #1193（F20260928zq7d）给 `expectSampledBehavior` 加了 budgetMs 前瞻墙钟预算，消除 #1187 vitest 超时僵尸采样。但仓库存在两处**手写 for 循环采样**绕过 helper（无预算保护），一处**参数违反契约**：

1. `memory-recall.capability.test.ts:81` 「跨对话事实召回」it——手写 successes/outcomes 循环
2. `otter-lifecycle.capability.test.ts:230` 「speak 协议合规」it——手写 compliant/outcomes 循环
3. `sleep-announce.capability.test.ts:133`——budgetMs 480_000 < n×worst 810_000，违反 `n×worstMs ≤ budgetMs` 契约（慢端点下 #2/#3 被前瞻 SKIP → 分母 1 → minSuccess=2 假红）

当前两处手写循环算术安全（120s 窗 × 3 采 < 600s 帽），但等待窗一旦上调即复现 #1187 僵尸缺口。

## 改动（净 11+/19- + delta 轮 30 行）

### A. memory-recall 收编（初轮 commit 229e4472）

「跨对话事实召回」it 收编到 helper，与同文件「隐性信号」it 同构同规格：
- budgetMs 720_000 / sampleWorstMs 240_000（120s 窗 + 轮询余量）/ it 帽 840_000 = 3×240+120（#1187 公式）
- 断言语义保留：ok 判据（searchedBeforeSpeak ∧ spoke ∧ correct）、minSuccess=1、detail 字段串逐字保留
- **语义变化（delta 轮明确）**：①失败消息改用 helper 通用模板（丢 F20260805mspk 溯源，溯源保留在 it 注释）；②异常路径从「样本抛错 it 立即红」变为「helper catch 记 FAIL 样本继续」——后者与全仓 helper 统一，是统计断言设计意图，判更好

### B. otter-lifecycle 收编（delta 轮，检视发现全仓扫描补出）

「speak 协议合规」it 同法收编，同规格（720/240/840）。采样内 expectSpeakCompliance 的 try/catch 原样保留在采样体内（throw 由 helper catch 记 FAIL——与原语义对齐）。

### C. sleep-announce 参数修正（delta 轮范围外观察，并入本 PR）

480_000/600_000 → **810_000/930_000**（3×270+120=930 帽；810 = n×worst 等号契约，与 tsr/memory-recall 先例一致）。

## 验证

- budget-guard 4 用例通过（护栏语义回归）
- capability 真跑（检视獭独立跑）：memory-recall **4 tests passed / 197s，被测 it 3/3 采样明细逐条打印**——收编后实跑证据面成立
- 全量 4189 用例（293 files）+ tsc 干净（初轮）；delta 轮复验见检视记录

## 影响范围

- 仅 tests/ 三个 capability 测试文件 + 本文档；生产代码零改动
- 收编后全仓 capability 采样 24/24 走 helper 预算护栏（#1195「统一全部」口径闭环）

## 检视与处置记录

### 初轮（检视獭-1196，mimo-flash，1 严重 2 建议）

| 发现 | 处置 |
|---|---|
| 严重 1（B2）：特性文档 F20260928mr5k 不存在（编号进了 PR/commit 标题却悬空） | 采纳：本文档补齐 |
| 建议 1：otter-lifecycle:230 手写循环残留（#1195「统一全部」未闭环） | 采纳：B 节收编 |
| 建议 2：PR body「断言语义不变」绝对化失实——失败消息丢 F20260805mspk 溯源、异常路径语义变化（判更好） | 采纳：PR body 措辞改「断言判据逐字保留；异常路径语义变化见特性文档」；本文档 A 节明示两处变化 |
| 范围外观察：sleep-announce 参数违反 n×worst≤budget 契约（810>480，慢端点假红面） | 采纳并入：C 节修正 |
