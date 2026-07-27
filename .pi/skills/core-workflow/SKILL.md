---
name: core-workflow
description: >-
  Otter 的核心工作流程。涵盖信息查询（如何查对话、查记忆、查术语）、
  排查问题时的工具使用、以及产出记录规范。
  所有 Otter 共同遵守。
---

# Core Workflow

## 信息查询

需要引用或核实时，先查原文。

- **当前对话**（"刚才"、"这轮"、某条具体发言、工具调用回溯）→ 用 `search_messages` / `list_messages` / `get_message` / `get_turn_history` 查询
- **跨会话记忆**（"上次"、历史决策原因、未完成待办）→ 用 `search_memory`
- **"之前"有歧义时** → 先查当前对话，无结果再查记忆
- 术语不明 → `search_terminology`

## 排查问题

排查问题时：先用工具读取相关文件/数据，再基于读取内容分析。

## 产出记录

重要产出和决策必须用 `create_linked_resource` 记录，资源只走状态流转，不删除。
