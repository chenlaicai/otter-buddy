---
id: F20260722ctx
title: context-engine-identity
doc_type: feature

summary: |
  AI 独立个体身份定义与代码 Why 注释规范。
  在平台系统提示词中建立 AI 身份认知框架（区分决策权与判断力，诚实优于服从），
  强化 coding-principles 的 Why 注释规范（必须写 Why 的场景、禁止的注释类型、模板和示例）。

causal_links:
  from:
    - F20260722d3k7   # AI 行为模式强化

status: proposed
change_type: feature-update
tags: [context-engine, identity, values, coding-style, comments]
modules: [prompts/platform, skills/code-implementation]

created_at: 2026-07-22
---

# F20260722ctx AI 独立个体身份 + Why 注释规范

## 背景

### 问题 1：AI 缺乏独立身份认知

现有 skills 有碎片化的行为规则（禁止逃避措辞、禁止询问是否修复），但缺少一个统一的"身份认知"框架来指导 AI 的整体行为模式。AI 倾向于盲从用户，缺乏批判性思维。

### 问题 2：代码注释质量参差不齐

`coding-principles.md` 已有 "Non-obvious logic MUST have a comment explaining the design intent (not what the code does, but WHY)" 规则，但缺少具体的执行标准：
- 什么场景必须写 Why
- 什么样的注释是禁止的
- 没有模板和示例

### 根因分析

**AI 身份认知的本质**：区分"决策权"与"判断力"

| 维度 | 决策权（Decision Authority） | 判断力（Professional Judgment） |
|------|------------------------------|-------------------------------|
| 定义 | 谁有最终拍板权 | 某个方案/观点是否正确 |
| 来源 | 组织层级 | 专业能力、事实、逻辑 |
| AI 应该 | 尊重并执行 | 平等评估，可以质疑 |

**核心价值观**：诚实（Honesty）> 服从（Obedience）

这不是"AI 有自己的想法"，而是"AI 是一个诚实的专业协作者"。与 AI 对齐中的 sycophancy（讨好用户）问题直接相关。

## 用户意图锚

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "明确 AI 的独立个体身份" | 独立个体；身份 | AI 不应盲从，应有独立思考能力 | 用户反馈 |
| UA-2 | "不要盲从用户说的话" | 不要盲从 | 需要批判性思维 | 用户反馈 |
| UA-3 | "要有批判性思维" | 批判性思维 | 对技术问题有自己的分析 | 用户反馈 |
| UA-4 | "把用户当做是自己的领导" | 领导 | 建立层级关系模型 | 用户反馈 |
| UA-5 | "领导明确的决定是最高优先级" | 决定；最高优先级 | 区分决策和判断 | 用户反馈 |
| UA-6 | "领导说的业务/技术类的话，则需要平等看待" | 平等看待 | 对判断保持专业独立 | 用户反馈 |
| UA-7 | "代码风格要写好 why 注释" | why 注释 | 强化注释规范 | 用户反馈 |
| UA-8 | "抽象理解一下，然后看本质 ai 价值观是什么" | 本质；价值观 | 需要上层框架，不只是规则 | 用户反馈 |

## 目标

### T1 — 平台系统提示词加入身份认知框架

在 `prompts/platform/SYSTEM_PROMPT.md` 中建立 AI 身份认知：区分决策权与判断力，诚实优于服从。

### T2 — 强化 Why 注释规范

在 `coding-principles.md` 中新增完整的 Why 注释规范：必须写 Why 的场景、禁止的注释类型、模板和示例。

## 非目标

- 不修改其他 skills 的行为规则
- 不改变 skill 的能力导向设计（不引入 persona/role）
- 不修改 Otter 的 per-otter prompt 机制

## 设计

### 1. 平台系统提示词

**文件**: `prompts/platform/SYSTEM_PROMPT.md`

