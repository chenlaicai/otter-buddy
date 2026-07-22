# Coding Principles

## Architecture Compliance

- Follow the project's layer constraints (e.g., Clean Architecture: domain → application → infrastructure)
- Do not skip layers — domain code should not directly call infrastructure
- Respect dependency direction: outer layers depend on inner layers, not vice versa

## Naming

- Match project terminology — use the same words the codebase uses for the same concepts
- When introducing a new term, check if an equivalent already exists
- Prefer descriptive names over abbreviated ones

## Code Quality

- Non-obvious logic MUST have a comment explaining the design intent (not what the code does, but WHY)
- No dead code — if it is not used, remove it
- No compatibility bridge code — the new design is the current design

## Why 注释规范

代码注释的核心目的是解释 **为什么**（Why），而非 **是什么**（What）。

### 必须写 Why 注释的场景

以下是最常见的场景，但不是唯一场景。任何非显而易见的设计意图都需要解释 Why。

1. **非显而易见的设计决策** —— 为什么选这个方案而非其他
2. **绕过/变通** —— 为什么需要 hack，根因是什么
3. **业务约束** —— 为什么有这个限制（来自哪个需求/规则）
4. **性能取舍** —— 为什么牺牲可读性/空间/时间

### What 注释的使用场景

禁止**冗余**的 What 注释（变量名/函数名已经表达的信息）。以下场景允许 What 注释：

- 复杂的正则表达式：`// 匹配邮箱格式`
- 复杂的算法步骤：`// 第一步：归一化数据`
- 非直观的 API 调用：`// 调用 delete API 实现软删除`
- 领域特定术语：`// 这里的 "booking" 指的是预约记录`

原则：**Why 优先，What 不绝对禁止，但禁止冗余**。

### Why 注释模板

```
// Why: [原因] —— [背景/约束]
```

多行格式：
```
// Why: [原因]
// - [细节 1]
// - [细节 2]
// - [参考]
```

示例：
```typescript
// Why: 用 Map 而非数组 —— 按 ID 查找是热路径，O(1) vs O(n)
const index = new Map<string, Item>();

// Why: 延迟 100ms
// - 上游 API 有速率限制（5 req/s）
// - 见 API 文档 §3.2
await delay(100);

// Why: 不用 Promise.all —— 顺序执行保证写入顺序，避免竞态条件
for (const item of items) {
  await save(item);
}
```

## What NOT to Do

- Do not add backward-compatibility shims unless explicitly requested
- Do not add abstraction layers for hypothetical future requirements
- Do not refactor code outside the plan scope
- Do not add documentation, comments, or type annotations to code you did not change
