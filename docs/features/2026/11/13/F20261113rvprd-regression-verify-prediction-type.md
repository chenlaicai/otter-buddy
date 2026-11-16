---
id: F20261113rvprd
title: 回归回查断言统一为「问题还在判据」：判据满足才重开，不满足即销案
doc_type: feature
change_type: fix
summary: "regression-verify 的「❌→重开」规则把断言一律按『证据满足=✅、不满足=❌』单向解读，导致『预言坏状态』类断言（如 #1067 的『golden-results.jsonl 仍不存在且 intent 率仍 <30%』）被证伪（=问题已消失、机制存活）时反而判 ❌ 重开已拍板终结的 issue。本特性把断言语义统一为『问题还在判据』：断言 = issue 作者写死的「什么条件满足 = 问题仍未解决/修复未兑现」；回查只判『判据是否成立』——成立 → ❌ 重开升级，不成立 → ✅ 销案关闭，绝不反向解读。"
intent:
  problem: "#1067 自 2026-10-23 搭档拍板『评测机制肯定要留』后，regression-verify 每日回查仍把断言字面不成立（golden 已存在、intent 率 60-100%）判 ❌，按『❌→重开』规则反复重开（10-30 收口关闭 → 11-10 又被重开）。根因：判定语义单向——『断言不成立』一律当『修复未兑现』，但 #1067 的断言写的是『问题还在』判据，不成立 = 问题已消失 = 好事。"
  why_now: "搭档指示按时间从古到今逐个处理 open issue，首件 #1067 就卡在『已拍板却反复重开』；搭档 2026-11-16 拍板修复口径：『当满足 XXXX 条件时问题还在→重开，只有这条标准，由提 issue 者自行写清楚』。"
  expected_effect: "断言到期回查只按『问题还在判据是否成立』判定：成立→重开升级；不成立→销案关闭，不再反向误重开；提 issue 模板同步要求把断言写成『问题还在判据』。"
  verify_by:
    type: human_judge
    note: "prompt 行为属 LLM 软强制（F20260917rgsv 定位为软强制，不做机器断言），由 daily regression-verify 运行时与 #1067 后续实际状态验证：判据不成立后 issue 不再被重开。"
capability_test: "n/a: prompt-only 修改，无代码路径"
created_at: 2026-11-13
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [self-optimization, regression, scheduler, prompt, issue-process]
modules:
  - prompts/scheduled/regression-verify.md
  - prompts/scheduled/daily-health-check.md
causal_links:
  - F20260917rgsv
  - F20261110rvded
---

# F20261113rvprd: 回归回查断言统一为「问题还在判据」

## 问题

#1067 的验证断言：「止损线 issue 创建后 30 天内 golden-results.jsonl 仍不存在且 intent 率仍 <30%（机制确认死亡/空心）」——这是「问题还在」的判据：两个条件都满足 = 问题仍在。

现实走向：golden-results.jsonl 建立并持续写入、intent 率回到 60-100%。判据**不满足** = 问题已消失、机制存活。但 regression-verify 按「证据满足断言 → ✅；不满足 → ❌」单向判定，把「判据不满足」判成 ❌，命中「❌ 已 closed → 重开升一级」，把「机制活着」当「修复未兑现」反复重开。

而 #1067 的实质决策（评测机制去留）已于 2026-10-23 由搭档拍板终结：「评测机制肯定要留啊」。重开 = 违背拍板 + 每日 ❌ 噪声循环（10-30 收口关闭 → 11-10 又被重开）。

## 根因

`prompts/scheduled/regression-verify.md` 的「判定/未通过处置」只有单向语义：「证据满足断言 → ✅；不满足 → ❌；❌ 已 closed → 重开升级」。这个语义隐含假设「断言 = 承诺修复会生效」（断言不成立 = 修复未兑现 = 真问题）。但断言的正确语义应是「问题还在判据」——不成立 = 问题已消失 = 好事，应销案而非重开。

## 修复契约

断言统一为「问题还在判据」，判定只认一个方向：

- **判据满足**（问题还在 / 修复未兑现）→ ❌ 未通过 → 已 closed 重开升一级，已 open 评论提醒。
- **判据不满足**（问题已消失 / 修复已兑现）→ ✅ 通过 → issue 若 open 按「问题已解决」销案关闭，若已 closed 保持不动，**绝不重开**。
- **证据不足** → ⚠️ 无法判定，保持 open 不动。

判定方向在提 issue 时由作者写死（「断言 = 什么条件满足 = 问题仍在」），回查只判「判据是否成立」，不反向解读。断言若写成「好结果」方向（如「修复后 X 不再发生」）而非「问题还在」方向 → 不猜方向，标 ⚠️ 退回改写。

配套：`prompts/scheduled/daily-health-check.md` 的 issue 产出规范同步要求「验证断言」段写成「问题还在判据」。

纪律新增：重开/升级的唯一判据 =「问题还在判据」成立；判据不满足绝不重开。

## 非目标

- 不改 `buildRegressionVerifyBody` 的清单生成（F20261110rvded 已处理 pass 排除；fail/unknown 仍保留在清单是正确的——允许后续回查）。
- 不做机器断言/硬门（沿用 F20260917rgsv 的「软强制」定位）。
- 不撤销 #1067 的搭档拍板结论。

## 验证记录

- prompt 为 LLM 软强制，无代码路径；`lint:docs` 验证 frontmatter 合规。
- 行为验收锚：#1067 后续日常回查不再出现「❌→重开」循环（判据不满足按销案关闭）。