---
id: F20260805thlp
title: test-shared-helpers
doc_type: feature

summary: |
  建立共享测试基础设施 tests/helpers/（DB/logger/AgentGateway 假件/SSE 读取器）。
  动机：测试套件存在 24 份 mockLogger、4 份 fakeAgentGateway、2 份 SSE 读取器等大量重复基建，
  且部分测试手写 DDL 与生产 schema 有静默漂移风险；这是测试体系重构（A/B 分类）的 P1 阶段。
  机制：createTestDb() 一律走生产 initSchema，消灭手写 DDL；tests/api/helpers.ts 的
  readSSEEvents 改为 re-export 共享实现。

causal_links:
  from:
    - F20260805rsto   # restart 事故：mock 镜像导致 fake green，催生测试体系重构
  to: []

status: implemented
change_type: refactor
tags: [test, infrastructure, helpers, dry]
modules:
  - tests/helpers/db.ts
  - tests/helpers/logger.ts
  - tests/helpers/agent-gateway.fake.ts
  - tests/helpers/sse.ts
  - tests/api/helpers.ts
---

# F20260805thlp: 共享测试基础设施

## 背景

测试体系重构的 P1 阶段（总体方案：A 类代码逻辑测试 / B 类 LLM 行为测试分层，
B 类新增真模型能力测试层）。本阶段只做加法：提供共享基建，不动任何现有测试。

## 审计依据

- `mockLogger`/`noopLogger` 在 24 个文件中重复实现（3 种互不兼容的变体）
- `fakeAgentGateway` 在 4 个 otter 相关测试中各自手抄
- SSE 读取器在 `tests/api/helpers.ts` 与 `subscribe-sse.test.ts` 两份实现
- `search-memory.test.ts`、`manage-terminology.test.ts` 手写 CREATE TABLE 而非走
  `initSchema`——测试 schema 可与生产静默漂移

## 交付物

| 文件 | 内容 | 替代对象 |
|------|------|---------|
| `tests/helpers/db.ts` | `createTestDb()`：`:memory:` + `initSchema` | 各文件手抄的 DB 搭建 + 手写 DDL |
| `tests/helpers/logger.ts` | `createTestLogger()`：递归 child 的 noop Logger | 24 份 mockLogger 副本 |
| `tests/helpers/agent-gateway.fake.ts` | `fakeAgentGateway()`：带调用记录 + `onReset` 竞态钩子 | 4 份 fakeAgentGateway 副本 |
| `tests/helpers/sse.ts` | `readSSEEvents()` 唯一实现 | 两份 SSE 读取器 |

`tests/api/helpers.ts` 的 `readSSEEvents` 删除实现、改为 re-export，既有导入不受影响。

## 架构决策：ConversationRepository 不写行为式假件

原计划为 usecases 层 5 份 ~65 方法 ConversationRepository mock 副本提供一个共享行为式假件。
重新审视后否决：手写 65 方法的行为假件本身就是最大的 fake-green 风险（假件实现错接口语义，
测试照样绿）。P7 改造时将直接改用**真 SqliteConversationRepository + createTestDb()**——
零假件逻辑、行为保真，与 restart-flow.integration.test.ts 的成功模式一致。

## 验证

`npm test`：84 文件 / 1041 用例全绿（本阶段无删除、无既有测试改动，仅 re-export 一处）。
