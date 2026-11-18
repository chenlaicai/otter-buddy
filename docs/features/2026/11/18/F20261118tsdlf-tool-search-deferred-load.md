---
id: F20261118tsdlf
title: "tool_search 加载 deferred 工具跨 invoke 失效 + loaded 清单虚报 direct 工具：#1894"
change_type: fix
created: 2026-11-18
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
modules:
  - src/frameworks/agent/durable-session.ts
  - src/frameworks/agent/durable-tool-search.ts
summary: "#1894：tool_search 返回 loaded 后实际调用报 not available（healing event 058d8ea2）。根因：open() 与 prompt() 都全量 configure(agentChange())，把 state.tools 重置为初始激活集、覆盖 addTools 加载的 deferred 工具（当 invoke toolsAdded、下 invoke/冷启动重开 toolsRemoved），调用报 tool_unavailable；且 DurableToolSearch 候选集只含 customTools 全集（含 direct）、漏 deferred MCP。修法 decision-tree ①：open()/prompt() 不再全量 configure（初始配置由 harness.root 首次创建时写入）；DurableToolSearch 候选集改 getter，收 deferred customTools + deferred MCP extraTools，对齐 SDK candidates=agent.deferred。"
tags: [tool-search, deferred, durable-session, bugfix, P2]
intent:
  problem: "tool_search 的 loaded 清单与实际可调用状态脱钩：加载的 deferred 工具在下一 invoke 报 not available（跨 invoke 失效），direct 工具被误列进 loaded（清单虚报）。獭按 loaded 清单规划工作后撞墙，#1894 实证 manage_scheduled_task_pending 两次调用 not available，2 条 pending 定时任务最终靠机械释放兜底。"
  expected_effect: "修复后：tool_search 命中 deferred 工具并 addTools 后，该工具在当前 invoke、后续 invoke、冷启动重开同一 durable 库后均可调用（open()/prompt() 不再全量 configure，但重开时仍刷新 model/thinkingLevel/extensions/cwd，不重置 tools/modelTools）；loaded 清单只含 deferred 工具（direct 不虚报），deferred MCP 工具进入检索面（含 MCP-only session）。回归测试 tests/frameworks/agent/tool-search-deferred.test.ts 覆盖同 prompt、跨 prompt、冷启动重开、direct 排除、deferred MCP、MCP-only、model 重开刷新七条路径。"
  verify_by:
    type: behavior_check
    note: "tests/frameworks/agent/tool-search-deferred.test.ts 7 用例：同 prompt 与跨 prompt 调用 deferred 工具均执行；冷启动重开不加 tool_unavailable；direct 不被搜进 loaded；deferred MCP 命中；MCP-only 也注册 tool_search；model 重开刷新。全量 tests/frameworks/agent + tests/interface-adapters/agent-runtime 95 文件 953 用例全绿。"
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

## 根因（均已由 transcript/代码实证）

### 根因 1：open() 与 prompt() 的全量 configure 覆盖 addTools 加载

`agentChange()` 的 `tools` 数组把 deferred 工具过滤掉（`toolExposure?.[tool.name] !== "deferred"`），
而 durable `configure` 是替换语义（applyChange 整体替换字段）。两处全量 configure 都在抹掉已加载的 deferred 工具：

1. `prompt()` 内部**每轮** `configure(this.agentChange())`——tool_search 的 `control.addTools` 在同一
   invoke 内把 deferred 工具 push 进 state.tools（生效），下一 invoke 开头即被 configure 再次过滤移除。
2. `open()` 里 `harness.root({agent})` 之后又**显式** `configure(agentChange())`——root 只在 root conversation
   首次创建时写入 agent，重开同一 durable 库时这行显式 configure 把 state.tools 重置为初始清单，
   冷启动重开后再调用已加载 deferred 工具同样 `not available`（检视发现 1 实证）。

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

### 根因 2：DurableToolSearch 候选集错位

`DurableToolSearch` 原构造入参是 `this.options.tools.customTools`（全量 customTools，含 direct 与 deferred），
且**只含 customTools**——SDK 版 tool_search 语义是 `candidates = api.agent(context).deferred`（所有未激活
工具，含 deferred MCP）。两个错位：

- direct 工具已直接 offer 给模型，再被 BM25 命中列进 loaded 属清单虚报。
- deferred MCP 工具（`DurableMcpBridge` 对未显式 exposure 的 MCP 工具默认 `deferred: true`，注册进
  `extraTools`）不在候选集内，tool_search 搜不到（检视发现 2 实证）。

## 修法（decision-tree ① narrow-fix，既有语义内修）

1. **open()/prompt() 不再全量 configure**（`durable-session.ts`）：初始 tools/modelTools 只由
   `harness.root({agent})` 在 root conversation 首次创建时写入；prompt() 完全不再 configure。
   open() 重开时只 configure 会变字段（`model/thinkingLevel/extensions/cwd`），不重置 tools/modelTools——
   这样既保留 addTools 加载（冷启动重开不 not available），又让 restart/冷启动重新解析的新模型与新
   工作区写入 AgentDoc（检视 delta 发现 1：模型切换/新 cwd 生效）。
2. **DurableToolSearch 候选集改为 getter**：`durable-session.ts` 传 `() => [deferred customTools
   ∪ deferred MCP extraTools]`——MCP extraTools 在 open() 阶段才就位，构造时固定数组会漏掉它们；
   `durable-tool-search.ts` 构造签名从 `LegacyTool[]` 改为 `() => ReadonlyArray<ToolSearchCandidate>`。
3. **tool_search 注册条件含 MCP**：`(deferredTools.length > 0 || options.mcp !== undefined)`——
   MCP 工具默认 deferred（非 direct exposure 均 deferred），MCP-only session（无 custom deferred）
   也需要检索入口（检视 delta 发现 2）。

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
✓ tests/frameworks/agent/tool-search-deferred.test.ts (7 tests)
  同一 prompt 内 tool_search 加载后下一轮可调用 deferred 工具        ✓
  跨 prompt（下一 invoke）调用已加载 deferred 工具仍可执行          ✓
  冷启动重开同一 durable 库后已加载 deferred 工具仍可调用          ✓
  direct 工具不被搜进 loaded                                      ✓
  deferred MCP 工具在 tool_search 检索面内                         ✓
  MCP-only session 也注册 tool_search 并可检索 deferred MCP        ✓
  重开时 model 刷新生效，已加载 deferred 工具仍可调用              ✓
```

**复现步骤**：`npx vitest run tests/frameworks/agent/tool-search-deferred.test.ts`——
该文件用 fauxProvider 模拟模型调用（tool_search → deferred 工具），覆盖同 prompt/跨 prompt/
冷启动重开/direct 排除/deferred MCP/MCP-only/model 重开刷新七条路径。

回归面：`tests/frameworks/agent` + `tests/interface-adapters/agent-runtime` 95 文件 953 用例全绿；
`npx eslint .` 与 `npx tsc --noEmit` 通过。