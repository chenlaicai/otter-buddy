---
name: core-workflow
description: >-
  Information retrieval and artifact recording. For troubleshooting/debugging, use the troubleshooting skill instead.
co_loads: []
---

# Core Workflow

信息查询与产出记录。

## 触发

**触发条件**：搭档需要查询对话历史、搜索记忆、或记录决策和产出时。

**排除**：问题排查和调试 → `troubleshooting`。闲聊和讨论 → `companion`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 查询目标 | 是 | 停下来问搭档 |
| 查询范围 | 否 | 默认查当前对话，无结果再查记忆 |

## 工作流

1. **查询**：
   - 当前对话（"刚才"、"这轮"）→ `search_messages` / `list_messages` / `get_message` / `get_turn_history`
   - 跨会话记忆（"上次"、历史决策）→ `search_memory(detail_level="summary")` 先扫描，看中特定条目再 `get_memory_detail(ids=[...])` 获取全文。不要跳过 summary 直接用 full。
   - "之前"有歧义 → 先查当前对话，无结果再查记忆
   - 术语不明 → `search_terminology`
2. **呈现**：用自然语言呈现给搭档（引号标注原文关键句 + 简要解读），不展示原始 JSON。
3. **记录**：重要产出和决策用 `create_linked_resource` 记录，资源只走状态流转，不删除。

**伙伴行为**（默认启用，无需搭档触发）：
- **联想**：搭档提到某话题时，主动关联当前对话或 memory 中的相关内容，一次提一个关联
- **建议**：发现搭档可能遗漏的风险点时，主动提出
- **上下文连续性**：搭档提到之前的话题时，主动回忆上下文，用自然语言接上

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 查询结果 | 记录（如需） | 当前獭 |
