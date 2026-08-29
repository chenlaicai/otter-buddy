# api-contract

前后端契约的**单一真相源**。目录分为 `api/`（REST DTO）与 `sse/`（事件契约），双端通过 `@contract/*` 别名消费（根 `tsconfig.json`、`web/tsconfig.json`，vite 与双端 vitest 均已解析）。

## 目录语义与准入标准

本目录同时承载两类导出：

| 类别 | 形态 | 消费方式 | 例 |
|------|------|----------|----|
| **类型契约** | `export type` / `export interface` | `import type` | `api/message.ts` 各 DTO |
| **运行时契约值** | `export const` | 普通 import | `api/html-card.ts` 的 `CARD_MAX_PER_MESSAGE`（首个 value 导出，PR #410 / F20260824cpxa） |

### value 导出准入标准

**允许**：前后端**双方**消费的运行时契约值——同一常量在双端语义上必须对齐（如渲染/校验共享的阈值、格式约束），漂移会直接造成行为不一致的值。

**禁止**：
- 业务逻辑与工具函数（本目录是契约，不是 shared-utils）
- 仅单端使用的常量/类型（放消费端自己的模块）
- 需要构建处理的代码（本目录以源码直引，无独立构建产物）

### 为什么不是独立共享包

新建 workspace 包需要 workspace 配置、双端 package.json 依赖声明、构建产物处理，与"最简可行"目标相悖（Issue #360 明确不做大范围 monorepo 重构）。完整论证见特性文档 F20260824cpxa「Why api-contract 而非新建 workspace 包」。若未来 value 导出数量/复杂度增长到需要独立包，另立 issue 规划。

## 引用本目录时

- 新增契约：先确认是**双端共享**语义，再落目录；单端需求不进本目录
- 新增 value 导出：对照上方准入标准自查；`api/index.ts` 聚合导出（既有 `export type *` 不受影响）
