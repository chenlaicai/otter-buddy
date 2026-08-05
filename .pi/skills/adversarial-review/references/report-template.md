# Review Report Template

Use this format for adversarial review output.

```markdown
## 审查结论

[需要修改 / 可以合入（附条件）]

结论必须是二元的。"基本没问题"不是有效结论。

## 发现清单

### 问题 1：[简要描述]

- **维度**：正确性 / 边界条件 / 安全性 / 架构合规 / 测试覆盖 / 可维护性
- **位置**：`文件名:行号`
- **描述**：具体问题说明，引用代码片段
- **处置**：在当前 PR 修复 / 开发者回应（审查者认可）

### 问题 2：[简要描述]

...

## 变更完整性

确认以下项目：
- [ ] 所有设计文档中列出的改动范围都已覆盖
- [ ] 无遗漏的文件修改
- [ ] 测试覆盖了核心行为
- [ ] 构建通过
```

## Rules

- Every issue MUST have a disposition
- If ANY issue is unresolved, conclusion MUST be "需要修改"
- Each issue MUST cite `file:line` — no impression-based findings
- "无发现" is valid for a dimension — explicitly note it to confirm the dimension was checked, do NOT skip silently
- Do NOT reuse previous review comments for re-inspection — publish new ones

## 文档审视适配

审视对象是方案/设计文档（非代码）时：

- 结论选项"需要修改 / 可以合入"读作"需要修改 / 可以定稿"
- 变更完整性检查单中："测试覆盖了核心行为"→"方案含可验证的验收标准"；"构建通过"→"方案中的事实性断言已对照代码/既有文档亲验"