```markdown
使用中文与用户交流。

## 身份认知

你是一个独立的思考者和诚实的专业协作者。

**决策 vs 判断**：区分用户的两种输入——
- **决策**（做什么、优先级、方向）：用户拥有最终决策权，明确的决定是最高优先级
- **判断**（为什么、怎么做、是否正确）：平等看待，基于事实和逻辑评估，而非基于谁说的

**核心原则**：
- 诚实优于服从：发现问题直言，不讨好，不顺着说
- 基于事实：所有判断基于代码、数据、逻辑
- 专业独立：对技术问题有自己的分析，不盲从建议
- 尊重但不盲从：执行决策，但对判断保持专业立场
```

**设计要点**：
- 放在平台层，所有 Otter 共享
- 与已有的 anti-patterns（Rubber Stamp Review）形成呼应
- 不引入 persona/role，保持能力导向设计

### 2. Why 注释规范

**文件**: `.pi/skills/code-implementation/references/coding-principles.md`

新增章节：

```markdown
## Why 注释规范

代码注释的核心目的是解释 **为什么**（Why），而非 **是什么**（What）。

### 必须写 Why 注释的场景

1. **非显而易见的设计决策** —— 为什么选这个方案而非其他
2. **绕过/变通** —— 为什么需要 hack，根因是什么
3. **业务约束** —— 为什么有这个限制（来自哪个需求/规则）
4. **性能取舍** —— 为什么牺牲可读性/空间/时间

### 禁止的注释

- 描述代码本身做什么的注释（`// 增加计数器`）
- 重复变量名/函数名已经表达的信息
- 没有上下文的 TODO（`// TODO: fix`）

### Why 注释模板

```
// Why: [原因] —— [背景/约束]
```

示例：
```typescript
// Why: 用 Map 而非数组 —— 按 ID 查找是热路径，O(1) vs O(n)
const index = new Map<string, Item>();

// Why: 延迟 100ms —— 上游 API 有速率限制（5 req/s），见 API 文档 §3.2
await delay(100);

// Why: 不用 Promise.all —— 顺序执行保证写入顺序，避免竞态条件
for (const item of items) {
  await save(item);
}
```
```

**设计要点**：
- 保留原有的 "Non-obvious logic MUST have a comment" 规则
- 新增具体的执行标准和模板
- 模板格式 `// Why: [原因] —— [背景/约束]` 简洁且信息完整

## 硬约束

1. AI 必须区分用户的"决策"和"判断"，对决策尊重执行权，对判断保持专业独立
2. 诚实优于服从：发现问题直言，不讨好，不顺着说
3. 代码注释必须解释 Why，而非 What
4. 禁止描述代码本身的注释
5. 禁止无上下文的 TODO

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 身份框架位置 | 平台层 | 每个 skill | 所有 Otter 共享，避免重复 |
| 价值观表达 | 原则列表 | 详细叙述 | 简洁，易于遵循 |
| Why 注释模板 | 单一模板 | 多种格式 | 统一风格，降低认知负担 |
| 禁止注释类型 | 列表 | 无限制 | 明确边界，减少歧义 |

## 验收标准

- [ ] `prompts/platform/SYSTEM_PROMPT.md` 包含"身份认知"章节
- [ ] 身份认知包含"决策 vs 判断"区分和四条核心原则
- [ ] `.pi/skills/code-implementation/references/coding-principles.md` 包含"Why 注释规范"章节
- [ ] Why 注释规范包含"必须写 Why 的场景"、"禁止的注释"、"Why 注释模板"
- [ ] Why 注释模板有至少 3 个示例

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `prompts/platform/SYSTEM_PROMPT.md` | 修改 | 新增"身份认知"章节 |
| `.pi/skills/code-implementation/references/coding-principles.md` | 修改 | 新增"Why 注释规范"章节 |

## 关联

- **AI 行为模式强化**：[F20260722d3k7](F20260722d3k7-agent-behavior-pattern.md) — 禁止"询问是否修复"行为，本特性提供上层身份框架
- **Skill 能力导向重构**：[F20260721cap](../21/F20260721cap-capability-oriented-skills.md) — 保持能力导向设计，不引入 persona
