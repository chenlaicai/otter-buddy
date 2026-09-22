---
id: F20260922tcrc
title: toolCallCount 快照竞态修复（#763）：catch 读取 vs finally 清理
change_type: fix
status: implemented
created: 2026-09-22
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/pi-session-factory.ts
summary: "#763：catch 分支经 activeSessions.get(sessionKey) 重查工具计数——真实竞态是跨帧删除先于 catch 读取：(a) destroy() 在 invoke 挂起时外部 abort→delete 条目；(b) 同 sessionKey 并发 invoke 互踩（裸 otterId 共键）删对方条目甚至读到对方计数。重查 undefined 退化 0，中断文案与统计失真。修复：快照优先取 activeEntry 闭包引用（attachGuards 时已捕获 Map value 引用，tool_execution_start ++ 的正是该对象），Map 删除不影响已捕获引用；Map 查询降级为兜底。"
tags: [agent, session, race-condition, tool-call-count]
capability_test: tests/frameworks/agent/toolcall-count-race.test.ts
from: []
---

# toolCallCount 快照竞态修复（#763）

## 问题

`pi-session-factory.ts` catch 分支 `e._toolCallCount = this.activeSessions.get(sessionKey)?.toolCallCount ?? 0` 经 Map 重查计数。**真实竞态不是「同帧 finally 先于 catch」（JS 语义保证 catch 先于 finally），而是跨帧删除先于 catch 读取**（审视 A1 修正）：

- **(a) destroy() 外部删除**：`_destroyInternal` 在 invoke 挂起于 `await session.prompt()` 时 `await entry.abort()` → `activeSessions.delete(key)`——abort 先 resolve 的时序窗口内，prompt reject 的 catch 在 delete 后运行 → 重查 undefined 退化 0
- **(b) 同 sessionKey 并发 invoke 互踩**：sessionKey 无 messageId 时是裸 `otterId` 共键——A 的 finally delete 删掉 B 的条目；B 的 set 覆写后 A 的 catch 甚至读到 **B 的计数**（跨 invoke 污染，比 0 更糟——旧代码第二缺陷）

后果：中断文案「经过 0 次工具调用后中断」失真；中断类统计（0 次/有工具调用分布）不可信。

**已知边界**（修复与旧代码同丢，不在本 PR 范围）：set 与 attachGuards 之间存在 await 窗口（delete-before-attach），该窗口被删则 activeEntry=undefined 整轮不计数。

来源：开发獭-752 调查时发现、检视獭-762 核实确认。

## 修复

一行级语义修改：快照优先取 `activeEntry` 闭包引用（`attachGuards` 时已从 Map 取出 value 引用，`tool_execution_start` 事件 `++` 的正是该对象）——Map 条目删除不影响已捕获的引用，删除前的所有计数都落在同一对象上。Map 查询降级为兜底（activeEntry 缺失的极端分支），最终仍 `?? 0` 不抛。

## 测试

`tests/frameworks/agent/toolcall-count-race.test.ts`（2 用例，stub session 驱动**真实 `_executeWithSession` catch 分支**，不起真 LLM——审视 S1 修复，不做同义反复）：
- 竞态现场：prompt() 内 emit 两次 tool_execution_start（计数落 activeEntry）→ **先 delete Map 条目再 reject**（跨帧删除）→ 断言 `err._toolCallCount === 2`。回退验证：旧表达式（Map 重查）在本现场必得 0 → 红（`expected +0 to be 2`），修复后绿
- 常规错误路径（无删除竞态）：计数同样正确，防修复引入新失真

## 验证

tsc 0 错、eslint 0 error、agent 域全量 37 文件 557 用例全过。

## 影响范围

仅 err 路径的 `_toolCallCount` 赋值取数来源；成功路径（result.toolCallCount）不受影响。retry-policy 中断文案与 orchestrator 统计口径随之恢复真实。

## 关联

- issue #763；调查上下文 PR #762、关联 issue #752
