---
id: F20260729lnt1
title: lint-violations-fix
doc_type: feature

summary: |
  修复 PR #111（F20260729cbpt）引入的两个 ESLint 行数超限错误：
  - pi-session-factory.ts max-lines 453 > 450
  - circuit-breaker-helpers.test.ts max-lines-per-function 249 > 220
  同时添加 pretest 钩子，npm test 前自动跑 lint，防止类似问题再次绕过。

causal_links:
  from:
    - F20260729cbpt   # per-event 超时改造（引入行数超限）

status: final
change_type: bugfix
tags: [lint, ci, code-quality]
modules:
  - src/frameworks/agent/pi-session-factory.ts
  - tests/frameworks/agent/circuit-breaker-helpers.test.ts
  - package.json

created_at: 2026-07-29
---

# F20260729lnt1 修复 ESLint 行数超限

## 事故现象

2026-07-29，执行 `npm start`（即 `npm run build && node dist/src/main.js`）报错：

```
/Users/orca/ai/otter-buddy/src/frameworks/agent/pi-session-factory.ts
  602:1  error  File has too many lines (453). Maximum allowed is 450  max-lines

/Users/orca/ai/otter-buddy/tests/frameworks/agent/circuit-breaker-helpers.test.ts
  50:37  error  Arrow function has too many lines (249). Maximum allowed is 220  max-lines-per-function

✖ 2 problems (2 errors, 0 warnings)
```

## 根因分析

### 直接原因：PR #111 推高行数

PR #111（F20260729cbpt，"熔断器 per-event 超时"）新增 5 个 per-event 超时测试用例（~120 行），将 `circuit-breaker-helpers.test.ts` 的 describe 块从 185 行推至 305 行，超过 `max-lines-per-function: 220` 限制。同时 `pi-session-factory.ts` 新增 3 行有效代码，从 450 推至 453，超过 `max-lines: 450` 限制。

验证：PR #101（`a6684d8`）状态下两个文件 lint 零错误；PR #111（`36907f7`）状态下两个错误。

### 为什么绕过了检测

1. **PR #111 通过 GitHub squash merge 合入 main**，这是服务端操作，不触发本地 `.githooks/pre-commit`（`npm run check`）
2. **`npm test` 不跑 lint**：`test` 脚本只跑 `vitest run`，lint 只在 `npm run build` 中执行
3. **无 CI pipeline**：项目没有 GitHub Actions 在 PR 合并时跑 lint

三条防线全部失效，导致 lint 错误静默入库。

## 变更

### 修复 1：压缩 `_destroyInternal`

`pi-session-factory.ts` 中 `_destroyInternal` 方法的 key 收集循环和事务代码压缩为更紧凑的形式，减少 4 行有效代码（453 → 449）。

### 修复 2：拆分 describe 块

`circuit-breaker-helpers.test.ts` 将单个 describe 拆为 4 个顶层 describe：

| describe | 内容 | 行数 |
|----------|------|------|
| `attachCircuitBreaker - 工具名识别与兼容` | toolName 字段、bash 命令、连续相同、兼容旧字段 | ~90 |
| `attachCircuitBreaker - 终止策略与 abort 原因` | terminate、abortOverride、tool_call_limit | ~55 |
| `attachCircuitBreaker - per-event 超时` | 5 个 per-event 超时测试 | ~140 |
| `attachCircuitBreaker - steer 行为纠正` | steer 后纠正恢复 | ~20 |

遵循项目惯例（Pattern A：多个顶层 describe，参见 `sqlite-conversation-repository.test.ts`）。

### 修复 3：添加 pretest 钩子

`package.json` 新增 `"pretest": "npm run lint"`。npm 自动在 `test` 前执行 `pretest`，确保 `npm test` 必过 lint，防止 squash merge 绕过后测试也无法发现问题。

## 设计决策

1. **压缩代码 vs 提取方法**：选择压缩 `_destroyInternal`。理由：只需削减 3 行，提取方法会增加文件间耦合和代码跳跃，收益不成比例。
2. **拆 describe vs 提取 helper**：选择拆 describe。理由：测试文件中各 it 块无共享状态，天然适合拆分；项目已有 Pattern A 惯例。
3. **pretest vs CI**：选择 pretest。理由：pretest 是本地兜底，零配置成本；CI 需要额外设置，可后续补充。

## 测试

- `npx eslint src/frameworks/agent/pi-session-factory.ts` — 无错误
- `npx eslint tests/frameworks/agent/circuit-breaker-helpers.test.ts` — 无错误
- `npx vitest run tests/frameworks/agent/circuit-breaker-helpers.test.ts` — 14/14 通过
- `npx tsc --noEmit` — 类型检查通过
