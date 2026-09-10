---
id: F20260908clgd
title: "ResourceLoader 屏蔽 CLAUDE.md 祖先目录发现（closes #496）"
summary: "Pi SDK 的 DefaultResourceLoader 从 cwd 逐层向上发现 CLAUDE.md/AGENTS.md 注入 system prompt 的 <project_context> 段，主仓根的 CLAUDE.md（Claude Code 项目指令）属无关指令污染。修复：registry 初始化传 noContextFiles: true。issue 原判断（customPrompt 路径 B 被堵死致 promptSnippet/promptGuidelines 失效）经 SDK 源码核实不成立——tool snippet/guidelines 失效的真实原因是 otter 工具从未注册这两个字段，与 CLAUDE.md 无关。"
change_type: fix
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 303b94d4-b3ad-4de4-9ee4-2b54da95f9a2
tags: [sdk, system-prompt, resource-loader, claude-md]
modules:
  - src/frameworks/agent/model-runtime-registry.ts
  - tests/frameworks/agent/claudemd-guard.test.ts
created_at: 2026-09-08
---

# ResourceLoader 屏蔽 CLAUDE.md 祖先目录发现（closes #496）

## 背景

Issue #496（P2，8/26 登记）：Pi SDK 的 `ResourceLoader` 会自动发现项目根目录下的 `CLAUDE.md`，被当成 agent system prompt 源，导致 `buildSystemPrompt` 走 early return 路径，tool `promptSnippet`/`promptGuidelines` 机制失效。

## 核实后的根因修正（与 issue 原判断有出入）

读 SDK 源码（`resource-loader.js` / `system-prompt.js` / `agent-session.js`）逐链路核实：

1. **`customPrompt` 来源不是 CLAUDE.md**：`discoverSystemPromptFile()` 只找 `.pi/SYSTEM.md`（项目可信时）和 `agentDir/SYSTEM.md`，候选列表不含 CLAUDE.md。本项目 `customPrompt` 恒为 `.pi/SYSTEM.md` 内容，**路径 A（early return）是有意设计**，otter 的 system prompt 真相源就是 `.pi/SYSTEM.md` + `before_agent_start` 追加。
2. **CLAUDE.md 走 contextFiles 通道**：`loadProjectContextFiles()` 从 cwd 逐层向上找 `CLAUDE.md`/`AGENTS.md`，在**两条路径**（A 和 B）都会注入 `<project_context>` 段——这才是真实污染源：Claude Code 的项目指令被注入 otter agent 的 system prompt。
3. **promptSnippet/promptGuidelines 失效的真实原因**：otter 的 `AgentTool` 注册时从未提供这两个字段（`agent-session.js:752` 起收集非空 snippet/guidelines，otter 注册侧为空），与 CLAUDE.md 无关。当前全部行为引导塞在 `description` 字段是历史选择，非机制被堵。

## 修复

`model-runtime-registry.ts` 创建 `DefaultResourceLoader` 时传 `noContextFiles: true`（SDK 原生选项，`resource-loader.d.ts:81`）：

- 效果：`loadProjectContextFiles` 整段跳过，CLAUDE.md/AGENTS.md 不再注入 otter agent
- 不影响：`.pi/SYSTEM.md` 发现（独立函数）、`before_agent_start` per-session 注入、Claude Code 自身（不走 Pi SDK）

## 测试

`tests/frameworks/agent/claudemd-guard.test.ts`，3 条用例：

1. `noContextFiles: true` → 祖先目录 CLAUDE.md 不进入 agentsFiles
2. **对照组**：不传 noContextFiles → CLAUDE.md 被发现（证明 SDK 默认行为即污染源，防未来 SDK 改默认值时此测试无感知）
3. 源码锚定：registry 初始化参数包含 `noContextFiles: true`（防配置被静默移除）

## 验证

- 新增测试 3/3 通过
- `npx tsc --noEmit` 0 error
- `tests/frameworks/agent/` 目录全量回归 24 文件 351 测试全绿
- 最简检查：SDK 原生布尔选项一行解决，无更简实现
- 行为影响：当前主仓 CLAUDE.md 仅一行标题（`# CLAUDE.md`），修复后 agent 行为零变化，纯堵未来污染（如 Claude Code 用户在 CLAUDE.md 写入真实指令后污染 otter）

## Discovered Issues

无。
