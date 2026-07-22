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

## What NOT to Do

- Do not add backward-compatibility shims unless explicitly requested
- Do not add abstraction layers for hypothetical future requirements
- Do not refactor code outside the plan scope
- Do not add documentation, comments, or type annotations to code you did not change
