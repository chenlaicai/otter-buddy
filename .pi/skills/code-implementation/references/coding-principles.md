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

### "显而易见"的判定标准

以下情况视为**显而易见**，不需要 Why 注释：
1. 语言标准写法（如 TypeScript 类型断言 `as User[]`）
2. 项目中重复出现的模式（已有 3+ 处相同写法）
3. 遵循项目命名/结构约定的代码

以下情况视为**非显而易见**，必须写 Why：
1. 选择了非常规方案（如用 for 循环而非 map）
2. 引入了外部约束（如 API 限制、业务规则）
3. 代码看起来"应该用另一种方式写"但没有

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

## 注释规则优先级

当两条规则冲突时，按以下优先级执行：

1. **变更范围内的代码**：必须遵循 Why 注释规范
2. **变更范围外但影响理解的代码**：可以添加 Why 注释，但必须在 PR 描述中说明
3. **与变更无关的代码**：不添加注释

## 注释编号禁绝

非特性文档的代码注释里，不允许出现任何编号：特性编号（字母+8位日期+后缀形态）、检视轮次编号（round/第 N 轮/检视轮次 N 形态、中文动作词+序号、单字母序号——孤立也禁）、issue 编号（井号+字母数字，色值不豁免——注释里写色值改用文字表述）。

> 技术词豁免：M 芯片代际 / S3 存储 / A 纸张这类高置信技术词不算轮次编号，不误杀；但孤立单字母序号（S1/R10/N2）是检视过程痕迹，仍禁。

判据一句话：**注释 why 用文字直接写清楚，编号是「跳去别处」的指针，没必要**。

- 特性编号带进注释 = 把决策史外挂到特性文档；读者该看到的是决策本身（为什么这么写），写进 why 文字即可，不挂编号
- 检视轮次编号是对话层过程痕迹（第几轮改的、哪个建议），归特性文档的处置记录段，不进代码
- issue 编号同理：要溯源时把该 issue 的关键约束写进 why 文字，不留裸编号

### 口径

- **一律禁，无例外**（搭档 2026-11 拍板收紧，推翻早前「非显而易见决策可带编号」的口子）
- **「一律禁」的边界**：禁的是「代码注释」范畴内的编号；特性文档目录（编号的家）、生成产物（dist/锁文件）、纯 JSON、markdown 不属于代码注释，不在闸的判定面内——不是例外，是范畴外
- **机械闸**：CI 对 PR 新增行注释拦截上述编号（scripts/check-pr-anchor-discipline），报错回显 文件:行与编号类型；退出码 1 阻塞合入
- **存量整改**：分批清理——新代码经闸卡外，存量集中清 + 碰旧文件变更范围内必清
- 如何满足闸：注释写 why 只写文字结论；确需引用特性文档时，在特性文档里写清决策史，代码里写「为什么」的终态结论

## What NOT to Do

- Do not add backward-compatibility shims unless explicitly requested
- Do not add abstraction layers for hypothetical future requirements
- Do not refactor code outside the plan scope
- Do not add documentation, comments, or type annotations to code you did not change
