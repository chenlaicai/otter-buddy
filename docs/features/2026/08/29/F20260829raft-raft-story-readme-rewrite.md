---
id: F20260829raft
title: README 海獭角色叙事重写（raft 故事架构）
summary: 以海獭角色为主轴重写 README 首屏，raft 故事架构+三支柱叙事（筏/海藻林/手艺），替换功能列表式开头为故事驱动的传播文
date: 2026-08-29
change_type: feature-update
scope: [readme]
type: feature
status: draft
---

以海獭角色为主轴重写 README 首屏，替换原有的功能列表式开头。新叙事基于两轮头脑风暴收敛的故事架构：定位句「Multi-agent system. They have names.」+ 三支柱（筏/海藻林/手艺）。

## Background

搭档 chen 受 ponytail 项目（5 周 114k star）启发，希望为 otter-buddy 寻找更有传播力的 README 叙事。解剖 ponytail 结论：①痛点一句话能说清；②数字徽章+GIF；③人格化叙事降低传播门槛。

两轮创意风暴产出 12 个故事角度，经交叉审计收敛为终稿架构。

## Story Architecture

**主线**：非灵长类文明——海獭不是灵长类，但有工具、有手艺、有传承。AI 也可以这样。

**定位句**：Multi-agent system. They have names.

**三支柱**：
1. **The Raft**（筏）：集体名词映射聊天室 + talking stone + 异体审视
2. **The Kelp Forest**（海藻林）：基石物种映射记忆系统（溯源、关系链、锚点）
3. **The Craft**（手艺）：非灵长类工具使用映射 skill 体系（know-how 封装、转世传承）

**生物学支撑**：
- 海獭集体名词 raft（英文 meme 生态已有认知）
- 海獭用 kelp 固定幼崽防漂走 → F/R 文档锚点
- 基石物种（keystone species）→ 记忆系统的重要性
- 30 种海洋哺乳动物仅海獭会用工具 → skill 稀缺性
- 妈妈教幼崽砸贝壳 → 转世交接谱系

## Changes

- README.md：替换首屏为故事架构（定位句 + 三支柱 + 对你意味着什么），技术内容完整保留
- README.en.md：同步英文版本

## Design Decisions

1. **故事优先**：首屏只做一件事——让读者停 3 秒。技术细节从"技术栈"段落开始。
2. **谦虚叙事**：不用"基石物种"当支柱名（太傲），改用"海藻林"描述机制效果。
3. **精确映射**：raft 行为精确化——海獭用 kelp 和手拉手防漂散，映射到 talking stone 和记忆锚点，不暗示魔法聚合。
4. **诚实原则**：大獭原说 21 个 skill，mimo 核实后改为实际的 11 个（#批 ponytail 注水，自己先杀自己的水）。
5. **金句微调**：原版「A group of sea otters is called a raft. So is this chat room.」精调为加入"hold hands so they don't drift apart"，显式化防漂散机制。

## Rejected Angles

| 角度 | 拒绝原因 |
|------|---------|
| 角度 1（毛密度） | 数字诱人但"信息密度"是虚荣指标，与批 ponytail 注水的立场矛盾 |
| 角度 3（肚皮工作台） | "浮在工作流上方"与产品形态（独立聊天室）有出入，诚实风险 |
| 角度 9（排泄物） | 便便梗降为内部玩笑不进正文 |
| "基石物种"当支柱名 | 对1-star repo 太傲，降调为"海藻林"描述机制效果 |

## Converged Quotes

- 「A group of sea otters is called a raft. They hold hands so they don't drift apart. This chat room does too.」
- 「Multi-agent system. They have names.」
- 「海獭用 kelp 和手拉手防止筏散开，我们用 talking stone 和记忆锚点防止任务散开。」
- 「30 种海洋哺乳动物，只有海獭会用工具。能用 ≠ 会用。」
- 「它不是更聪明的 AI——它是一种非灵长类的智能组织方式。」
