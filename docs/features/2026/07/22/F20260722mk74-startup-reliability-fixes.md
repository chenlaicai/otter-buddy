---
id: F20260722mk74
title: startup-reliability-fixes
doc_type: feature

summary: |
  修复 `otter-buddy.sh start` 启动脚本和运行时的四个可靠性问题：
  1. `set -e` 下 `var=$(failing_cmd)` 静默吞掉 build 错误，脚本无提示退出
  2. 首次创建对话时冷加载 pi-coding-agent SDK，阻塞 HTTP 响应数秒
  3. speak 工具完成后 SDK agent loop 继续产生重复的 `assistant_text` SSE 事件
  4. onnxruntime-node 1.24.1+ 移除 darwin/x64 二进制，Rosetta 下 Node.js 无法加载 embedding 模型

causal_links:
  from:
    - F20260721de6j   # 可观测性与日志基础设施（pino 引入）
    - F20260721speak   # speak Skill（assistant_text 事件模型）

status: implemented
change_type: bugfix
tags: [startup, script, embedding, sse, sdk, onnxruntime]
modules: [scripts, frameworks/agent, frameworks/embedding, interface-adapters/agent-runtime, usecases/memory]

created_at: 2026-07-22
---

# F20260722m7x4 - 启动与运行时可靠性修复

## 1. 问题描述

### Bug 1：启动脚本静默吞掉 build 错误

`scripts/otter-buddy.sh` 第 2 行 `set -euo pipefail`，第 50 行：

```bash
build_output=$(npm run build 2>&1)
local build_exit=$?
```

在 `set -e` 下，如果 `npm run build` 返回非零退出码，脚本在第 50 行直接终止，不走后面的错误处理分支。用户只看到 `[1/4] Building backend ...` 然后无提示退出。

### Bug 2：首次对话创建冷启动阻塞

`PiSessionFactory.ensurePiCodingAgent()` 在首次 `create()` 调用时懒加载：
- 动态 `import("@earendil-works/pi-coding-agent")` — ESM 大模块解析
- `ResourceLoader.reload()` — 扫描 `./skills` 目录
- `ModelRuntime.create()` + `setRuntimeApiKey()` — SDK 内部初始化

这些操作在 HTTP 请求路径上同步等待，阻塞对话创建响应。

### Bug 3：speak 后重复 assistant_text 事件

pi-coding-agent SDK 的 agent loop 在 `speak` 工具执行后继续运行：处理 tool result → 调用 LLM → 产生新的 `message_end` 事件。该事件包含文本内容，被 `mapToSSEEvent` 映射为 `assistant_text`，与 speak body 内容重复。

事件流：
1. Turn N: LLM 生成 speak 工具调用 → `assistant_toolcall`
2. speak 工具执行 → `tool.result`
3. Turn N+1: LLM 处理 tool result 生成文本 → `assistant_text`（重复）

### Bug 4：onnxruntime-node 缺少 darwin/x64 二进制

`onnxruntime-node` 从 1.24.1 版本起移除了 `darwin/x64` 二进制文件。系统为 Apple Silicon Mac 但 Node.js 以 x64 模式运行（Rosetta），`process.arch` 返回 `x64`，加载 `bin/napi-v6/darwin/x64/onnxruntime_binding.node` 失败。

依赖链：`@huggingface/transformers@4.2.0` → `onnxruntime-node@1.24.3`（精确版本锁定）。

## 2. 修复方案

### Fix 1：`if !` 屏蔽 set -e

将两处 build 调用从：

```bash
build_output=$(npm run build 2>&1)
build_exit=$?
if [ $build_exit -ne 0 ]; then ...
```

改为：

```bash
if ! build_output=$(npm run build 2>&1); then ...
```

`if !` 语法屏蔽 `set -e`，确保错误信息能正确输出。

### Fix 2：启动时预加载 SDK

`PiSessionFactory` 新增 `warmup()` 公开方法，调用 `ensurePiCodingAgent()`。`main.ts` 在创建 `agentGateway` 后、启动 HTTP 服务前调用 `await agentGateway.warmup()`，将 SDK 加载开销从首次对话创建移到启动阶段。

### Fix 3：speak 后抑制后续 assistant_text

`AgentInvoker.executeAgentInvocation` 中新增 `speakCompleted` 标记。当收到 `tool_execution_end` 且工具名为 `speak` 时置为 `true`，后续 `assistant_text` 类型的 SSE 事件不再推送给前端。

每次 `invokeConversation` 调用独立维护 `speakCompleted` 状态，不影响 speak 重试逻辑（重试创建新的调用栈）。

### Fix 4：npm overrides 降级 onnxruntime-node

`package.json` 添加 overrides：

```json
"overrides": {
  "@huggingface/transformers": {
    "onnxruntime-node": "1.23.2"
  }
}
```

1.23.2 是最后包含 `darwin/x64` 二进制的版本。

### Fix 5：embedding 日志优化

- `EmbeddingGateway` 接口新增 `available: boolean` 只读属性
- `EmbeddingServiceImpl` 实现 `available` getter（基于 `readyState.ready`）
- 模型加载失败时在 `embedding-service.ts` 打一条 warn 日志（取代原来每条记忆一条 warn）
- `store-memory.ts` 中 embed 失败日志从 `warn` 降为 `debug`

## 3. 影响范围

| 文件 | 变更 |
|------|------|
| `scripts/otter-buddy.sh` | build 错误处理 |
| `src/frameworks/agent/pi-session-factory.ts` | 新增 `warmup()` |
| `src/main.ts` | 启动时调用 `warmup()` |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | speak 后抑制重复事件 |
| `src/frameworks/embedding/embedding-service.ts` | 模型加载失败日志 |
| `src/usecases/memory/embedding-gateway.ts` | 接口新增 `available` |
| `src/usecases/memory/store-memory.ts` | embed 失败日志降级 |
| `package.json` | onnxruntime-node override |
| `tests/usecases/memory/*.test.ts` | mock 补充 `available` |
