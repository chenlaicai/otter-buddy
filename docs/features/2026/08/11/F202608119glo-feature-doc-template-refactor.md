---
id: F202608119glo
title: 按研发阶段重构特性文档模板
doc_type: feature

summary: |
  重构特性文档模板，解决 append-only 违反和编号不统一问题。
  删除 causal_links.to 字段，统一编号生成策略，按研发阶段组织模板结构。

causal_links:
  from: []

status: development
change_type: feature
tags: [documentation, template, agent-workflow]
modules:
  - docs/README.md
  - src/entities/document/frontmatter-validator.ts
capability_test: "n/a: 纯文档改动（A 类），无 LLM 参与行为"
---

# F202608119glo: 按研发阶段重构特性文档模板

## 背景与需求

### 问题描述

当前特性文档模板存在以下问题：

1. **causal_links.to 字段违反 append-only 原则**
   - 模板中有 `causal_links.to` 字段，这是前向引用
   - append-only 的文档不应有前向引用，当前文档写的时候，未来文档的 ID 根本不存在
   - 只有 `from` 字段有意义（记录因果上游）

2. **特性编号风格不统一**
   - 格式：`F\d{8}[a-z0-9]{3,8}`（8位日期 + 3-8位后缀）
   - 实际情况：格式上都符合规则，但风格不统一
   - 单词型：`speak`, `tools`, `guard`, `chunk`, `hybrid`
   - 随机型：`esm1`, `k3m7`, `dp01`, `ka23`
   - 问题：没有统一的编号生成策略，导致 LLM 每次创建时随机选择风格

3. **文档结构按功能分块，而非按研发流程组织**
   - 当前模板：背景、变更、设计决策、Acceptance Test
   - 问题：没有按研发阶段组织，LLM 不知道"现在该填什么"

### 根因分析

1. **causal_links.to 字段**：设计时考虑了双向引用，但 append-only 的文档不应有前向引用
2. **编号风格不统一**：没有统一的生成策略，LLM 创造性地"发明"单词后缀
3. **文档结构问题**：按功能分块，而非按研发阶段组织，LLM 在不同阶段不知道填什么

### 数据实锤

1. **causal_links.to 字段**：当前模板中有 `causal_links.to` 字段
2. **编号风格**：统计了 100+ 个特性文档，发现风格不统一
3. **文档结构**：当前模板按功能分块，LLM 在需求分析阶段不知道填什么

## 方案设计

### 技术方案

#### 1. 删除 causal_links.to 字段

**原因**：append-only 的文档不应有前向引用

**方案**：
- 删除 `causal_links.to` 字段，只保留 `from`
- 更新 frontmatter-validator.ts，删除 `causal_links.to` 校验

#### 2. 统一编号生成策略

**原因**：避免风格不统一

**方案**：
- 将 ID 格式从 `F\d{8}[a-z0-9]{3,8}` 改为 `F\d{8}[a-z0-9]{4}`
- 固定4位后缀，避免单词型 vs 随机型的风格不统一
- 更新 frontmatter-validator.ts 校验规则

#### 3. 按研发阶段重构模板结构

**原因**：LLM 在不同阶段有不同的"角色"，按阶段组织让 LLM 自然知道"现在该填什么"

**方案**：
- 按研发阶段组织模板结构
- 每个阶段有明确的内容要求
- 渐进式填充，不是一次性填完

### 目标

- T1: 删除 causal_links.to 字段，解决 append-only 违反
- T2: 统一编号生成策略，固定4位随机后缀
- T3: 按研发阶段重构模板结构（需求 → 设计 → 实现 → 验收）

### 成功标准

1. **causal_links.to 字段**：模板中不再有 `causal_links.to` 字段
2. **编号风格**：所有新文档使用固定4位随机后缀
3. **模板结构**：按研发阶段组织，LLM 在不同阶段知道填什么

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 删除 causal_links.to 字段 | 检查 docs/README.md 模板 | 不再有 causal_links.to 字段 |
| AT-2 | 统一编号生成策略 | 检查 frontmatter-validator.ts | ID 格式为 F\d{8}[a-z0-9]{4} |
| AT-3 | 按研发阶段重构模板结构 | 检查 docs/README.md 模板 | 模板按研发阶段组织 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 | n/a: 纯文档改动 |
| AT-2 | n/a: 纯文档改动 |
| AT-3 | n/a: 纯文档改动 |

## 实现细节

### 代码修改

1. **docs/README.md**：
   - 删除 `causal_links.to` 字段
   - 统一编号生成策略（固定4位随机后缀）
   - 按研发阶段重构模板结构

2. **src/entities/document/frontmatter-validator.ts**：
   - 删除 `causal_links.to` 校验
   - 更新 ID 格式校验规则

### 逻辑变更

1. **删除 causal_links.to 字段**：
   - 模板中不再有 `causal_links.to` 字段
   - 只保留 `causal_links.from` 字段

2. **统一编号生成策略**：
   - ID 格式从 `F\d{8}[a-z0-9]{3,8}` 改为 `F\d{8}[a-z0-9]{4}`
   - 固定4位随机后缀

3. **按研发阶段重构模板结构**：
   - 旧模板：背景、变更、设计决策、Acceptance Test
   - 新模板：背景与需求、方案设计、验收标准、实现细节、验收结果、对抗审视记录、设计决策

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| docs/README.md | 修改 | 特性文档模板 |
| src/entities/document/frontmatter-validator.ts | 修改 | ID 格式校验 |

## 验收结果

### 测试结果

[验收阶段填写]

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| 删除 causal_links.to 字段 | 证明完成 / 矛盾 / 未完成 / 证据不足 / 缺失 | ✅ / ❓ / ❌ |
| 统一编号生成策略 | 证明完成 / 矛盾 / 未完成 / 证据不足 / 缺失 | ✅ / ❓ / ❌ |
| 按研发阶段重构模板结构 | 证明完成 / 矛盾 / 未完成 / 证据不足 / 缺失 | ✅ / ❓ / ❌ |

## 对抗审视记录

[审视阶段填写]

## 设计决策

[可选，记录关键选择的 rationale]
