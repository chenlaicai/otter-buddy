---
title: 记忆先行首响应原则
id: F20260917mfrc
summary: SYSTEM.md R4 新增「首响应原则」段 + search_memory description 注入首工具钩子，纠正 88% invoke 首响应跳过记忆直接翻代码的行为模式；效果经 search_query_logs 埋点可观测。
intent:
  problem: "2026-09-17 排查（search_query_logs 埋点）：88% invoke 首响应跳过记忆直接 grep/bash 翻代码（357 个 invoke 仅 43 个用过 search_memory；首工具 bash 155/read 112/search_memory 23），而召回质量本身不差（空结果率 1.1%）——是触发时机问题不是召回质量问题，与 F20260819 派工守卫的成本不对称同构。"
  why_now: "搭档目击现场后要求排查并拍板修复；埋点基线已就位（F20260826rcmp），此刻修可直接获得 before/after 对比数据。"
  expected_effect: "invoke 首工具分布中 search_memory 占比从基线 6.4%（9/16-17）升至少 2 个百分点以上（复验窗口可观测）；skill 覆盖任务不被拦截、纯新话题不被误拉入搜索。"
  verify_by:
    type: golden_replay
    scenes: [r4-summon-search-first]
    note: "本改动属日常小改采样协议（n=3 全过，排除严重退化）；跑 r4-summon-search-first 场景验证 R4 召唤前先搜不退化，并铸新场景 mfrc-first-response 覆盖首响应原则本身"
capability_test: "n/a: 纯 prompt 行为引导改动（SYSTEM.md 规则段 + tool description），无代码逻辑；行为效果经 search_query_logs 埋点对比观测，不适用单元测试"
created_at: 2026-09-17
change_type: prompt
tags: [memory, prompt, agent-behavior, first-response]
modules: [.pi/SYSTEM.md, src/interface-adapters/agent-runtime/tools/tool-factory.ts]
from: [F20260814mbex, F20260826rcmp]
supersedes: []
created_in_conversation: 156a6abc-1640-47c2-bba7-399e1ccf030f
---

# memory-first-recall：首响应先看记忆再翻代码

## 背景 [required]

2026-09-17 搭档目击：提了一个问题后，海獭直接用一大堆 grep 查目录、查代码，跳过记忆召回。大獭用 search_query_logs 埋点（F20260826rcmp）排查，数据锚点：

- 9/16-17 两天 357 个 invoke 里仅 43 个（12%）调过 search_memory，314 个（88%）完全未碰记忆
- invoke 首工具分布：bash 155、read 112、search_memory 仅 23——第一反应是「翻代码」不是「翻记忆」
- 工具调用大盘中 search_memory 占比 0.5%~0.7%（9/15: 57/10395）
- 召回质量本身不差：整体空结果率 1.1%（905 次查询仅 10 次零命中）——不是"搜了没用所以不搜"，是压根没想到要搜
- 獭间差异：大獭 5.9%（1305 invoke 中 77 个），检视獭群体绝大多数 0%

## 根因

触发时机问题，不是召回质量问题。SYSTEM.md R4 只约束 4 个硬场景（召唤前/排查/方案/引史），对「拿到新问题第一把工具抓什么」没有强引导；search_memory description 的 When 段落是被动式信号列表，没有对抗「手上有 bash/grep 能直达代码」的省力路径（与 F20260819 派工守卫发现的成本不对称同构：机制上翻代码比翻记忆顺手）。

## 改动 [required]

两处 prompt 改动，不含代码逻辑：

| 文件 | 操作 | 说明 |
|------|------|------|
| .pi/SYSTEM.md | 修改 | R4 顶部新增「首响应原则」段：新问题第一把工具先看记忆再翻代码；grep/bash 是记忆落空或需核实现状时的第二步。附召回质量数据锚点（空结果率约 1%）。末尾补一句「纯新话题/闲聊不受约束」防每轮必搜 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | search_memory description 首句后注入钩子：「收到新问题/新话题时，第一把工具先想记忆（grep/bash 翻目录是记忆落空后的第二步）」+ 行为锚点数据（88% 首响应跳过记忆是要纠正的模式） |

## 取舍

- 不走机制层硬强制（如首工具拦截）：成本低但误伤面大——很多 invoke（如纯代码检视、定时任务执行）首响应确实不需要记忆。prompt 引导 + R7 溯源展示的组合更符合"软引导 + 可观测"的既有路线（与 F20260814mbex 一脉相承）
- 数据锚点写进 prompt：给 LLM 一个"为什么要改"的事实依据，比空泛的行为指令更有牵引力；锚点数据会过时，但行为模式描述（首响应跳过记忆）长期有效

## 验证

- prompt 改动，无代码逻辑变化
- 效果可观测：search_query_logs 埋点持续记录，一周后对比 invoke 首工具分布中 search_memory 占比（基线 23/357 ≈ 6.4%，9/16-17）与 search_memory 使用率（基线 12%）
