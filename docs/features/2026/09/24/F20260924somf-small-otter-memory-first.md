---
title: 小獭身份文案补记忆先行引导
id: F20260924somf
summary: SMALL_OTTER.md 身份文案注入「记忆先行（R4 精简版）」段，补齐小獭侧 R4 首响应原则触达缺口；不追求比例，遵循「工具必提供、用法说明清、用不用 LLM 决策」的搭档原则。
intent:
  problem: "F20260917mfrc 一周复验（9/18-24）：大獭首工具 search_memory 率 2.9%→8.4%（3 倍提升），但小獭 4.3%→1.5% 未受益——小獭身份 prompt 是独立的 SMALL_OTTER.md，不含 SYSTEM.md R4 首响应原则，prompt 触达有缺口。"
  why_now: "复验当日搭档拍板（原话）：「工具必须提供在这，然后用法咱们系统需要说明清楚，最终是否使用则交由 llm 自行思考决策……你明确了 r4 里的引导非常关键，那我觉得也应该给小獭也加一下你说的引导」。不追求小獭使用比例，追求的是该想到时想得到。"
  expected_effect: "小獭身份 prompt 携带记忆先行引导；小獭侧首工具 search_memory 率不设目标值（检视獭等 skill 覆盖任务被正确豁免是设计行为），复验只确认引导文案触达。"
  verify_by:
    type: human_judge
    note: "小獭运行时行为无固定输出格式可断言；搭档 9/24 拍板『用不用由 LLM 自行决策、不追求比例』，铸门强制使用与该拍板直接矛盾，故不设 golden 场景"
capability_test: "n/a: 纯 prompt 文案改动（SMALL_OTTER.md 单文件单段落），无代码逻辑；golden 场景 mfrc-first-response 守护的是大獭侧 R4 原则，小獭侧不设比例目标故不铸新门"
change_type: prompt
tags: [memory, prompt, small-otter, identity, first-response]
modules: [prompts/identity/SMALL_OTTER.md]
from: [F20260917mfrc]
supersedes: []
created_in_conversation: 156a6abc-1640-47c2-bba7-399e1ccf030f
---

# 小獭身份文案补记忆先行引导

## 背景 [required]

F20260917mfrc（PR #1014，9/17 合入）给大獭侧 SYSTEM.md R4 补了首响应原则。一周复验（2026-09-24，search_query_logs 埋点，9/18-24 窗口 53 对话/1056 invoke）：

- 大獭首工具 search_memory 率 2.9% → 8.4%（约 3 倍，逐日 6-10% 稳定）
- golden 场景 mfrc-first-response 真实采样多次 3/3 全过
- **小獭 4.3% → 1.5% 未受益**——小獭身份 prompt 是独立的 `prompts/identity/SMALL_OTTER.md`，不含 SYSTEM.md R4 全文，首响应原则没有触达小獭

搭档 9/24 拍板（原话引用）：「工具必须提供在这，然后用法咱们系统需要说明清楚，最终是否使用则交由 llm 自行思考决策。所以，小獭这个，咱们不追求比例，但如果说，你明确了 r4 里的引导非常关键，那我觉得也应该给小獭也加一下你说的引导」。

## 改动 [required]

`prompts/identity/SMALL_OTTER.md` 单文件，在「开工前先搜记忆」条目后新增「记忆先行（R4 精简版）」段：

- 首响应原则核心：拿到新问题第一把工具先看记忆再翻代码（grep/bash 是第二步）
- 首响应原则核心：拿到新问题第一把工具先看记忆再翻代码（数据锚点集中 SYSTEM.md 维护，本文件不含具体数字）
- 两条边界：skill 首步优先（A5）；纯新话题与闲聊不必搜
- 行为面留实质：「按任务需要自行判断，不必为搜而搜」（搭档政策原话由 why_now 留痕，不进注入面）

## 取舍

- 不把 SYSTEM.md R4 全文搬进小獭文案：R4 的 4 个硬场景（召唤前/排查/方案/引史）中「召唤前」对小獭无意义（小獭不能召唤），排查/方案场景大多已由派工简报覆盖；精简版只保留首响应原则核心 + 边界，与小獭文案体量匹配
- 不铸新 golden 门：铸门 = 以 golden 场景强制「首检索工具必须是 search_memory」，与搭档 9/24 拍板「最终是否使用交由 llm 自行思考决策」直接矛盾——这是「不铸门」的决定性理由（次要理由：检视獭类 skill 覆盖任务首响应直接读代码是 A5 豁免的设计行为，门需额外规避）
- 不动 otter-summon 派工范本：派工简报是任务级，身份文案是獭级——身份层注入覆盖所有小獭所有任务，是搭档「系统需要说明清楚」的正确层位

## 机制新增四问（配合 commit 的 Modification-Class: mechanism-addition 从严声明）

1. **谁需要**：全体小獭（身份 prompt 注入面覆盖所有小獭所有任务）
2. **失败后果**：注入失败时小獭行为回退到现状（无记忆先行引导），不新增故障面——文案加载失败仅触发 identity-builder 既有 warn 降级路径
3. **后续机制**：无；若未来 R4 首响应原则修订，需同步本段（两处精简文案的同步责任登记在本「验证」段）
4. **退役条件**：小獭身份文案改直读 SYSTEM.md R4 全文，或 R4 首响应原则本身废止

## 验证

- prompt 文案改动，无代码逻辑；无存量测试断言 SMALL_OTTER.md 内容（已 grep 确认）
- Golden Gate: n/a（verify_by=human_judge，无场景可跑）——小獭运行时行为效果属 human_judge，与「不铸门」取舍自洽
- 同步责任登记：R4 首响应原则修订时需同步本段精简版；数据锚点遵循 mfrc 轮先例集中 SYSTEM.md 维护，本文件不含具体数字

Modification-Class 说明：diff 仅为身份文案新增段落、无新配置/状态/定时任务/存储/信号，从严声明为 mechanism-addition（注入面行为契约新增），四问答案见上；若按 F20260917dscp 先例归为纯行为文本亦可，此处取从严。
