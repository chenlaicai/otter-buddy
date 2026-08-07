# Testing Rules: Behavioral Contract Testing

Tests verify what the system DOES, not how it does it internally.

## A/B 分层（F20260806tstr，本仓硬规则）

先分类，再选信道——写测试前必须回答：这个行为由谁决定？

| | A 类（代码逻辑） | B 类（LLM 参与的行为） |
|---|---|---|
| 判别 | 输入输出是确定数据，正确性由代码决定 | 正确性取决于"模型看到输入后怎么做"（prompt/skill/工具选择/协议遵从） |
| 位置 | `tests/`（capability/ 之外） | `tests/capability/**/*.capability.test.ts` |
| 运行 | `npm test`（CI） | `npm run test:capability`（本地，真模型） |
| LLM | 零介入 | **必须真模型——mock LLM 行为 = 自欺** |
| 断言 | 精确断言 | 行为不变量（工具轨迹/协议合规/关键 token），禁止措辞断言；抖动行为用 `expectSampledBehavior` 统计采样 |

**embedding（bge-m3）永远不 mock**——它是本地确定性模型，且检索质量本身就是能力。

### A 类硬规则

- DB 一律 `createTestDb()`（tests/helpers/），**禁止手写 CREATE TABLE**（与生产 schema 静默漂移；lint-tests.mjs 拦截）
- 共享设施只用 `tests/helpers/`（logger / fakeAgentGateway / SSE），**禁止新抄副本**
- 不写这些（覆盖填充）：mapper/DTO 字段抄送、pass-through 委托、与实现锁步的镜像断言
- 判别口诀：**断言失败时，用户或调用方能感知吗？** 不能 → 这个测试不该存在

### B 类硬规则

- 涉及 LLM 行为的新能力 → 必须有 capability 测试，并在 F 文档声明 `capability_test` 字段
  （纯 A 类改动声明 `n/a: 理由`）；lint-capability-docs.mjs 卡 pre-commit（警告数只减不增）
- 辅助设施只用 `tests/capability/helpers/`：boot（真装配）、assert-behavior（行为断言）、
  session-file（session jsonl 解析）
- 完整约定见 `docs/user-guide/testing.md`

## Acceptance Test 执行流程

当 F 文档包含 `## Acceptance Test` 章节时，按以下流程执行：

### 从验收场景推导能力测试

F 文档的 `### 验收场景` 表格定义了"什么算解决了"，能力测试是"怎么验证"。

**映射规则**：
- 每个验收场景（AT-1, AT-2...）对应一个 `it()` 测试用例
- 验收场景的"复现步骤"转化为测试的 setup + action
- 验收场景的"预期结果"转化为断言（行为不变量，不断言措辞）

**示例**（F 文档验收场景 → 能力测试）：

```markdown
# F 文档验收场景
| AT-1 | 需求1 | 发送包含术语定义的消息 | 獭调用 add_terminology 工具 |
```

```typescript
// 能力测试
it("AT-1: 术语定义触发 add_terminology", async (t) => {
  if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

  await expectSampledBehavior("terminology-capture", 3, 1, async (i) => {
    const convId = await createConversation(ctx, `术语采样${i + 1}`);
    await sendUserMessage(ctx, convId, "我们约定一个术语：「测试词」...");
    const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 150_000 });

    const tools = toolCallNames(answer);
    return {
      ok: tools.includes("add_terminology"),
      detail: `tools=${JSON.stringify(tools)}`,
    };
  });
}, 600_000);
```

### 验收执行

```bash
npm run test:capability
```

- 先 build（embedding worker 需要 dist 产物）再跑
- LLM 未配置时，非 LLM 用例照常真跑，LLM 用例显式 skip

### 证据判定

执行完成后，将结果写入 F 文档的 `### 证据判定` 表格：

| 证据状态 | 含义 | 判定 |
|---------|------|------|
| 证明完成 | 测试通过 + 行为符合预期 | ✅ |
| 矛盾 | 测试通过但行为不符合预期 | ❌ |
| 未完成 | 测试失败 | ❌ |
| 证据不足 | 测试存在但覆盖不全 | ❓ |
| 缺失 | 测试不存在 | ❌ |

**原则**：不确定的证据 = 未达成。

## Core Principle

Assert observable behavior (outputs, side effects, state changes). Do not assert internal implementation details (which functions were called, in what order, with what arguments).

## What to Assert

| Assert This | Not This |
|-------------|----------|
| Return value | Which internal function was called |
| Database state change | Number of times a method was invoked |
| HTTP response status/body | Call order between services |
| Error message content | Whether a specific private method ran |
| Observable side effect | Mock verification of internal calls |

## Forbidden Assertions

- `toHaveBeenCalledWith` — asserts internal call details
- `toBeCalledTimes` — asserts call count, not behavior
- `toHaveBeenCalledTimes` — same as above

These assertions tie tests to implementation, making refactoring break tests even when behavior is unchanged.

## Test Structure

```
describe('feature name', () => {
  it('should [observable behavior] when [condition]', () => {
    // Arrange: set up the scenario
    // Act: trigger the behavior
    // Assert: verify observable outcome
  });
});
```

## When Tests Fail

A test failure means one of three things:

1. **The test is wrong** — it doesn't match the new design. Fix the test.
2. **The implementation is wrong** — it deviates from the plan. Fix the code.
3. **The plan is wrong** — the design itself produces incorrect behavior. Stop implementation, report to the plan author.

Diagnose which before acting. Do not automatically revert business code to make tests pass.

## Anti-Patterns

| Anti-Pattern | Problem | Fix |
|-------------|---------|-----|
| Mock everything | Tests pass but integration fails | Mock only external boundaries |
| Test private methods | Brittle, blocks refactoring | Test through public interface |
| Snapshot testing for logic | Encodes implementation, not behavior | Assert specific values |
| Testing framework internals | Coupled to library version | Test your code's behavior |
