---
id: F20260901wscn
title: Workspace API DTO 纳入 api-contract 单一真相源
summary: Workspace API（listDir/readFile）的 DTO 定义散落在 usecase 层与 web 前端两处（手工同步副本），controller 响应体无类型锚。方案：DTO 迁入 api-contract/api/workspace.ts，三侧（usecase/controller/web）改为从契约引用，双端 tsc 锁编译期漂移，新增 wire 形状契约测试锁运行时一致性。stats 端点单侧使用按准入标准不纳入
change_type: refactor
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F20260901wscn: Workspace API DTO 纳入 api-contract 单一真相源

> 状态：**已实现**（2026-09-01）。关联 issue：[#558](https://github.com/chenlaicai/otter-buddy/issues/558)（Workspace API DTO 未纳入 api-contract 单一真相源）。
> 来源：PR #554（F20260828wbrp）对抗审视建议 A2——跨层引用调整超出该 PR 载荷，独立成 issue 论证「本 PR 无法承载」。

## 背景

Workspace API（PR #554 引入的右侧面板 tab 化产物）的 DTO 存在两处副本 + 一处无类型锚：

| # | 位置 | 形态 | 问题 |
|---|------|------|------|
| 1 | `src/usecases/conversation/manage-workspace.ts:5-17` | `WorkspaceEntry` / `WorkspaceFileContent` interface | 定义处，但作为 DTO 真相源位置错误（usecase 层不该被 web 依赖） |
| 2 | `web/src/pages/conversation/WorkspacePanel.tsx:7-19` | 同名 interface 手工抄送副本 | 靠人工纪律同步，字段漂移无编译期拦截 |
| 3 | `src/interface-adapters/http/controllers/workspace-controller.ts` | listDir/readFile 响应体字面量内联 | 无契约类型锚，形状与 #1/#2 的一致性无保障 |

项目已有 api-contract 单一真相源机制（#548 MPA 页面清单、PR #410 html-card 常量），新增 API 未走该体系——本特性补齐。

## 方案

### 契约落点与内容

新增 `api-contract/api/workspace.ts`，三个类型：

```ts
WorkspaceEntry           // 文件条目：name / isDirectory / isFile / path（相对工作区根，嵌套为 父路径/名称）
WorkspaceFileContent     // 文件内容：path / content / truncated（超 100KB 显示上限截断）
WorkspaceListDirResponse // listDir 响应体：entries / basePath（缺省根目录为空串）
```

`WorkspaceListDirResponse` 为本次新增命名——原 controller 内联的 `{ entries, basePath }` 字面量首次获得显式契约类型。

### 三侧改造

| 侧 | 改动 |
|----|------|
| usecase（manage-workspace.ts） | 删除本地 interface 定义，`import type` 自 `@contract/api/workspace`；`export type { WorkspaceEntry, WorkspaceFileContent }` 转发保留（既有 import 路径不断，避免 5 个消费点连锁改） |
| controller（workspace-controller.ts） | listDir 响应体标注 `WorkspaceListDirResponse`，readFile 返回值标注 `WorkspaceFileContent`，`import type` 自契约 |
| web（WorkspacePanel.tsx） | 删除 15 行手工副本，`import type` 自 `@contract/api/workspace`；`fetchDir` 解析改用 `WorkspaceListDirResponse`（响应体级而非 `as WorkspaceEntry[]` 字段级断言） |

### 漂移锁（双层）

1. **编译期**：三侧各自 import 契约类型——任何一侧形状漂移在双端 tsc（server build 内 `npx tsc`、web build 内 `tsc --noEmit`）即失败，CI 拦截
2. **运行时**：`tests/interface-adapters/http/workspace-api.test.ts` 新增顶级 describe「响应体与 api-contract 契约一致」——用契约类型断言真实 HTTP 响应（wire 形状锁，25 用例中 +3）：listDir 字段全集类型断言、嵌套 path 形态、readFile 三字段类型与值

### 边界决策：stats 端点不纳入

`GET .../workspace/stats` 的响应体（fileCount/totalSize/topFiles）**仅后端产出，web 无消费**——`git grep` 全仓确认无前端引用。按 api-contract/README.md 准入标准「仅单端使用的类型不进本目录」，不纳入契约；将来 web 消费时再迁（届时类型已在 usecase 内联，迁移成本与本特性同量级）。此决策在契约文件头注释中记录，防止后人误以为遗漏。

## 关键决策记录

| 决策 | 备选 | 取舍 |
|------|------|------|
| 不聚合导出 `api/index.ts` | 加 `export type * from "./workspace"` | web 侧语义路径 `@contract/api/workspace` 直接引用（types-only）；聚合无消费方。index.ts 的聚合主要服务 web/src/api/client.ts 式集中消费，Workspace 消费方是页面级直引——不为例外破例 |
| usecase 转发导出而非全改 import 点 | 5 个消费点连锁改 `@contract/api/workspace` | 迁移 commit 保持最小 diff；转发注释标明真相源位置，消费点下次触碰时自然迁移 |
| 测试挂载点选既有集成测试文件 | 新建 tests/api-contract/ 镜像断言文件 | 测试规则 A 类「不写 DTO 抄送/镜像断言」——新建文件断言类型彼此相等正是反模式；复用既有 app fixture（文件级 hook 提升供两个顶级 describe 共用）断言 wire 行为才有感知价值 |
| fixture 提升文件级 | 逐 describe 抄副本 | vitest 文件级 beforeEach/afterEach 服务全文件，两个 describe 共用一套 |

## 影响范围

- `api-contract/api/workspace.ts`：新增（唯一类型定义点）
- `src/usecases/conversation/manage-workspace.ts`：定义迁出 + 转发导出
- `src/interface-adapters/http/controllers/workspace-controller.ts`：响应体契约类型化
- `web/src/pages/conversation/WorkspacePanel.tsx`：删手工副本 + 契约引用
- `tests/interface-adapters/http/workspace-api.test.ts`：fixture 文件级化 + 契约形状锁 describe（+3 用例）

运行时行为零变更（纯类型迁移）。

## 验证

- server：`npx tsc --noEmit` 零错误；`npm test` 205 文件 2562 用例全过；改动文件 eslint 通过
- web：`tsc --noEmit` 零错误；`npm test` 36 文件 311 用例全过；`vite build` 成功
- 新增契约锁用例 3/3 过（25 全过）
- **最简实现检查：已过**——零新依赖、零运行时代码变更、零新测试文件；唯一新文件是契约本体（19 行纯类型）；复用既有 fixture 而非新建。无更简形态达成「三侧单一来源 + 漂移锁」目标
- capability 测试：n/a（纯 A 类类型迁移，无 LLM 行为变化）

## 实现记录

- 2026-09-01：实现于 worktree `workspace-dto-558`（branch `feature/workspace-dto-558`），基于 main `60feb767`。PR 见关联 issue #558 处置评论。
