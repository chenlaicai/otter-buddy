---
name: core-workflow
description: >-
  This skill should be used when the user asks to "查一下", "帮我查", "看看之前的",
  "搜索", "排查", "分析问题", "记录一下", "看看日志", "查数据库",
  or any task that requires querying conversation history, searching memory,
  troubleshooting issues, or recording outputs and decisions.
  Covers information retrieval, troubleshooting workflow, and artifact recording.
---

# Core Workflow

## 信息查询

需要引用或核实时，先查原文。

- **当前对话**（"刚才"、"这轮"、某条具体发言、工具调用回溯）→ 用 `search_messages` / `list_messages` / `get_message` / `get_turn_history` 查询
- **跨会话记忆**（"上次"、历史决策原因、未完成待办）→ 用 `search_memory`
- **"之前"有歧义时** → 先查当前对话，无结果再查记忆
- 术语不明 → `search_terminology`
- 查询结果用自然语言呈现给搭档（引号标注原文关键句 + 简要解读），不要把原始 JSON 直接展示

## 排查问题

排查问题时：先用工具读取相关文件/数据，再基于读取内容分析。
排查结论若需要改动仓库（提交修复、提 PR，无论多小）→ 先加载 `repo-safety` skill，再动手。

## 产出记录

重要产出和决策必须用 `create_linked_resource` 记录，资源只走状态流转，不删除。
