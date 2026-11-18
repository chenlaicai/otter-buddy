---
id: F20261118tsdlf
title: "tool_search 加载 deferred 工具跨 invoke 失效 + loaded 清单虚报 direct 工具：#1894"
change_type: fix
created: 2026-11-18
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
modules:
  - src/frameworks/agent/durable-session.ts
  - src/frameworks/agent/durable-tool-search.ts
summary: "#1894：tool_search 返回 loaded 后实际调用报 not available（healing event 058d8ea2）。两层根因：(1) DurableSession.prompt() 每轮 configure(agentChange()) 把 state.tools 重置为初始激活集，deferred 工具被重新过滤，覆盖 tool_search control.addTools 的加载——当 invoke 生效（toolsAdded）、下 invoke 开头即被移除（toolsRemoved），调用报 tool_unavailable；(2) DurableToolSearch 检索全量 customTools（含 direct）而非只 deferred，loaded 清单虚报。修法 decision-tree ①：prompt() 移除每轮 configure（初始配置由 open() 完成）；DurableToolSearch 只收 deferred 工具，与 SDK 版 candidates=agent.deferred 对齐。"
tags: [tool-search, deferred, durable-session, bugfix, P2]
intent:
  problem: "tool_search 的 loaded 清单与实际可调用状态脱钩：加载的 deferred 工具在下一 invoke 报 not available（跨 invoke 失效），direct 工具被误列进 loaded（清单虚报）。獭按 loaded 清单规划工作后撞墙，#1894 实证 manage_scheduled_task_pending 两次调用 not available，2 条 pending 定时任务最终靠机械释放兜底。"
  expected_effect: "修复后：tool_search 命中 deferred 工具并 addTools 后，该工具在当前与后续 invoke 均可调用（不再被每轮 configure 重置清掉）；loaded 清单只含 deferred 工具，不再虚报 direct 工具。回归测试 tests/frameworks/agent/tool-search-deferred.test.ts 覆盖同 prompt 与跨 prompt 两条路径。"
  verify_by:
    type: behavior_check
    note: "tests/frameworks/agent/tool-search-deferred.test.ts 2 用例：同 prompt 内 tool_search→deferred 工具执行（calls=1）；跨 prompt 调用已加载 deferred 工具仍执行（修复前 calls=0 + tool_unavailable，修复后 calls=1）。全量 tests/frameworks/agent 62 文件 697 用例通过。"
capability_test: "n/a：纯代码 bugfix（会话层 configure 时序 + tool_search 候选集过滤），不新增/修改 prompt 指令与模型行为面，不需要 capability 回归。"
---

# tool_search deferred 加载跨 invoke 失效与清单虚报（F20261118tsdlf）

> 定位与查重：2026-11-18 建档前 `grep -rn 'DurableToolSearch\|agentChange' src/frameworks/agent/` 确认
> 仅 durable-session.ts / durable-tool-search.ts 两处相关；#1371 已 CLOSED（tool_search 自身 stale，
> 不同失败点）；无同主题在途 PR。

## 问题（现场，#1894）

healing event `058d8ea2-d616-4ea2-8965-42f75432e0a5`（2026-11-14T01:29:57Z）：
`manage_scheduled_task_pending` 经 tool_search 显示 loaded，但实际调用两次均报 not available，
导致 2 条 pending 定时任务（含「每日对话健康检查 08:32」）无法查看/处置，最终由机械释放/补扫消化。

## 根因（两层，均已由 transcript/代码实证）

### 根因 1：prompt() 每轮 configure 覆盖 addTools 加载

`DurableSession.open()` 已做初始配置（`harness.root({agent})` + `conversation.configure(agentChange())`），
但 `prompt()` 内部**每轮**又执行 `conversation.configure(this.agentChange(), BACKGROUND_CONTEXT)`。

`agentChange()` 的 `tools` 数组把 deferred 工具过滤掉（`toolExposure?.[tool.name] !== "deferred"`），
`configure` 的替换语义（durable applyChange 整体替换字段）把 state.tools 重置为初始激活集。
tool_search 的 `control.addTools` 在同一 invoke 内把 deferred 工具 push 进 state.tools（生效），
但**下一 invoke 开头即被 configure 再次过滤移除**。

durable transcript 实证（修复前）：

```text
pi.system toolsAdded:   [speak, tool_search]          # 初始配置
pi.tool-result          loaded: ["add_terminology"]   # tool_search 命中
pi.system toolsAdded:   [add_terminology]             # addTools 生效（本 invoke 内）
pi.assistant            "loaded"                      # invoke 1 结束
pi.user                 "use it"                      # invoke 2 开始
pi.system toolsRemoved: [add_terminology]             # ← 每轮 configure 重置，加载被清掉
pi.tool-result          [error] Tool add_terminology is not available
```

### 根因 2：DurableToolSearch 检索全量 customTools

`DurableToolSearch` 构造入参是 `this.options.tools.customTools`（全量，含 direct 与 deferred），
而 SDK 版 tool_search 语义是 `candidates = api.agent(context).deferred`（只检索未激活工具）。
direct 工具已直接 offer 给模型，再被 BM25 命中列进 loaded 属于清单虚报（loaded 与可调用状态解耦）。

## 修法（decision-tree ① narrow-fix，既有语义内修）

1. **移除 prompt() 每轮 configure**（`durable-session.ts`）：初始配置由 open() 完成；
   session 生命周期内 model/thinkingLevel/extensions/tools 均不变（换模型走 restart 重建 session，
   cwd 走 setCwd），prompt/identity 经 otterExtension section 的动态 render 即时生效，无需 configure。
2. **DurableToolSearch 只收 deferred 工具**：`durable-session.ts` 传
   `customTools.filter(t => this.deferredTools.includes(t.name))`，与 SDK 版 candidates 语义对齐；
   `durable-tool-search.ts` 注释同步说明。

## Verification

### 失败用例证据（bugfix）

**修复前失败输出**（tests/frameworks/agent/tool-search-deferred.test.ts 修复前运行，
跨 prompt 用例 `getDeferredCalls() === 0`，transcript 见上）：

```text
pi.assistant [{"type":"toolCall","id":"term-2","name":"add_terminology","arguments":{}}]
pi.tool-result [{"type":"text","text":"<harness>\n[error] Tool add_terminology is not available\n</harness>"}]
```

**修复后通过输出**：

```text
✓ tests/frameworks/agent/tool-search-deferred.test.ts (2 tests)
  同 prompt 内 tool_search 加载后下一轮可调用 deferred 工具        ✓
  跨 prompt（下一 invoke）调用已加载 deferred 工具仍可执行        ✓  getDeferredCalls() === 1
```

**复现步骤**：`npx vitest run tests/frameworks/agent/tool-search-deferred.test.ts`——
该文件用 fauxProvider 模拟模型两轮调用（tool_search → deferred 工具），跨 prompt 断言工具真正执行。

回归面：`tests/frameworks/agent/` 62 文件 697 用例全绿；`tests/interface-adapters/agent-runtime/`
33 文件 245 用例全绿；`npx eslint .` 与 `npx tsc --noEmit` 通过。