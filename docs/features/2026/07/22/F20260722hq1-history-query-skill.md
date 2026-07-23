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

详见 `.pi/skills/history-query/SKILL.md` 中的对比表格。核心区别：history-query 查询当前对话的原始消息，memory-recall 查询跨会话的持久化记忆。两者串联使用，先 history-query 再 memory-recall 兜底。

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

**核心原则**：需要引用或核实时精确回溯，不凭记忆猜测。上下文窗口中已有且不需要精确引用的信息，直接回答。

**触发规则（硬规则，必须查询）：**

1. 引用回溯：用户指向当前对话中特定发言
2. 决策核实：确认当前对话中某个决定的具体措辞
3. 列表/步骤回溯：用户要求重发之前的内容
4. 上下文断裂：上下文窗口搜索后仍找不到相关信息
5. 分歧裁决：对"之前说过什么"有争议
6. 工具调用回溯：用户问工具调用历史或失败原因
7. 元信息查询：用户问对话时长、消息数量等

**触发规则（软规则，建议查询）：**

1. 连续讨论收尾时核实关键节点
2. 多轮修改追踪原始版本
3. Turn 切换续接时补充上下文

**与 memory-recall 的边界判断**（关键词→查询路径映射）：

- "刚才"、"这轮"、"你刚才说的" → history-query
- "上次"、"记得当时" → memory-recall
- "之前"、"之前说的"（有歧义） → 先 history-query，0 结果再 memory-recall

**工具选择决策流程**：

```
有明确关键词？ → search_messages
需要浏览最近？ → list_messages
知道消息 ID？ → get_message
需要对话结构？ → get_turn_history
```

**参数指南**：

- `list_messages(limit, before)`：`before` 是游标分页参数
- `get_turn_history(includeMessages)`：`true` 包含 Turn 内消息
- `search_messages(query, limit)`：FTS5 trigram，搜索无结果可拆分关键词重试
- `get_message(messageId)`：按 ID 精确获取

**结果处理**：

- 无结果：正常回答，仅在明显指向更早会话时建议查记忆
- 有结果：引用原文关键句（引号标注）+ 简要解读，不罗列 JSON
- 长消息：截取相关段落，省略号标注

**错误处理**：

- `search_messages` 0 结果但用户确信 → 建议换关键词
- `get_message` not found → 告知可能已删除
- 工具超时 → 告知失败，建议重试

**禁止行为**（含正面替代）：

- 不每次都查询 → 只在明确信号出现时查询
- 不展示原始数据 → 提炼为自然语言
- 不越界 → 跨会话用 `search_memory`
- 不过度拉取 → 默认 `limit: 10`，需要时再分页
- 不忽略结果 → 查询后要基于结果回答

### D2 — 无代码变更

消息查询工具已全部实现（`message-tools.ts`），工具已注册到所有 otter 类型（`tool-factory.ts` + `session-helpers.ts`）。本特性仅新增 SKILL.md 文件。

## 硬约束

1. 不引入代码变更——仅 skill 文件新增
2. history-query skill 使用中文（与其他 skill 一致）
3. 不改变现有工具层实现
4. 不改变工具分配规则（所有 otter 类型已可使用消息工具）

## 验证

- [x] `.pi/skills/history-query/SKILL.md` 存在且格式正确
- [x] SKILL.md 使用 YAML frontmatter 声明 name 和 description
- [x] 与 memory-recall 的边界在文档中有明确说明（关键词→查询路径映射）
- [x] 代码无变更（仅新增文件）
- [x] 核心原则收紧为"需要引用或核实时"（对抗检视修复）
- [x] "上下文断裂"定义为可判断标准（对抗检视修复）
- [x] 补充遗漏场景：工具调用回溯、元信息查询（对抗检视修复）
- [x] 工具参数指南覆盖所有 4 个工具（对抗检视修复）
- [x] 结果处理具体化：引用格式、长消息截取（对抗检视修复）
- [x] 错误处理指导覆盖常见失败场景（对抗检视修复）
- [x] 禁止行为含正面替代（对抗检视修复）
