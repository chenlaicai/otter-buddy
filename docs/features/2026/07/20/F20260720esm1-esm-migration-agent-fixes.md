---
id: F20260720esm1
title: esm-migration-agent-fixes
doc_type: feature

# 记忆索引
summary: |
  项目从 CJS 迁移到 ESM，修复 pi-ai/pi-coding-agent 两个 ESM-only 依赖的加载问题。
  新增自定义模型注入（支持 mimo-v2.5-pro）、SDK API key 同步、Agent 错误处理改进、
  消息事件模型重构、流式过程 UI、启动脚本等多项改动。

# 因果链路
causal_links:
  from:
    - F20260720h7a4   # TypeScript 路径别名修复

# 元数据
status: development
change_type: fix
tags: [esm, agent, sdk, model, startup, ui]
modules: [src/frameworks, src/interface-adapters, web, scripts]

# 时间
created_at: 2026-07-20
---

# F20260720esm1 - ESM 迁移 + Agent 运行时适配 + 消息事件模型

## 1. 需求背景

### 1.1 问题陈述

| 问题 | 现象 | 根因 |
|------|------|------|
| 启动崩溃 | `ERR_PACKAGE_PATH_NOT_EXPORTED` | CJS 项目加载 ESM-only 依赖 |
| 模型找不到 | `LLM model not found: mimo-v2.5-pro` | 自定义模型不在内置列表 |
| API key 缺失 | `No API key found for anthropic` | SDK 不读 config.yaml |
| 错误信息丢失 | 429 显示为 "body empty" | 错误处理未透传真实 API 错误 |
| 消息事件不完整 | 只存 tool_call/tool_result | 缺少 assistant_toolcall/assistant_text |

### 1.2 设计目标

1. 项目迁移到 ESM，兼容 pi-ai/pi-coding-agent
2. 支持自定义模型（通过 config.yaml 配置）
3. SDK API key 自动同步
4. Agent 错误信息透传到前端
5. 消息事件模型完整覆盖 SDK 所有事件
6. 流式过程 UI 实时展示

## 2. 设计方案

### 2.1 ESM 迁移

| 文件 | 改动 |
|------|------|
| `package.json` | `"type": "module"`, `tsc-alias -f` |
| `tsconfig.json` | `"module": "ESNext"`, `"moduleResolution": "bundler"` |
| `embedding-service.ts` | `__dirname` → `import.meta.url` |

### 2.2 自定义模型注入

`models-factory.ts` 的 `loadCustomProvider`：
- `ANTHROPIC_MODELS` 字典转数组
- 自定义模型不在列表时注入（只继承连接属性，不继承 contextWindow/maxTokens）
- `loadProvider` 传递 `modelId`

### 2.3 SDK API key 同步

1. `main.ts`：`syncApiKeyToAgentAuth` 写入 `~/.pi/agent/auth.json`
2. `pi-session-factory.ts`：
   - 创建 `ModelRuntime` + `setRuntimeApiKey`
   - 所有 `createAgentSession` 传入 `modelRuntime`

### 2.4 消息事件模型

| SDK 事件 | 存为 event_type | 说明 |
|---------|----------------|------|
| message_end (assistant+toolCall) | `assistant_toolcall` | agent 决策：调什么工具 |
| tool_execution_end | `tool_result` | 工具执行结果 |
| message_end (assistant+text) | `assistant_text` | agent 最终文本输出 |

**过滤规则**：thinking 不存储，user/toolResult 不重复存储。

### 2.5 流式过程 UI

- SSE 事件实时推送到 `StreamingState.events`
- `EventItem` 组件：`[event_type]` 标签 + 关键信息 + 折叠详情
- 复制按钮（lucide Copy/Check 图标）
- Markdown 渲染（GFM + 代码高亮）

### 2.6 启动脚本

`scripts/otter-buddy.sh`：
- `start/stop/restart/status` 命令
- `-p <port>` 参数指定端口
- 端口冲突检测
- 优雅停机（SIGTERM → 5s → SIGKILL）
- PID 按 worktree 隔离

## 3. 行为条目

| ID | 触发条件 | 预期行为 |
|----|---------|---------|
| B-1 | `npm start` | 正常启动，无 ERR_PACKAGE_PATH_NOT_EXPORTED |
| B-2 | 配置自定义 model + apiBaseUrl | 模型正确注入，API 调用使用自定义 URL |
| B-3 | config.yaml 配置 apiKey | SDK 能找到 API key |
| B-4 | API 返回 429 | 前端显示真实错误信息 |
| B-5 | `./scripts/otter-buddy.sh start -p 3001` | 在指定端口启动 |
| B-6 | worktree 端口冲突 | 报错提示端口占用 |

## 4. 验收标准

| ID | 验收条件 | 验证方法 |
|----|---------|---------|
| AC-1 | `npm start` 正常启动 | 执行 `npm start` |
| AC-2 | 发送消息 agent 正常响应 | 前端或 curl 测试 |
| AC-3 | API 配额耗尽时显示真实错误 | 观察 SSE error 事件 |
| AC-4 | `npm test` 通过 | 执行 `npm test` |

## 5. 决策记录

| 决策 | 理由 | 替代方案 |
|------|------|---------|
| ESM 迁移而非 patch 依赖 | 项目应跟进 ESM 趋势 | 修改 pi-ai package.json |
| `moduleResolution: "bundler"` | `NodeNext` 不支持 path aliases | `NodeNext` + 重写别名 |
| `setRuntimeApiKey` 而非环境变量 | SDK 内置机制，可靠 | 设置环境变量 |
| 自定义模型只继承连接属性 | 避免 contextWindow 等数值错误 | 继承全部属性 |
| 后端存储 assistant_toolcall + tool_result | 前后端 event 1:1 对应 | 前端合并展示 |
| body 强制 fixme | 等 set_final_body 工具实现 | 用 assistant_text 作为 fallback |
