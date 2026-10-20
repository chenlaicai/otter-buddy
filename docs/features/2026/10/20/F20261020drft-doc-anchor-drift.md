---
id: F20261020drft
title: 文档锚点防漂移口径 + F20261020mjfx 计数勘误
summary: 决策——文档不写 commit 计数（台账口径 git log --grep）、commit/代码引用用 subject 前缀与符号名锚（抗 rebase/squash/行号漂移）；勘误 F20261020mjfx 背景段「七个 commit 收口」快照计数
change_type: prompt   # 文档写作口径决策 + 勘误记录，无代码逻辑变更
capability_test: "台账口径实测：git log --grep '#1564' 自洽（#1567 squash 全量收口 + 本篇 follow-up）；subject 锚点合入后真实 main 实测 4 组全中（检视獭-1567 复核，命中 squash 4c071cfe）；勘误以新文档承载，F20261020mjfx 快照零改动（本 PR diff 只新增本文件，lint:historical-docs 不触线）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
intent:
  problem: "会腐烂的文本锚点在 F20261020mjfx 上一轮内三次显形：commit hash 两次 rebase 断链（d72xxx→10ffxxx→全灭）、commit 计数漂移（四→七→九三轮修正仍跟不上）、行号锚漂移（731→751）。且该文档已合入成快照（lint:historical-docs 禁改正文，机制非约定），勘误须走新文档通道。"
  expected_effect: "计数主张从文档消失（漂移源根除）；commit 引用一律 subject 前缀 + git log --grep 台账，rebase/squash 双场景不失效；代码引用用符号名不用行号。"
  verify_by:
    type: behavior_check
tags: [docs, decision, anchor]
modules: [docs]
from: [F20261020mjfx]
supersedes: []
causal_links:
  - F20261020mjfx 三麻 playtest 六问题修复（本篇勘误其背景段计数行，快照语义不改原文）
  - PR #1567 第二/三轮 delta 复核（检视獭-1567）：hash 死链与计数漂移两轮发现 + 建议4 + lint:historical-docs 通道判定
---

# 文档锚点防漂移口径 + F20261020mjfx 计数勘误

## 决策（口径三条）

1. **文档不写 commit 计数**——「N commit 收口」类主张随修复/处置递增必然漂移（F20261020mjfx 一轮内错三次：四→七→九）。需要台账时写查询口径：`git log --grep '<issue/PR 编号>'`，让数字永远可现场重算。
2. **commit 引用用 subject 前缀，不用短 hash**——hash 在 rebase 后全体换号（#1564 一轮内断链两次）。subject 前缀连 squash 合入都存活：本仓 squash message 内嵌各单 commit subject（合入后真实 main 上 `git log --grep '检视2：立直后摸打约束'` 命中 #1567 squash 提交，检视獭-1567 实测四组全中）。
3. **代码引用用符号名（函数/分支），不用行号**——行号随演进漂移（#1567 复核中 `app.js` 731→751 一例）。

## 勘误（F20261020mjfx 快照，不改原文）

F20261020mjfx 背景段「七个 commit 收口（实现 4 + 首轮检视处置 3）」是漂移中的计数快照：#1564 的实际收口以 `git log --grep '#1564'` 为准（#1567 squash 合入即全部实现与检视处置，含两线并行处置的两份锚点收口 commit）。计数主张以台账为准；快照原文留置不动（lint:historical-docs 快照语义，F20260831dgim）。

## 影响范围

纯文档写作口径，无代码面。适用 docs/features、docs/research 后续写作；既有文档按快照语义不回改。
