---
id: F20260817a3rt
title: agent-runtime-refactor
doc_type: feature

summary: |
  批次 3 主档（issue #282）：agent runtime 拆解 + port 体系统一，按 locked 设计
  R20260817arnt 实施。Part A-F 对应 PR 序列。本档随 PR-A 诞生（F 文档跟 PR 走），
  各 Part 实施时填充实现细节与验收记录。

causal_links:
  from:
    - F20260814qswp
    - F20260817mrp2
    - F20260817bcst
    - R20260817arnt

status: development
change_type: refactor
tags: [agent, architecture, port, refactor]
modules:
  - src/usecases/ports/
  - src/interface-adapters/agent-runtime/
  - src/frameworks/agent/pi-session-factory.ts
  - src/bootstrap/types.ts
capability_test: "n/a: 纯代码逻辑重构（A 类），各 Part 如涉及 LLM 行为另行声明"
---

# F20260817a3rt: agent runtime 拆解 + port 体系统一（批次 3 主档）

设计依据：**R20260817arnt**（locked，D1-D11 已拍板）。Part 索引与全局验收标准见下。

## Part A：port 收拢（本 PR）

### 实现内容

按 R20260817arnt §2/Q3/Q4，纯移动 + 改名 + 双定义消除，无行为变更：

1. **sdk-invoke-port**：`interface-adapters/agent-runtime/agent-invoke-port.ts` 改名上移
   `usecases/ports/sdk-invoke-port.ts`，接口 `AgentInvokePort` → `SdkInvokePort`——消除与
   `usecases/ports/agent-invoke-port.ts`（invokeConversation 粒度，PR-D1 时随切换删除）的
   同名双定义。
2. **otter-tool-client**：整体上移 `usecases/ports/otter-tool-client.ts`（128 行 usecase 门面，
   其 import 全部落在 entities/usecases，上移后合法）。
3. **agent-tools port（新建）**：`AgentTool`/`ToolContext`（自 tool-factory）+
   `ToolResponse`/`textResponse`/`errorResponse`/`MAX_TOOL_RESULT_CHARS`/`truncateToolResult`
   （自 tool-helpers，含 smartTruncate 逐字迁移）。tool-helpers 仅剩 `validateSpeakBody`
   （speak 专属校验）。tool-factory 保留类型 re-export 供同层工具文件（PR-B 顺手收口）。
4. **ModelPoolLike 双定义消除**：tool-factory 的重复定义删除；`ports/model-pool-like.ts`
   补 `describeModels()`；工具层用窄接口 `ToolModelPool = Pick<ModelPoolLike, "hasModel" | "describeModels">`
   （具体 ModelPool 结构化兼容，mock 无需实现无关方法）。
5. **frameworks 倒穿消除**：pi-session-factory 的 5 处 `@interface-adapters` import 全部改指
   `@usecases/ports/*`——grep 确认 frameworks 层零 interface-adapters 依赖。
6. **组合根 port 声明**：`bootstrap/types.ts` Repositories 的 11 个 Sqlite 具体类改为 port
   接口；`bootstrap/controllers.ts` 的 settingsRepo/featureRepo/researchRepo 同改。

### 验收结果

- `npx tsc --noEmit` 通过；`npx eslint .` 0 error；全量 vitest 105 文件 / 1231 用例通过
- frameworks → interface-adapters import：grep 零命中（倒穿消除实证）
- 未删旧 `usecases/ports/agent-invoke-port.ts`（PR-D1 随 scheduler/recruiting 切换删除，保证本 PR 可独立回滚）

### 改动范围

| 文件 | 操作 |
|------|------|
| src/usecases/ports/sdk-invoke-port.ts | 改名上移 + 接口更名 SdkInvokePort |
| src/usecases/ports/otter-tool-client.ts | 上移（原样） |
| src/usecases/ports/agent-tools.ts | 新建（契约类型 + 截断工具迁移） |
| src/usecases/ports/model-pool-like.ts | 补 describeModels |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 定义移出 + re-export |
| src/interface-adapters/agent-runtime/tools/tool-helpers.ts | 仅剩 validateSpeakBody |
| src/interface-adapters/agent-runtime/tools/*.ts（6 文件） | import 改指 port |
| src/interface-adapters/agent-runtime/agent-invoker.ts | import 改指 sdk-invoke-port |
| src/frameworks/agent/pi-session-factory.ts / session-helpers.ts | import 改指 ports（倒穿消除） |
| src/bootstrap/types.ts / controllers.ts | 具体类 → port 声明 |
| tests/（8 文件） | import 路径与接口名机械更新 |

## Part 索引

| Part | 内容 | 状态 |
|------|------|------|
| A | port 收拢 + 倒穿消除 + 组合根 port 声明 | 本 PR |
| B | tool-factory 规则下沉 | 待实施 |
| C | AgentInvoker 编排上提（两段式） | 待实施 |
| D1 | controller/scheduler 切 agent-turn-port + 删旧 port | 待实施 |
| D2 | pi-session-factory 瘦身 | 待实施 |
| E | MemoryRepository 三分 | 待实施 |
| F | broadcaster 事件通道改造 | 待实施 |

## 全局验收标准

- 每 Part 独立 PR、独立对抗检视至少一轮、隔离实例真实验证（C/D 额外能力层冒烟）
- 行为等价红线（除显式声明外无行为变更）；反强编排红线（attemptDriver 仅限重执行当前轮）
- 已知问题 K1（scheduler 超时不取消 + 三层重试叠加）批后单独修，见 R20260817arnt §7
