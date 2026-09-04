---
id: F20260904cg77
title: 启用 pi 内置 grep/find/ls 工具，削减 bash 一把梭的上下文膨胀源头
summary: 编码工具白名单从 read/write/edit/bash 扩展为 +grep/find/ls，搜索/浏览操作从无结构的 bash 管道迁移到 pi 专用工具（自带截断与格式化），削减上下文膨胀的最大单一来源。
change_type: fix
created_in_conversation: 7b5a13fc-5d21-4977-bec2-68fc1da24ae7
tags: [context-quality, tools, bash, grep, find, ls, pi-sdk]
modules: [src/frameworks/agent/]
from: [F20260904cq30]
supersedes: []
---

## 背景

上下文质量主线三件套之二（兄弟：#780 compaction 300K 已合入 PR #781；#779 图片外置待排期）。#780 解决「膨胀后何时压」，本 issue（#776）解决「膨胀的源头」。

**实证数据**（issue #776 原文 + 9/4 排查）：

- 海獭实际只持有 pi 的 4 个默认编码工具 `read/write/edit/bash`（`getCodingToolsForOtterType` 白名单）——**grep/find/ls 未启用**：pi 内置了它们但默认不激活（`sdk.js` L139：`defaultActiveToolNames = ["read", "bash", "edit", "write"]`）
- 后果：所有搜索/浏览操作全走 bash（`grep -rn ... | head` 这种），bash 输出无结构、带 shell 噪音、易截断不准
- **最大单一膨胀源**：《对话中invoke机制》大獭 session（01a05fbe）9/2-9/4 堆积 1.6M 字符，其中 bash 的 toolCall+toolResult 占 ~950K 字符（1054 次调用中 756 次是 bash），是 538K token 上下文膨胀的最大单一来源。上下文膨胀与 9/2-9/3 表现退化（瞎说/糊弄/听不懂纠正）时间线吻合（同对话 9/1 均值 64K → 9/3 均值 266K/峰值 743K）

## pi 侧机制（SDK 源码核实）

```
sdk.js L139: const defaultActiveToolNames = ["read", "bash", "edit", "write"];
sdk.js L144: const initialActiveToolNames = (options.tools ?? (...)).filter(...)
             // 显式传 options.tools → 覆盖默认白名单
agent-session.js L2175-2210: _buildRuntime → createAllToolDefinitions(cwd, ...)
             // 8 个工具（read/bash/powershell/edit/write/grep/find/ls）全部创建进 registry
agent-session.js L159: _refreshToolRegistry({ activeToolNames: this._initialActiveToolNames })
             // 按 activeToolNames 从 registry 激活
```

结论：pi 工具 registry 是「全量创建、按名激活」架构，白名单加入 `grep/find/ls` 即生效，**pi SDK 侧零改动**。

`tools/index.d.ts` 同时确认：`ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls"`，`createReadOnlyToolDefinitions = read/grep/find/ls` 组合（readOnly 模式天然兼容）。

## 变更

| 文件 | 变更 |
|------|------|
| `src/frameworks/agent/session-helpers.ts` | `getCodingToolsForOtterType` 返回值 `["read","write","edit","bash"]` → `["read","write","edit","bash","grep","find","ls"]`，注释补 Why（#776 实证数据 + pi 激活机制） |
| `tests/frameworks/agent/coding-tools.test.ts` | 4 个用例更新：+grep/find/ls 断言、toHaveLength(4)→(7) |

## 设计取舍

**为什么白名单加名即可、pi 侧零改动**：pi 的 `_buildRuntime` 每次都 `createAllToolDefinitions`（8 工具全量进 registry），`activeToolNames` 只是激活子集——我们唯一需要改的是传入 `createAgentSession({ tools: [...] })` 的数组，这正是 `getCodingToolsForOtterType` 的消费点（pi-session-factory.ts L560）。

**为什么不删 bash**：bash 仍是必需工具（构建命令、git 操作、多命令组合）。本变更不禁止 bash，只是给 LLM 提供「语义更准、输出更省」的专用选项——行为引导靠工具描述本身（专用工具的 schema/description 天然引导 LLM 在搜索场景选它们），不靠 prompt 强制。

**readOnly 模式不受影响（回归核实）**：两层过滤均与本变更正交——
1. coding 侧：`pi-session-factory.ts` L563 `readOnly ? codingTools.filter(t => t === 'read') : codingTools`——无论白名单含几个工具，readOnly 恒只剩 `read`
2. 自定义工具侧：`SYNTHESIS_READ_ONLY_TOOL_WHITELIST`（F20260901mbfx）只管自定义工具，与 coding 工具白名单无关

**issue 建议第 3 条（prompt/skill 层引导）不在本 PR**：属于行为引导层，与工具启用解耦。工具描述本身即引导（见上），先观察实际迁移率（观察方式见验证节），引导不足再补。

## 验证

- 单测 9/9 通过（coding-tools.test.ts，4 用例更新为 7 工具断言）
- `tests/frameworks/agent/` 全量 338 用例通过（readOnly 路径在此覆盖）
- 全量 `npm test`：236 文件 / 2934 用例通过，lint（pretest 内置）零 error
- **最简实现检查**：已过——仓库已有实现（pi 内置工具全量在 registry，只差白名单点名）＞ stdlib ＞ 已装依赖；本变更共 2 文件 1 行逻辑 + 测试断言更新，无更简实现空间
- **生效路径**：进程重启 → 所有 otter（big/small）invoke 时 session 按新白名单激活 grep/find/ls。旧 session（已有 activeToolNames 持久化）不受影响，新 session 生效
- **观察指标**（后续 daily-review 可查）：messages 表 context_tokens 增速；session 文件中 bash 调用占比——预期搜索类 bash 调用迁移到 grep/find 工具，bash 总次数下降

## 关联

- issue #776（Closes）
- 兄弟 issue：#780（compaction 300K，已合入）、#779（图片外置，待排期）
- 前文：F20260904cq30（本主线一期，质量线 + 假水位线删除）
