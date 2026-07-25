# Technical Plan Output Template

Use this structure when producing a technical plan from requirement analysis.

```markdown
## 背景

为什么要做这件事。引用搭档的原始需求（意图锚）。

## 目标

要达成什么效果。列出具体、可验证的目标（T1, T2, ...）。

## 非目标

明确排除的内容。防止范围蔓延。

## 方案设计

具体的技术方案，包括：
- 涉及哪些模块/文件
- 核心逻辑设计
- 数据模型变更（如有）
- 关键接口定义（如有）

## 影响范围

这个方案会影响哪些已有功能。

## 风险与约束

已知风险点和需要注意的约束。

## 不兼容更新

如有破坏性变更，在此列出。标注 [Incompatible]。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| ... | ... | ... | ... |

## 验证

验收标准和测试设计。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| ... | 新增/修改/删除 | ... |
```

## Writing Rules

- 背景 must cite the user's original words (intent anchor), not a paraphrase
- 目标 uses numbered items (T1, T2, ...) for traceability
- 非目标 is mandatory — always explicitly state what is out of scope
- 设计取舍 records tradeoffs with alternatives and reasoning, not just the decision
- 改动范围 lists every file that will be touched
