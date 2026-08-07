---
id: F20260807eval
title: feature-evaluability
doc_type: feature

summary: |
  定义特性文档的可评估性机制：F 文档增加 ## Acceptance Test 章节，AI 从问题推导验收需求、定义权威证据、写能力测试、执行验收、判定证据质量。用户全程不参与验收，只在合入后使用。启发来源：Codex goal 模式的 Completion Audit。

causal_links:
  from:
    - F20260806tstr   # 能力测试框架：Acceptance Test 复用其基础设施
    - F20260804dglp   # 退化输出修复：首个实践 Acceptance Test 的案例
  to: []

status: design
change_type: feature-update
tags: [documentation, testing, acceptance-test, capability-test, evaluability]
modules:
  - docs/README.md

created_at: 2026-08-07
---

# F20260807eval: 特性可评估性机制

## 背景

### 问题

很多问题反反复复出现多次修复都没修好。AI 编码时代，LLM 无法完整逐行分析代码，导致：
- 测试能通过（AI 会写测试覆盖它理解的路径）
- 但真实场景的边界条件被遗漏
- 合入后才发现没修好 → 反反复复

**根本原因**：合入前没有"什么算解决了"的明确定义，验收依赖人的主观判断。

### 设计目标

- **AI 自动验收**：从问题描述推导验收需求，写能力测试，执行验收，判定证据质量
- **用户不参与验收**：用户只提出问题、拍板决策、合入后使用
- **合入前确认**：不依赖合入后的长期观测
- **证据驱动**：不确定的证据 = 未达成

### 启发来源

Codex goal 模式的 Completion Audit：
1. 从目标推导具体需求
2. 为每个需求找权威证据
3. 检查当前状态的实际来源
4. 判定证据质量（证明完成 / 矛盾 / 未完成 / 证据不足 / 缺失）
5. 不确定的证据 = 未达成

## 变更

### 1. F 文档模板增加 `## Acceptance Test` 章节

在 `docs/README.md` 模板中增加结构化的验收测试章节：

```markdown
## Acceptance Test（验收测试）

### 需求推导
从问题描述推导出的具体可验证需求：
1. [需求1]：[一句话描述]
2. [需求2]：[一句话描述]

### 权威证据
| 需求 | 权威证据来源 | 证据类型 |
|------|-------------|---------|
| [需求1] | [什么能证明它被满足了] | 文件内容 / 命令输出 / 运行时状态 / 测试结果 |

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|---------|
| AT-1 | [需求1] | [具体步骤] | [可验证的结果] |

### 能力测试映射
| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 | tests/capability/xxx.capability.test.ts |

### 证据判定（验收执行后填写）
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| [需求1] | 证明完成 / 矛盾 / 未完成 / 证据不足 / 缺失 | ✅ / ❓ / ❌ |
```

### 2. 增加 Acceptance Test 编写指南

详细说明如何编写验收测试：
- **需求推导**：从问题描述推导具体可验证需求
- **权威证据**：定义什么能证明需求被满足
- **验收场景**：把需求转化为可执行的复现步骤
- **能力测试映射**：每个场景对应一个能力测试用例
- **证据判定**：按 Codex Completion Audit 风格判定证据质量

### 3. 明确 `capability_test` 与 `## Acceptance Test` 的关系

- `capability_test` frontmatter 指向能力测试文件（怎么验证）
- `## Acceptance Test` 章节定义验收场景和证据判定（什么算解决了）
- 验收执行后，证据判定表格记录结果

## 设计决策

1. **结构化表格而非叙事散文**：验收场景用表格定义，便于 AI 解析和执行
2. **证据质量判定借鉴 Codex**：证明完成 / 矛盾 / 未完成 / 证据不足 / 缺失五种状态
3. **不确定 = 未达成**：保守策略，避免"看起来能跑"但实际没修好
4. **复用现有能力测试框架**：不修改 `tests/capability/helpers/*`，只在 F 文档层面建立规范
5. **用户不参与验收**：验收全程由 AI 自动完成，用户只在合入后使用

## Acceptance Test（验收测试）

### 需求推导

1. **需求1**：F 文档模板包含结构化的 Acceptance Test 章节
2. **需求2**：Acceptance Test 编写指南清晰可执行
3. **需求3**：capability_test 与 Acceptance Test 的关系明确

### 权威证据

| 需求 | 权威证据来源 | 证据类型 |
|------|-------------|---------|
| 需求1 | docs/README.md 模板内容 | 文件内容 |
| 需求2 | docs/README.md 编写指南 | 文件内容 |
| 需求3 | docs/README.md 关系说明 | 文件内容 |

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|---------|
| AT-1 | 需求1 | 读取 docs/README.md 模板 | 包含 ## Acceptance Test 章节，含五个子章节 |
| AT-2 | 需求2 | 读取 docs/README.md 编写指南 | 包含需求推导、权威证据、验收场景、能力测试映射、证据判定的说明 |
| AT-3 | 需求3 | 读取 docs/README.md 关系说明 | 明确 capability_test 与 Acceptance Test 的配合使用方式 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 | 本变更为文档变更，无能力测试（A 类） |
| AT-2 | 本变更为文档变更，无能力测试（A 类） |
| AT-3 | 本变更为文档变更，无能力测试（A 类） |

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| 需求1 | 证明完成 | ✅ |
| 需求2 | 证明完成 | ✅ |
| 需求3 | 证明完成 | ✅ |

## 涉及文件

| 文件 | 改动 |
|------|------|
| `docs/README.md` | 模板增加 ## Acceptance Test 章节 + 编写指南 + 关系说明 |
| `docs/user-guide/testing.md` | 增加 Acceptance Test 与能力测试关系说明，指向 skill |
| `.pi/skills/code-implementation/references/testing-rules.md` | 增加 Acceptance Test 执行流程：从验收场景推导能力测试、验收执行、证据判定 |

## 测试

- 本变更为文档变更，无代码改动
- 验证方式：读取 docs/README.md 确认模板和指南内容正确

## 关联

- F20260806tstr：能力测试框架，Acceptance Test 复用其基础设施
- F20260804dglp：退化输出修复，首个实践 Acceptance Test 的案例
