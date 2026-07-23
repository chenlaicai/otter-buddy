---
id: F20260722hq1
title: history-query-skill
doc_type: feature

# 记忆索引
summary: |
  对话历史查询 Skill。系统已有 4 个消息查询工具（get_message / list_messages / search_messages / get_turn_history），
  但缺少 Skill 层的策略指引。本特性补全 history-query skill，定义何时以及如何查询当前对话的消息历史，
  与 memory-recall skill 形成互补：history-query 管会话内原始消息回溯，memory-recall 管跨会话持久化记忆。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260721m3r1
    - F20260721cap

# 元数据
status: locked
change_type: feature
tags: [agent, skills, history, conversation, message-query]
modules: [skills/]

# 时间
created_at: 2026-07-22
---


# F20260722hq1 对话历史查询 Skill

## 背景

### 问题

系统已有 4 个消息查询工具（`get_message` / `list_messages` / `search_messages` / `get_turn_history`），但 agent 在实际对话中缺少策略指引：

1. **不知道何时该查**：没有触发规则，agent 依赖上下文窗口记忆而非精确查询
2. **不知道怎么查**：4 个工具各有适用场景，但没有选择指南
3. **与记忆召回边界模糊**：用户提到"之前说的"，agent 不确定该查消息历史还是记忆系统

### 与 memory-recall 的关系

| 维度 | history-query（本特性） | memory-recall（F20260721m3r1） |
|------|------------------------|-------------------------------|
| 范围 | 当前对话的消息 | 跨会话的持久化记忆 |
| 数据源 | messages 表（原始消息） | memory_entries 表（索引/摘要） |
| 时效 | 实时，包含本轮对话 | 延迟，依赖索引周期 |
| 粒度 | 完整原文 | 渐进式披露（summary → full） |

两者互补，不冲突。选择依据：信息在当前对话中 → history-query；信息来自更早会话 → memory-recall。

## 用户意图锚

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "要增加当前对话的历史消息查询 skill" | 当前对话、历史消息 | 需要独立的 history-query skill | 用户指令 |
| UA-2 | "这与记忆召回有点重叠，但我认为这是必要的" | 重叠但必要 | 两种业务场景，需明确边界 | 用户指令 |
| UA-3 | "一个是本对话下的历史消息感知，一个是本系统中所有记忆数据的渐进式披露感知" | 两种场景 | history-query = 会话内，memory-recall = 跨会话 | 用户指令 |

## 目标

### T1 — 创建 history-query skill

独立的 skill，定义对话历史查询的触发条件、工具选择协议和禁止行为。

## 设计方案

### D1 — history-query SKILL.md

**触发规则（硬规则，必须查询）：**

1. 引用回溯：用户指向当前对话中特定发言
2. 决策核实：确认当前对话中某个决定的具体措辞
3. 列表/步骤回溯：用户要求重发之前的内容
4. 上下文断裂：长对话中 agent 不记得具体细节
5. 分歧裁决：对"之前说过什么"有争议

**触发规则（软规则，建议查询）：**

1. 连续讨论收尾时核实关键节点
2. 多轮修改追踪原始版本
3. 跨 Turn 续接时补充上下文

**工具选择协议：**

| 场景 | 工具 |
|------|------|
| 关键词搜索 | `search_messages` |
| 浏览最近消息 | `list_messages` |
| 获取特定消息 | `get_message` |
| 了解对话结构 | `get_turn_history` |

**渐进式查询：**

1. `search_messages` 或 `list_messages(limit: 10)` → 快速定位
2. `get_message` → 仅在需要详情时
3. `get_turn_history` → 仅在需要理解对话流程时

**禁止行为：**

- 不对非历史问题调用查询
- 不每次回复前查询
- 不展示原始 JSON
- 不用消息查询替代记忆召回
- 不查询超过需要的消息数量

### D2 — 无代码变更

消息查询工具已全部实现（`message-tools.ts`），工具已注册到所有 otter 类型（`tool-factory.ts` + `session-helpers.ts`）。本特性仅新增 SKILL.md 文件。

## 硬约束

1. 不引入代码变更——仅 skill 文件新增
2. history-query skill 使用中文（与其他 skill 一致）
3. 不改变现有工具层实现
4. 不改变工具分配规则（所有 otter 类型已可使用消息工具）

## 验证

- [ ] `.pi/skills/history-query/SKILL.md` 存在且格式正确
- [ ] SKILL.md 使用 YAML frontmatter 声明 name 和 description
- [ ] 与 memory-recall 的边界在文档中有明确说明
- [ ] 代码无变更（仅新增文件）
