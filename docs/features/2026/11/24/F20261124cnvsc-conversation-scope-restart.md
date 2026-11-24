---
id: F20261124cnvsc
title: ConversationScope 逐 invoke 重绑与重启显式作用域
summary: 池复用 A→B 时工具副作用随当前 conversationId 重绑；重启交接显式传递当前 Conversation，多对话省略时拒绝猜测，并保持普通 otter-global 与 restricted 分区语义。
change_type: fix
doc_type: feature
created_at: 2026-11-24
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 硬代码作用域与 HTTP/重启行为修复，由真实工具闭包、池命中及统一交接测试覆盖，不涉及 prompt/skill 行为语义"
tags: [session, conversation, restart, handoff, external]
modules:
  - src/frameworks/agent/tool-builder.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/interface-adapters/http/controllers/otter-controller.ts
intent:
  problem: "池命中已重绑 cwd，但 toolContext.conversationId 仍冻结在建 session 时的 A，导致 B 的工具写回 A；重启交接又从无序关联 ids[0] 猜对话，可能读取 B 或把 external 原文带入普通档案。"
  expected_effect: "同一工具闭包 A→B 后 speak/artifact/matter/signal/workspace 与 cwd 全部归 B；工具、自重启、client、HTTP 显式传递 conversationId；旧 HTTP 省略时仅唯一关联可解析，多关联返回 conflict；普通 transcript 保持 otter-global，external 不进入普通交接。"
  verify_by:
    type: behavior_check
    rollback: "整体 revert 本 PR 的代码与测试；无数据库、durable 文件或配置迁移。"
    risk_note: "多对话旧 HTTP 客户端省略 conversationId 将从无序首条改为 409，需改为显式传当前 conversationId；这是为防止跨对话交接而有意 fail-loud。"
---

# ConversationScope 逐 invoke 重绑与重启显式作用域

## 背景与基线

最终实施基线为 `origin/main@98d4f3f626f0d218296570f5f7847542b8f93387`。开工时为 PR-01 合入点 `4c867108`，在途 PR 无 H1/H2 重复实现；提交期间依赖批次 #1948 合入后，已将本分支单 commit rebase 到最新基线并复跑验证。

已实证两处缺陷：

1. 池命中虽重置 cwd，但 `toolContext.conversationId` 是创建时的值捕获，A→B 后工具副作用仍归 A。
2. `restartWithUnifiedHandoff` 通过 `resolveFirstConversationId` 取 `ids[0]`；关联表无排序保证，多对话时会读错交接作用域。external Conversation 也可能进入普通叙事交接。

## 设计取舍

复用现有 `InvokeRegister` 与 `currentMessageId` getter/reset 模式，只增加 `currentConversationId`。池 key、epoch、锁、session 生命周期均不变；普通 durable transcript 仍是 `durable-sessions/<otterId>.sqlite`，restricted 仍是 `durable-sessions/external/<conversationId>/<otterId>.sqlite`。

重启不新增 ConversationScope 框架或交接机制：

- `restart_otter` 重启别人时把当前 `ctx.conversationId` 传给 client；自重启把同一值放入 pending signal，并由 invoker 用于交接、事件和 continuation invoke。
- HTTP body 新增可选 `conversationId`。显式值优先；省略时零关联保留裸重启、唯一关联安全解析、多关联抛 `DomainError(conflict)`。
- external Conversation 不进入普通交接，也不把 `selfSummary` 写入普通新 session；其 restricted durable 分区文件保持原样，避免外部原文经摘要旁路进入普通档案。

## 变更

1. `InvokeRegister` 每 invoke 重置当前 conversation；`ToolContext.conversationId` 改 getter，所有既有工具无需各自修改。
2. 三处 session acquire（普通冷启动、池命中、readOnly/restricted）统一传当前 conversation。
3. 工具、自重启结果、OtterToolClient、controller 与 invoker 显式传递 conversationId。
4. 删除重启首条猜测；多对话省略 fail-loud，external 与普通档案隔离。
5. 增加真实工具闭包 A→B、池 cwd/scope、普通/restricted 文件选择、显式 A 重启、多对话拒绝和 external 负向测试。

