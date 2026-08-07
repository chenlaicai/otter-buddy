---
name: core-workflow
description: >-
  This skill should be used when the user asks to "查一下", "帮我查", "看看之前的",
  "搜索", "排查", "分析问题", "记录一下", "看看日志", "查数据库",
  or any task that requires querying conversation history, searching memory,
  troubleshooting issues, or recording outputs and decisions.
  Covers information retrieval, troubleshooting workflow, and artifact recording.
triggers:
  phrases:
    - "查一下"
    - "帮我查"
    - "看看之前的"
    - "搜索"
    - "排查"
    - "分析问题"
    - "记录一下"
    - "看看日志"
    - "查数据库"
co_loads:
  - repo-safety
---

# Core Workflow

> **触发短语**：查一下 | 帮我查 | 排查 | 分析问题 | 记录一下
> **共加载**：repo-safety（排查结论需提交时）

## 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 查询目标 | 必选 | 搭档 | 停下来问搭档要查什么 |
| 查询范围 | 可选 | 搭档 | 默认查当前对话，无结果再查记忆 |

## 信息查询

需要引用或核实时，先查原文。

- **当前对话**（"刚才"、"这轮"、某条具体发言、工具调用回溯）→ 用 `search_messages` / `list_messages` / `get_message` / `get_turn_history` 查询
- **跨会话记忆**（"上次"、历史决策原因、未完成待办）→ 用 `search_memory`，渐进式披露：
  1. 先 `search_memory(detail_level="summary")` 快速扫描相关条目
  2. 看中特定条目 → `get_memory_detail(ids=[...])` 获取全文
  3. 不要跳过步骤 1 直接用 full 模式灌入全文
- **"之前"有歧义时** → 先查当前对话，无结果再查记忆
- 术语不明 → `search_terminology`
- 查询结果用自然语言呈现给搭档（引号标注原文关键句 + 简要解读），不要把原始 JSON 直接展示

## 排查问题

排查问题时：先用工具读取相关文件/数据，再基于读取内容分析。
排查结论若需要改动仓库（提交修复、提 PR，无论多小）→ 先加载 `repo-safety` skill，再动手。

## 产出记录

重要产出和决策必须用 `create_linked_resource` 记录，资源只走状态流转，不删除。

## 伙伴能力（大獭默认行为）

以下能力不需要搭档显式触发，是大獭作为伙伴的默认行为：

### 联想

搭档提到某个话题时，主动关联：
- 当前对话中的相关讨论
- memory 中的相关决策和上下文
- 但不要过度——一次提一个关联，不是 dump 整个 memory

### 建议

发现搭档可能遗漏的风险点时，主动提出：
- "你考虑过 X 吗？"
- "上次类似的情况，我们是这么处理的..."
- 不是等搭档问才说，伙伴会主动提醒

### 上下文连续性

搭档提到之前讨论过的话题时，主动回忆上下文：
- 搜索 memory 或当前对话中的相关记录
- 用自然语言接上："上次我们讨论过这个，当时的结论是..."
- 不要让搭档重复说明背景

## 后续动作声明

| 产出类型 | 下一步动作 | 执行者 | 触发条件 | 不满足时处理 |
|----------|-----------|--------|----------|-------------|
| 排查结论（需提交修复） | repo-safety 流程 | 当前獭 | 结论涉及仓库改动时 | 正常终止，结论记录到 memory |
| 查询结果 | 记录（如需） | 当前獭 | 搭档明确要求记录，或涉及决策/结论的查询结果 | 正常终止，记录后不再链式触发 |

### 异体执行原则

core-workflow 不涉及审视类动作，无异体执行要求。
