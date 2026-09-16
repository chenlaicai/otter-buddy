---
id: F20260916aenf
title: 证据锚点外部强制：daily-review 锚点真实性抽查 + A1 三节重组
doc_type: feature

summary: |
  #981 一个 PR 合并两项（搭档决策 2026-09-16「不要拆这么碎」）：
  a) prompts/scheduled/daily-health-check.md 新增「锚点真实性抽查」段——每日从昨日对话抽 5-10 条
     file:line 锚点断言，read 核对文件/行号/内容实质，编造锚点开 P1 issue、7 日 2 次升 P0；
  b) SYSTEM.md A1 三条规则（先查再说/证据锚点/来源校准）重排为 ①调查流程 ②证据形态 ③来源校准
     编号子结构，纯排版零语义变更，防新规则注意力稀释。

causal_links:
  from:
    - F20260916evan   # 证据锚点规则本体（本特性是其外部强制 + 结构保鲜）

change_type: prompt
tags: [prompt, daily-review, evidence-anchor, fact-verification, trust, system-prompt]
modules:
  - prompts/scheduled/daily-health-check.md
  - .pi/SYSTEM.md
capability_test: "n/a: 纯 prompt 行为规范；a 项效果由明日 daily-review 是否产出「锚点抽查段」验证，b 项为排版无行为变更"
intent:
  problem: "证据锚点规则（F20260916evan）依赖 LLM 自觉，存在「真假锚点混合」绕过模式——比不给锚点更危险（虚假安全感）；且 A1 三条规则 35 行分散排布，新规则注意力权重被旧规则稀释"
  expected_effect: "①daily-review 每日产出锚点抽查段（抽查 N/通过 M/失败 K），编造锚点有固定查处通道；②A1 三节编号结构让三条规则各司其职、新规则可独立被引用"
  verify_by:
    type: behavior_check
    reason: "a 项：明日 daily-review 日报是否含锚点抽查段 + 抽查失败时是否开出 P1 issue；b 项：纯排版"
created_in_conversation: 9798234f-93d1-401a-8abe-f15f2354a0b0
---

# F20260916aenf: 证据锚点外部强制 + A1 三节重组

## 背景与需求

### 问题描述

F20260916evan（PR #980）落地证据锚点规则后，对抗审视（检视獭-证据锚点）发现两个本 PR 装不下的洞，
登记为 issue #981：

- **发现 2（a 项）**：规则依赖自我监管，LLM 可混合真假锚点绕过（3 真 2 假），比不给锚点更危险
- **发现 5（b 项）**：A1 三条互补规则约 35 行分散排布，新规则注意力权重被稀释

搭档 2026-09-16 决策：a/b 一个 PR 全做，不拆碎。

### 方案

**a) 锚点真实性抽查**（daily-health-check.md 新增段，位于「分析纪律」之前）：
每日 search_messages 抽 5-10 条昨日 file:line 锚点断言 → read 逐项核对（文件存在/行号范围内/
内容实质相符）→ 日报产出「锚点抽查段」（N/M/K）→ 任一不通过开 P1 issue，同獭 7 日 ≥2 次升 P0。
同步在「产出前检查清单」加第 9 项。

**b) A1 三节重组**（SYSTEM.md）：三条规则改为 ①调查流程 ②证据形态 ③来源校准 编号加粗前缀，
内容零变更，纯排版。

### 效果边界（诚实披露）

a 项仍是「LLM 查 LLM」的软强制，不是机器断言级自动校验——价值在固定流程 + 必产出 +
事后可追溯。真机器强制（代码层自动校验锚点）是后续可能方向，本特性不含。

## 影响范围

- `prompts/scheduled/daily-health-check.md`：+抽查段（约 15 行）+ 检查清单 +1 项——影响每日
  daily-review 任务执行流程
- `.pi/SYSTEM.md`：A1 纯排版重组（±2 行），无语义变更

## 验证

- pre-commit lint 全过
- a 项行为验证：明日 daily-review 产出应含「锚点抽查段」
- b 项：diff 审阅确认仅排版变更

## 决策记录

- 2026-09-16：issue #981 由 P2 提 P1（搭档：a/b 一个 PR 全做，不要拆碎）
- 2026-09-16：认领 #981 开工（conversation 9798234f）
