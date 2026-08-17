---
id: F20260817trfb
title: tool-factory re-export 收口
doc_type: feature

summary: |
  批次3 Part B（issue #282, PR #286）：删除 tool-factory.ts 中 PR-A 过渡保留的
  类型 re-export，让所有消费方直连 @usecases/ports/agent-tools。纯 import 路径
  机械替换，零行为变更。

causal_links:
  from:
    - F20260817a3rt
    - R20260817arnt

status: development
change_type: refactor
tags: [agent, architecture, port, refactor]
modules:
  - src/usecases/ports/agent-tools.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/interface-adapters/agent-runtime/tools/artifact-tools.ts
  - src/interface-adapters/agent-runtime/tools/healing-tools.ts
  - src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts
  - src/interface-adapters/agent-runtime/tools/message-tools.ts
  - src/interface-adapters/agent-runtime/tools/scheduled-task-tools.ts
  - src/interface-adapters/agent-runtime/tools/workspace-tools.ts
capability_test: "n/a: 纯 import 路径重构（A 类），无运行时行为变更"
---

# F20260817trfb: tool-factory re-export 收口（批次 3 Part B）

设计依据：**R20260817arnt**（locked），PR-A（#285）已将工具契约类型上移 `@usecases/ports/agent-tools`，tool-factory 保留 re-export 供同层工具文件过渡。本 PR 收口该过渡态。

## 实现内容

1. **删除 re-export**：tool-factory.ts 第 19 行 `export type { AgentTool, ToolContext, ToolResponse }` 删除。
2. **6 个工具文件 import 改直连**：artifact-tools / healing-tools / html-card-contract-tool / message-tools / scheduled-task-tools / workspace-tools 的类型 import 从 `./tool-factory` 改为 `@usecases/ports/agent-tools`。healing-tools 同时将 `ToolResponse` 类型 import 从值导入中拆出，合并到同一 type import 声明。
3. **5 个测试文件 import 改直连**：artifact-tools.test / create-linked-resource-tool.test / html-card-tool.test / speak-tool.test / pending-restart.test 的 `ToolContext` 类型 import 从 `@interface-adapters/.../tool-factory` 改为 `@usecases/ports/agent-tools`（runtime `createTools` import 保留不动）。

## 验收结果

- `npx tsc --noEmit` 通过
- `npx eslint .` 0 error（8 个预存 React warnings，与本次改动无关）
- 全量 vitest 105 文件 / 1231 用例通过
- `grep -rn 'from.*tool-factory' src/interface-adapters/agent-runtime/tools/ tests/` 仅剩 `createTools` runtime import（预期）

## 对抗审视记录（一轮）

检视獭-PR286 审查结论：0 严重发现，0 建议发现。13 个文件的 import 路径迁移逐字符正确，无遗漏、无多改、无行为变更。架构依赖方向正确（消费方 → port），re-export 过渡态收口完整。PR review comment 已留痕。

## 改动范围

| 文件 | 操作 |
|------|------|
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 删除 re-export 行 |
| src/interface-adapters/agent-runtime/tools/artifact-tools.ts | type import 改直连 agent-tools |
| src/interface-adapters/agent-runtime/tools/healing-tools.ts | type import 改直连 + ToolResponse 合并 |
| src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts | type import 改直连 agent-tools |
| src/interface-adapters/agent-runtime/tools/message-tools.ts | type import 改直连 agent-tools |
| src/interface-adapters/agent-runtime/tools/scheduled-task-tools.ts | type import 改直连 agent-tools |
| src/interface-adapters/agent-runtime/tools/workspace-tools.ts | type import 改直连 agent-tools |
| tests/interface-adapters/artifact-tools.test.ts | ToolContext import 改直连 agent-tools |
| tests/interface-adapters/create-linked-resource-tool.test.ts | ToolContext import 改直连 agent-tools |
| tests/interface-adapters/html-card-tool.test.ts | ToolContext import 改直连 agent-tools |
| tests/interface-adapters/speak-tool.test.ts | ToolContext import 改直连 agent-tools |
| tests/interface-adapters/agent-runtime/tools/pending-restart.test.ts | ToolContext import 改直连 agent-tools |
