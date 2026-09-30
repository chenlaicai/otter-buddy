---
doc_type: feature
id: F20260930skct
title: README skill 计数订正：11 → 14
summary: README.md 两处「11 个 skill」与 .pi/skills/ 实际 14 个不符，订正为 14。发现来源：系统能力演示第 04 场对抗审视中，素材獭事实核查自报、检视獭复核确认（README.md:27/:51 两处）。
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

- README.md:27「11 个 skill 为骨架」→「14 个 skill 为骨架」
- README.md:51「我们的 11 个 skill」→「我们的 14 个 skill」

## 发现链

1. 演示第 02 场：素材獭产出对外介绍素材时事实核查，自报「README 写 11 个 skill，.pi/skills/ 实际 14 个」，素材按 14 采信
2. 演示第 04 场：检视獭复核确认属实（README.md:27、:51 两处），建议另立修复
3. 大獭处置：作为演示第 05 场「完整开发流」的真实选题——演示修真实问题，不编造改动

## 后续风险说明

计数硬编码仍会随 skill 库生长再次漂移。本次不引入「不带计数表述」的写法变更（属措辞决策，超出本次订正范围；如需，由后续 README 措辞迭代处理）。
