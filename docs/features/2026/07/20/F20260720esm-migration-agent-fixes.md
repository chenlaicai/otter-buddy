# F20260720esm — ESM 迁移 + 自定义模型支持 + Agent 错误处理

## 状态

- [x] design
- [x] development
- [ ] review
- [ ] merge

## 概述

系统启动时报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，根因是 `@earendil-works/pi-ai`（ESM-only 包）的 exports 只定义了 `"import"` 条件，而项目是 CJS，TypeScript 编译时将 `import()` 转译为 `require()`。修复涉及 ESM 迁移、自定义模型注入、SDK API key 同步、Agent 错误处理改进、大獭自动创建、启动脚本等多项改动。

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | 按readme启动又报错了，Failed to start: ERR_PACKAGE_PATH_NOT_EXPORTED | 用户反馈 | 启动、报错 | ESM-only 依赖在 CJS 项目中无法加载 |
| UA-2 | 我配置的绝对是可用的，为什么你会说llm配置问题 | 用户纠正 | 配置可用、不是配置问题 | 自定义模型 `mimo-v2.5-pro` 不在内置列表中，但代理支持 |
| UA-3 | 对话报错了，没有可用的otter | 用户反馈 | 对话、报错 | 全新数据库缺少 big otter 种子数据 |
| UA-4 | 又报错，其他错误 | 用户反馈 | API key 报错 | SDK 不读 config.yaml 的 apiKey |
| UA-5 | 为什么是429但前台变成body empty错误 | 用户质疑 | 429、body empty | Agent 错误处理未透传真实 API 错误 |
| UA-6 | 不同worktree启动端口冲突情况考虑到了吗 | 用户提问 | worktree、端口冲突 | 需要端口冲突检测和 worktree 隔离 |

## [design-time] 问题分析

### 问题 1：ERR_PACKAGE_PATH_NOT_EXPORTED

**现象**：`npm start` 立即崩溃，报 `No "exports" main defined in @earendil-works/pi-ai/package.json`

**根因链**：
1. 项目 `"type": "commonjs"` + `"module": "commonjs"`
2. `@earendil-works/pi-ai` 的 exports 只定义 `"import"` 条件，无 `"require"` 或 `"default"`
3. TypeScript 编译 CJS 时将 `await import()` 转为 `require()`
4. Node.js CJS loader 找不到匹配的 exports 入口

**修复**：迁移到 ESM（`"type": "module"` + `"module": "ESNext"` + `"moduleResolution": "bundler"`）

### 问题 2：自定义模型不在内置列表

**现象**：`LLM model not found: provider=anthropic, model=mimo-v2.5-pro`

**根因**：`loadCustomProvider` 使用 `ANTHROPIC_MODELS`（字典对象），`createProvider` 需要数组格式，且自定义模型不在内置列表中

**修复**：字典转数组 + 注入自定义模型（含 `baseUrl`）

### 问题 3：SDK 不读 config.yaml 的 apiKey

**现象**：`No API key found for anthropic`

**根因**：`pi-coding-agent` SDK 使用自己的 `ModelRuntime` + `auth.json` 认证系统，不读 `config.yaml` 的 `apiKey`

**修复**：
- `main.ts`：`syncApiKeyToAgentAuth` 将 apiKey 写入 SDK 的 auth.json
- `pi-session-factory.ts`：创建 `ModelRuntime` + `setRuntimeApiKey` + 传入 `createAgentSession`

### 问题 4：大獭不存在

**现象**：`没有可用的 Otter`

**根因**：全新数据库无种子数据，`getBigOtter()` 返回 null

**修复**：`main.ts` 启动时自动创建 big otter

### 问题 5：Agent 错误信息丢失

**现象**：API 返回 429 quota exhausted，前端显示 "body must be non-empty string"

**根因**：SDK 内部处理 429 错误，`result.text` 为空，`sendMessage.complete` 校验 body 非空时报通用错误

**修复**：`agent-invoker.ts` 的 `extractAgentError` 从 `turn_end` 事件提取真实错误信息

