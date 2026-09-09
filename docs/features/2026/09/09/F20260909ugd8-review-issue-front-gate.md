---
id: F20260909ugd8
title: 检视处置「建 issue」前置闸：强关联发现默认当场修
summary: 修订检视发现处置决策树——「建 issue 留后续」从默认出口变为被举证责任锁住的例外。新增关联度判据（守护本 PR 行为不回退 / 澄清本 PR 刚改口径的发现 = 强关联，默认当场修），「本 PR 无法承载」收敛为穷尽式合法清单（依赖未就绪 / 需产品决策 / 增量 >300 行或 >3 个新模块），「需搭 fixture」「非本 PR 文件」列为伪理由。源自搭档对 #860 处置的批评（#865）。
change_type: prompt
capability_test: "n/a: prompt 契约文档行为契约修订，机械可测面为文档内容本身（lint 校验）；行为生效依赖 LLM 遵循协议"
intent:
  problem: "检视发现的「建 issue」子路径举证责任方向反了——缺关联度维度导致与本 PR 语义强关联的发现（守护修复不回退/澄清刚改口径）也走挂起，「需搭 fixture」「非本 PR 文件」等伪理由可通过「无法承载」论证，建 issue 成为阻力最小路径（#860 实证，搭档批评「都在偷懒提 issue 去了」）"
  expected_effect: "强关联发现默认当场修（原 PR 或补充 PR）；建 issue 成为被举证责任锁住的例外——作者必须论证为什么不能现在修，且理由命中穷尽式合法清单（依赖未就绪/需产品决策先裁决/增量超阈值），伪理由被点名拦截"
  verify_by:
    type: behavior_check
    detail: "下次 PR 处置出现「强关联发现想建 issue」场景时，处置回应必含关联度判断（强/弱+依据）与合法清单命中论证；delta 审视核对新增两项（关联度判断给出、论证命中清单）；每日 review 可统计「建 issue 处置」中缺关联度论证的次数"
tags: [skill, adversarial-review, disposition-tree, issue-governance]
modules:
  - .pi/skills/adversarial-review/references/author-response-protocol.md
  - .pi/skills/adversarial-review/references/anti-patterns.md
  - .pi/skills/code-implementation/SKILL.md
created_in_conversation: 7cde6e5e-a8ef-4bec-8161-bceccf3d16df
created_at: 2026-09-09T11:50:00+08:00
---

# F20260909ugd8 检视处置「建 issue」前置闸：强关联发现默认当场修

## 背景

2026-09-09，PR #860（F20260909csdt 成本/产出日期修复）对抗检视产生 2 条建议发现：worker 多轮扫描回归测试（#862）、`buildCostTrendSeries` 聚合注释澄清（#863）。处置均为「接受 + 建 issue 后续做」，理由分别是「需额外 fixture 搭建」「非本 PR 变更文件」。

搭档裁决（issue #865）：两条都与本 PR 核心语义强关联——一个保修复不回退、一个防误读刚改的口径——应作为补充 PR 直接修复，「都在偷懒提 issue 去了」。补充 PR #866 当天交付，证明「无法承载」的两条理由均不成立。

## 根因

原 `author-response-protocol.md` 的「本 PR 无法承载 → 建 issue」子路径：

1. **缺关联度维度**：「相关 + 数量 ≤ 5 顺手修复」条款只覆盖实现者自行发现的问题（code-implementation 问题处理节），对检视发现没有「与本 PR 语义强关联度」的判定——建议发现一律建 issue 成为阻力最小路径
2. **「无法承载」论证标准模糊**：「需搭 fixture」「非本 PR 文件」只描述工作量或位置，不证明承载不能，却能通过论证
3. **举证责任方向反了**：原规则隐含「论证为什么可以挂起」，正确方向是「论证为什么不能现在修」

## 修订内容

### author-response-protocol.md（主体）

新增「建 issue 前置闸」节，置于「建 issue 的执行主体」之前：

- **关联度判据**：守护本 PR 刚修复/引入的行为不回退、澄清本 PR 刚改动的代码/口径、修复本 PR 变更直接引入或暴露的问题——三者命中其一即强关联
- **分流规则**：强关联 → 默认当场修（原 PR 未合入修原 PR，已合入开补充 PR）；弱关联 → 建 issue 合法
- **「无法承载」合法清单（穷尽）**：①依赖未就绪 ②需产品/方向决策 ③增量 >300 行或 >3 个本 PR 未触碰的模块
- **伪理由反面清单**：「需搭 fixture」「非本 PR 文件」「建议级不阻断」不构成承载障碍
- **举证留痕**：建 issue 的回应必须显式写出关联度判断 + 命中合法清单条目，否则处置不成立
- **delta 审视核对项扩展**：检视者核对关联度判断是否给出 + 论证是否命中合法清单（原只核对 issue 链接与登记）

决策树 ASCII 同步更新，指向前置闸。

### anti-patterns.md

Let It Slide 反模式的 Fix 节新增一条：强关联发现挂 issue 也是 Let It Slide——「建 issue 留后续」是阻力最小路径的伪装。

### code-implementation/SKILL.md

「问题处理」节末尾的检视发现指引扩展：明确走「建 issue」子路径前必须过关联度前置闸，复述合法清单要点，保持与 author-response-protocol.md 一致（真相源在后者）。

## 取舍

- **阈值取 300 行 / 3 模块**：主观标尺，为「工作量确超阈值」提供可判定锚点。达到此量级的「发现」更可能是独立特性，走完整开发流程（issue → 方案 → PR）反而更合规。阈值偏严（偏小）的风险是把本该挂起的发现压回本 PR 导致 PR 膨胀——可接受，审查者可在 PR 审时纠偏（既有「数量 > 5 → 审查者决定是否拆分」条款兜底）
- **不改分级框架**：严重/建议分级不变，反驳门槛不变——本次只收紧「更好→建 issue」子路径的进入条件，不动「更差→反驳」侧
- **补充 PR 合法化写入规范**：#866 已实证该路径可行（当天交付、含 delta 复核），本次将其从个案上升为规范默认

## 验证

- 文档内容：lint:skills 通过；决策树、前置闸、反模式三处文字一致（交叉引用锚点有效）
- 行为生效：依赖后续 PR 处置时 LLM 遵循协议——下次出现「强关联发现想建 issue」场景时，处置回应应出现关联度判断与合法清单命中论证
