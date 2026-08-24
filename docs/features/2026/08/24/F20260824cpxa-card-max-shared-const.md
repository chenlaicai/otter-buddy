---
id: F20260824cpxa
title: CARD_MAX_PER_MESSAGE 前后端共享常量
summary: |
  Issue #360：前后端各定义一次 CARD_MAX_PER_MESSAGE，仅靠注释约定对齐，无编译期保障。
  方案：抽取到 api-contract/api/html-card.ts 作为单一真相源，双端通过 @contract 别名引用同一常量。
  后端 speak 校验与前端降级渲染天然一致，漂移在编译期即被阻断。
change_type: refactor
status: active
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: f337381e-70aa-4334-ac1d-dc349c8a8dd4
---

# CARD_MAX_PER_MESSAGE 前后端共享常量

## 背景与需求

### 问题描述

前后端各定义一次 `CARD_MAX_PER_MESSAGE` 常量：

- 前端：`web/src/lib/html-card.ts`（渲染侧降级阈值）
- 后端：`src/interface-adapters/agent-runtime/tools/tool-helpers.ts`（speak 校验侧拒绝阈值）

后端定义处的注释写着"与 web/src/lib/html-card.ts CARD_MAX_PER_MESSAGE 对齐"，但没有任何编译期检查确保两者一致——若一处改了另一处没跟上，后端会放行前端降级（或反之），且无任何报错。

来源：PR #359 检视发现 4 引出。

### 方案选择

Issue 给出两个候选：①抽取共享常量；②单元测试验证一致性。

**选 ①，且不做 ②**。理由：

1. **共享常量更根本**：单一真相源下漂移不可能发生，而不是发生后靠测试兜底
2. **测试一致性方案违反本仓测试规则**：testing-rules.md 禁止"与实现锁步的镜像断言"（两处定义互抄的断言正是此类）；且测试只在 CI 时发现漂移，共享常量在编译期即阻断
3. **基础设施零新增**：`api-contract/` 目录本就是前后端契约的家，双端 tsconfig 均有 `@contract/*` 别名指向它（根 tsconfig.json、web/tsconfig.json），vite 与双端 vitest 配置均已解析该别名——不需要任何 monorepo 基础设施改动

### Why api-contract 而非新建 workspace 包

`api-contract/` 已被双端以 `@contract` 别名消费（此前均为 `import type`）。本次是**首个 value 导出**（常量而非类型）——目录语义从"DTO 类型契约"扩展为"前后端契约（含运行时值）"，属于自然延伸而非破坏。新建共享包需要 workspace 配置、双端 package.json 依赖声明、构建产物处理，与"最简可行"目标相悖（Issue 明确不做大范围 monorepo 重构）。

## 方案设计

### 常量归属

新建 `api-contract/api/html-card.ts`：

```ts
export const CARD_MAX_PER_MESSAGE = 2;
```

- 该常量本质是**渲染契约**：前端降级行为与后端拒绝行为共享同一阈值，跨端对齐正是 api-contract 的存在意义
- 借机说明设计意图（Issue #360 的来龙去脉）写在文件头注释

### 双端引用

| 端 | 文件 | 改动 |
|---|---|---|
| 后端 | `src/interface-adapters/agent-runtime/tools/tool-helpers.ts` | 删除本地定义，`import { CARD_MAX_PER_MESSAGE } from "@contract/api/html-card"` |
| 前端 | `web/src/lib/html-card.ts` | 删除本地定义，`export { CARD_MAX_PER_MESSAGE } from '@contract/api/html-card'`（转发导出，消费方导入路径不变） |

`api-contract/api/index.ts` 追加 value 导出（其余仍为 `export type *`）。

### 前端为什么用转发导出

`web/src/lib/html-card.ts` 有 3 个既有消费方（`html-card.test.ts`、`HtmlCard.tsx`、card-registry 等经由 lib 内部）。转发导出保持 `lib/html-card` 作为前端卡片逻辑的对外门面（facade），消费方零改动——比让每个消费方直接 import @contract 侵入性更小。

### 影响范围

- 运行时行为：无变化（值未变，只是定义位置移动）
- 后端构建产物：`tsc-alias` 已将 dist 内 import 替换为相对路径 `../../../../api-contract/api/html-card.js`，运行时解析正常
- 前端构建：vite 解析 `@contract` 别名，bundle 打入常量
- 测试：双端既有测试全绿（后端 1463、前端 143），含 `speak-tool.test.ts` 的卡片数量校验用例（37 个）

## 验证

- 后端：`npx tsc --noEmit` ✓、`npm test`（1463 passed，pretest 含 lint）✓
- 前端：`npx tsc --noEmit` ✓、`npx vitest run`（143 passed）✓、`npm run build` ✓
- 构建产物检查：dist 内 alias 已替换为相对路径 ✓

## Discovered Issues

无。

## 决策史

- 2026-08-24：初始实现（glm-dev-360）。选共享常量方案，落点 api-contract；否决单元测试方案（锁步断言违反 testing-rules，且不如编译期阻断根本）
