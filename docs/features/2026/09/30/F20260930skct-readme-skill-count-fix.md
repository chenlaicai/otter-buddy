---
doc_type: feature
id: F20260930skct
title: README skill 计数移除：硬编码计数改为不带计数表述
summary: README.md / README.en.md 中「N 个 skill」硬编码计数与生长中的 skill 库天然矛盾（11→14 已漂移一次）。按搭档 9/30 产品判断（「计数会一直变，放到 readme 中不合适」），四处全部改为不带计数表述，根治漂移。发现来源：系统能力演示第 04 场对抗审视交叉核实。
change_type: fix
capability_test: "n/a——纯文档订正（verify_by=static_only：README 文案计数与 .pi/skills/ 目录数一致性，无运行时行为）"
intent:
  problem: "README.md:27 与 :51 两处写「11 个 skill」，但 .pi/skills/ 实际 14 个目录——skill 库生长后 README 未跟上，对外介绍材料引用时产生事实矛盾。"
  why_now: "2026-09-30 系统能力演示对话（cbd92936）第 04 场对抗审视中由素材獭/检视獭交叉核实确认；演示剧本第 05 场以此真实问题作为完整开发流选题。"
  expected_effect: "README 计数与 skill 目录一致，消除对外材料的引用矛盾。"
  verify_by:
    type: static_only
    reason: "纯文档订正，无代码路径变化。"
created_in_conversation: cbd92936-07ef-4ef6-8d38-49ef49f8215b
tags: [readme, docs-fix]
modules: [docs]
---

# README skill 计数订正：11 → 14

## 改动

终态（v2，搭档决策）：四处全部改为不带计数表述——

- README.md:27「14 个 skill 为骨架」→「skill 体系为骨架」
- README.md:51「我们的 14 个 skill」→「我们的 skill」
- README.en.md:28「14 skills as its skeleton」→「skills as its skeleton」
- README.en.md:52「Our 14 skills」→「Our skills」

过程记录（v1）：先按「11→14 计数订正」提交两个 commit（bdad97f3 中文两处、82ead140 英文两处补修——对抗审视发现英文版遗漏），后按搭档 9/30 产品判断改为不带计数表述（计数会一直变，放 README 不合适），根治漂移。

## 决策记录

- v1（计数订正）：演示第 04 场检视獭建议「改 14 或改不带计数表述」二选一，大獭当时选了计数订正
- v2（移除计数）：搭档 9/30 在 PR #1255 终审时提出「计数会一直变，放到 readme 中不合适」——产品判断，采纳。硬编码计数与生长中的 skill 库天然矛盾，任何数字都会再次漂移

## 发现链

1. 演示第 02 场：素材獭产出对外介绍素材时事实核查，自报「README 写 11 个 skill，.pi/skills/ 实际 14 个」，素材按 14 采信
2. 演示第 04 场：检视獭复核确认属实（README.md:27、:51 两处），建议另立修复
3. 大獭处置：作为演示第 05 场「完整开发流」的真实选题——演示修真实问题，不编造改动
4. 代码审视：代码检视獭发现英文镜像版 README.en.md 两处遗漏（中文 grep 模式匹配不到英文表述），补修
5. 终审：搭档判断硬编码计数本身不合适，改为不带计数表述