## [design-time] 方案设计

### ESM 迁移

| 文件 | 改动 |
|------|------|
| `package.json` | `"type": "module"`, `tsc-alias -f` |
| `tsconfig.json` | `"module": "ESNext"`, `"moduleResolution": "bundler"` |
| `embedding-service.ts` | `__dirname` → `import.meta.url` |

### 自定义模型注入

`models-factory.ts` 的 `loadCustomProvider`：
- `ANTHROPIC_MODELS` 字典转数组
- 自定义模型不在列表时，以第一个内置模型为模板注入（含 `baseUrl`）
- `loadProvider` 传递 `modelId` 到 `loadCustomProvider`

### SDK API key 同步

1. `main.ts`：`syncApiKeyToAgentAuth` 写入 `~/.pi/agent/auth.json`
2. `pi-session-factory.ts`：
   - `ensurePiCodingAgent` 中创建 `ModelRuntime` + `setRuntimeApiKey`
   - 所有 `createAgentSession` 传入 `modelRuntime`

### 启动脚本

`scripts/otter-buddy.sh`：
- `start/stop/restart/status` 命令
- `-p <port>` 参数指定端口
- 端口冲突检测
- PID 文件按 worktree 隔离，`stop` 只杀当前 worktree 进程

## [design-time] 行为条目

| ID | 触发条件 | 预期行为 | 来源 |
|----|---------|---------|------|
| B-1 | 执行 `npm start` | 系统正常启动，无 ERR_PACKAGE_PATH_NOT_EXPORTED | UA-1 |
| B-2 | 配置 `provider: anthropic` + 自定义 `model` + `apiBaseUrl` | 自定义模型正确注入，API 调用使用自定义 URL | UA-2 |
| B-3 | 全新数据库首次启动 | 自动创建 big otter | UA-3 |
| B-4 | config.yaml 配置 `apiKey` | SDK 能找到 API key | UA-4 |
| B-5 | API 返回 429 quota exhausted | 前端显示真实错误信息 | UA-5 |
| B-6 | `./scripts/otter-buddy.sh start -p 3001` | 在指定端口启动 | UA-6 |
| B-7 | worktree1 占用 3000，worktree2 启动 3000 | 报错提示端口占用 | UA-6 |
| B-8 | worktree2 执行 `stop` | 只杀当前 worktree 进程 | UA-6 |

## [design-time] 验收标准

| ID | 验收条件 | 验证方法 |
|----|---------|---------|
| AC-1 | `npm start` 正常启动 | 执行 `npm start`，观察输出 |
| AC-2 | `GET /api/otters/big` 返回大獭 | `curl http://localhost:3000/api/otters/big` |
| AC-3 | 发送消息 agent 正常响应（需有效 API key） | 通过前端或 curl 发送消息 |
| AC-4 | API 配额耗尽时前端显示真实错误 | 观察 SSE error 事件 |
| AC-5 | `./scripts/otter-buddy.sh start -p 3001` 正常启动 | 执行脚本 |
| AC-6 | `npm test` 通过 | 执行 `npm test` |

## 决策记录

| 决策 | 理由 | 替代方案 | 决策模式 |
|------|------|---------|---------|
| ESM 迁移而非 patch 依赖 | 项目应跟进 ESM 趋势，patch 依赖不可维护 | 修改 pi-ai package.json（临时方案） | 技术事实 |
| `moduleResolution: "bundler"` 而非 `NodeNext` | `NodeNext` 不支持 path aliases | `NodeNext` + 重写所有别名（改动量大） | 权衡取舍 |
| `setRuntimeApiKey` 而非环境变量 | SDK 内置机制，可靠 | 设置 `ANTHROPIC_API_KEY` 环境变量（SDK 可能不检查） | 技术事实 |
| PID 文件按 worktree 隔离 | 避免 stop 误杀其他 worktree 进程 | 全局 PID 文件 + 端口匹配（复杂） | 简单性原则 |