## 非目标

- 不实现 C1 PromptComposer，不处理 P1/P2。
- 不改数据库、durable 格式、池 key、epoch、锁或交接引擎。
- 不改普通 otter-global transcript 产品语义，不重写 restricted 工具面。
- 不处理麻将等其它独立的首对话选择策略。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| A→B 工具归属 | 同一真实工具闭包依次执行 A/B 的 speak、fact artifact、register matter、speak signal、workspace write | 两轮副作用分别归 A、B；第二轮无 A 残留 |
| 池 cwd 与 scope | `_acquirePooled` A→B→C，含一次 cwd 失败重试 | session 对象复用，cwd 与 toolContext.conversationId 同步为当前 B/C；epoch/池 key 不变 |
| transcript 分区 | 同一 otter 分别打开普通 A/B 与 restricted A/B | 普通 A/B 同 otter-global 文件；restricted 各自 Conversation 文件且不打开普通文件 |
| 显式 A 重启 | 关联列表故意为 `[B,A]`，显式传 A | entries 只读 A，不读 B |
| 多对话省略 | 关联 `[A,B]`，省略 conversationId | conflict，未合成交接、未 restartSession |
| external 负向 | external Conversation 携带 selfSummary 重启 | 不读 external entries、不发普通交接消息、不写普通 summary；restricted 分区路径不变 |
| 工具与 HTTP 接线 | 重启自己/别人及 HTTP 显式 conversationId | 当前 conversationId 透传到统一交接 |

## 测试改动声明

方向：收紧。删除行仅用于替换旧 mock 形状、同步新增 conversationId 参数及更新方法名注释；新增 A→B、显式重启、多对话拒绝与 external 负向断言，未删除既有覆盖。

## Verification

### 失败用例证据（bugfix）

修复前输出保存在对话工作区 `pr02-red-before.log`。真实失败包括：

```text
A→B speak: expected ['conversation-A', 'conversation-A'] to equal
           ['conversation-A', 'conversation-B']
pool hit: expected 'conv-A' to be 'conv-B'
显式 A 重启: expected ['conv-B'] not to include 'conv-B'
多对话省略: promise resolved instead of rejecting
external: 普通叙事档案取代 external-local-only 裸重启结果
restart_otter/client/controller: conversationId 为 undefined
```

修复后聚焦命令：

```text
npx vitest run tests/frameworks/agent/conversation-scope.test.ts \
  tests/frameworks/agent/pool-hit-path.test.ts \
  tests/frameworks/agent/external-session-profile.test.ts \
  tests/interface-adapters/unified-handoff.test.ts \
  tests/interface-adapters/agent-runtime/tools/pending-restart.test.ts \
  tests/bootstrap/clients.test.ts tests/api/otter.test.ts
Test Files 7 passed (7)
Tests 95 passed (95)
```

### 回归与最简检查

- `npm run check`：build、eslint、schema、双形态 boot smoke、脚本回归与 connector closure 全通过。
- build 后 `npm test -- --disable-console-intercept`：**527 文件 / 6823 用例全绿**，日志为工作区 `pr02-full-test-rebased.log`。
- `npx tsc --noEmit`：零错。
- 已过最简检查：无新生产模块、无新依赖；仅一个 register 字段与现有参数链传递。测试复用真实 `createTools`、池编排和统一交接入口，不以字符串 helper 代替行为验证。

负面向核查：未删除 cwd 回滚、epoch 所有权、readOnly/restricted 绕池或自重启防循环保护；唯一有意旧行为变化是多对话 HTTP 省略从猜测改为 409。external 普通交接与 summary 均被阻断，而不是仅过滤合成 prompt。

## 回滚

整体 revert 本 PR 即可恢复旧代码；无数据库、durable、配置或运行时副本迁移。回滚会重新引入 A→B 工具错归属与重启首条猜测，因此若 PR-03 已依赖显式 ConversationScope，应先回滚 PR-03 或提供等价保护。
