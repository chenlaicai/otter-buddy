---
id: F20260721m3r1
title: memory-recall-skill
doc_type: feature

# 记忆索引
summary: |
  记忆系统已搭建完成（search_memory / get_memory_detail / store_memory 工具），但 agent 在实际对话中从未主动触发过记忆召回。 根因：**tool 存在但 prompt 缺失。** `otter-shared` SKILL.md 中关于记忆召...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716t2ab


# 元数据
status: locked
change_type: feature
tags: [agent, skills, memory, recall]
modules: [skills/, prompts/platform/]

# 时间
created_at: 2026-07-21
---


# F20260721m3r1 记忆召回 Skill 补全

## 背景

### 问题

记忆系统已搭建完成（search_memory / get_memory_detail / store_memory 工具），但 agent 在实际对话中从未主动触发过记忆召回。

根因：**tool 存在但 prompt 缺失。** `otter-shared` SKILL.md 中关于记忆召回的指引仅一句——"检索记忆后再回答历史相关问题"——过于模糊，不足以让 LLM 形成稳定的召回习惯。

### 现状分析

| 层 | 状态 | 问题 |
|----|------|------|
| Tool 层 | ✅ search_memory / get_memory_detail 已实现 | 无 |
| Prompt 层 | ❌ otter-shared 仅一句模糊指引 | agent 不知道何时该召回 |
| System Prompt | ❌ 空文件 | 无平台级行为约束 |

额外发现：`otter-shared` 的三条规范（消息、记忆、上下文）各自只有一两句模糊指引，实际效果存疑。其中"使用中文"属于平台级约束，不应放在 skill 中。

## 用户意图锚

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "是否没有对应的记忆召回 skill？" | 召回 skill 缺失 | 需要独立的 memory-recall skill 定义触发规则 | 对话 |
| UA-2 | "直接移除整个 shared" | shared 冗余 | otter-shared 整段删除，有效内容拆分到对应位置 | 对话 |
| UA-3 | "用中文这一点应该写入系统提示词文件中" | 平台级约束 | "使用中文"属于全局规则，放入 platform system prompt | 对话 |

## 目标

### T1 — 创建 memory-recall skill

独立的 skill，定义记忆召回的触发条件、渐进式披露协议和禁止行为。

### T2 — 移除 otter-shared

删除整个 `skills/otter-shared/` 目录。其内容拆分至：
- "使用中文" → `prompts/platform/SYSTEM_PROMPT.md`
- 记忆召回 → `skills/memory-recall/SKILL.md`（T1）
- 其余（消息规范、上下文管理）→ 删除（效果存疑，不保留）

### T3 — 平台 system prompt 注入中文规则

在 `prompts/platform/SYSTEM_PROMPT.md` 中写入"使用中文与用户交流"。

## 设计方案

### D1 — memory-recall SKILL.md

**触发规则（硬规则，必须召回）：**

1. 用户提到"上次"、"之前"、"记得"等历史回溯表述
2. 用户问某个决策的原因/背景/约束
3. 遇到不确定的项目域术语 → search_terminology
4. 接收到 handoff summary 中的未完成事项
5. 用户提问涉及当前对话中没有的信息

**触发规则（软规则，建议召回）：**

1. 复杂任务启动时
2. 方案设计前
3. 编码命名时确认术语一致性

**渐进式披露协议：**

1. `search_memory` + `detail_level: "summary"` → 快速扫描
2. `get_memory_detail` → 仅在需要深入时使用
3. `search_terminology` → 独立查术语

**禁止行为：**

- 不对简单问题调用记忆检索
- 不每次回复前都搜索
- 不展示原始 JSON 结果

### D2 — 删除 otter-shared

`otter-shared` 的三条规范拆分后不再需要保留。ResourceLoader 自动发现 `skills/` 下所有 SKILL.md，删除一个目录不影响其他 skill 加载。

### D3 — platform system prompt

```markdown
使用中文与用户交流。
```

通过 `PiSessionFactory` 的 `platformPromptFile` 配置加载，作为消息前缀注入。

## 硬约束

1. 不引入代码变更——仅 skill 文件和 prompt 文件的增删
2. memory-recall skill 必须使用中文（与其他 skill 一致）
3. 不改变 tool 层实现（search_memory / get_memory_detail 参数不变）

## 验证

- [x] `skills/memory-recall/SKILL.md` 存在且格式正确
- [x] `skills/otter-shared/` 已删除
- [x] `prompts/platform/SYSTEM_PROMPT.md` 包含中文规则
- [x] 代码中无硬引用 `otter-shared`（仅设计文档中的历史记录）
