---
id: F20260720qs9y
title: per-conversation-otter
doc_type: feature

# 记忆索引
summary: |
  将全局单例大獭改为每个对话独立创建大獭，实现对话级隔离。
  移除全局 AgentRegistry，改为按需创建 AgentHarness，支持多对话并发。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716ttf7   # system-integration-and-startup
    - F20260713o4t8   # domain-otter

# 元数据
status: locked
change_type: feature
tags: [otter, conversation, isolation, concurrency]
modules: [src/frameworks/agent/, src/interface-adapters/agent-runtime/]

# 时间
created_at: 2026-07-20
---

# F20260720qs9y — 每个对话创建独立大獭，移除全局单例大獭

## 状态

- [x] design
- [x] development
- [ ] review
- [ ] merge

## 概述

当前系统在启动时创建一个全局单例的"大獭"（Big Otter），所有对话共享这个大獭。这导致多个对话同时进行时，Agent Session 的上下文相互污染、Session 交接失效、记忆召回不准确等问题。本特性将架构改为每个对话创建时自动创建独立的大獭实例，确保每个对话拥有独立的 Agent Session、Session 交接链、动态上下文和工具调用计数。

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | 大獭应该是每一个对话创建时，初始化一个本对话的大獭；不存在什么系统启动时初始化一个大獭、全系统共享这个大獭 | 用户消息 | 每一个对话创建时、初始化一个本对话的大獭、不存在全系统共享 | 用户明确指出当前架构设计缺陷：全局单例大獭会导致底层 agent session 混乱。期望：每个对话拥有独立的大獭实例。 |

## [design-time] 问题分析

### 现象

当前系统架构存在以下问题：

1. **系统启动时创建全局单例大獭** (`main.ts:365-370`)
2. **所有对话共享同一个大獭** (`conversation/index.tsx:184-185`)
3. **Agent Session 按 otterId 管理** (`pi-session-factory.ts:199-227`)

### 根因链

1. `main.ts` 在启动时检查是否存在大獭，不存在则创建一个全局单例
2. 前端创建对话时，将全局大獭的 ID 传入 `otterIds` 数组
3. `PiSessionFactory` 维护的 `sessionStore`、`staticPrompts`、`otterTypes`、`activeSessions` 都以 otterId 为 key
4. 由于只有一个全局大獭，所有对话共享这些状态

### 影响范围

| 问题 | 影响 |
|------|------|
| Session 上下文混乱 | 多个对话同时进行时，session 上下文相互污染 |
| Session 交接失效 | `handoffSession` 针对单个 otter，会影响所有关联对话 |
| 记忆召回不准确 | `sessionSummary` 是 otter 级别，不是对话级别 |
| 工具调用计数错误 | `activeSessions` 的 `toolCallCount` 是 otter 级别 |

### 为什么之前没发现

系统可能处于早期开发阶段，用户通常一次只进行一个对话，未触发多对话并发场景下的问题。

## [design-time] 方案设计

### 推荐方案：每个对话创建时自动创建独立大獭

**技术理由**：
- 每个对话拥有独立的 Agent Session，避免上下文污染
- 每个对话拥有独立的 Session 交接链，交接操作不会影响其他对话
- 每个对话拥有独立的动态上下文（sessionSummary），记忆召回更精准
- 每个对话拥有独立的工具调用计数，熔断器行为更准确

**具体变更**：

1. **移除系统启动时创建全局大獭的逻辑** (`main.ts`)
2. **修改 `ManageConversation`**：创建对话时自动创建独立大獭
3. **移除 `getBigOtter` 相关代码**：
   - `OtterRepository.getBigOtter()` 接口
   - `QueryOtter.getBigOtter()` 方法
   - `OtterController.getBigOtter()` 端点
   - `/api/otters/big` 路由
   - `SqliteOtterRepository.getBigOtter()` 实现
4. **修改对话列表接口**：不再依赖 otterId 参数，返回所有对话
5. **前端适配**：移除对全局大獭的依赖

**风险**：
- 不兼容变更：移除 `/api/otters/big` 端点
- 不兼容变更：对话创建 API 不再需要 `otterIds` 参数
- 不兼容变更：对话列表 API 不再需要 `otterId` 查询参数

**替代方案**：保持全局大獭，但为每个对话创建独立的 Agent Session 映射。此方案复杂度高，且无法解决 Session 交接问题。

### 不兼容更新

1. 移除 `/api/otters/big` 端点
2. 对话创建 API (`POST /api/conversations`) 不再需要 `otterIds` 参数
3. 对话列表 API (`GET /api/conversations`) 不再需要 `otterId` 查询参数

### 实现指引

- `ManageConversation` 构造函数需要注入 `CreateOtter` 用例
- `initUseCases` 函数需要调整依赖顺序，先创建 `createOtter`，再创建 `manageConversation`
- `ConversationRepository` 需要添加 `getAllIds()` 方法
- `ConversationController.list()` 需要调用 `getAllIds()` 而非 `getIdsByOtterId()`

## [design-time] 行为条目

| ID | 触发条件 | 预期行为 | 来源 |
|----|---------|---------|------|
| B-1 | 创建新对话 | 自动创建独立的大獭实例，关联到该对话 | UA-1 |
| B-2 | 多个对话同时进行 | 各对话的 Agent Session 上下文相互独立，不会污染 | UA-1 |
| B-3 | 对话进行 Session 交接 | 仅影响当前对话，不会影响其他对话 | UA-1 |
| B-4 | 查询对话列表 | 返回所有对话，不再需要 otterId 参数 | 架构调整 |
| B-5 | 系统启动 | 不再创建全局单例大獭 | 架构调整 |

## [design-time] 验收标准

| ID | 验收条件 | 验证方法 |
|----|---------|---------|
| AC-1 | 创建对话时自动创建独立大獭 | 创建对话后，查询该对话的参与者，应包含一个新创建的大獭 |
| AC-2 | 各对话的 Agent Session 相互独立 | 同时进行两个对话，验证 session 上下文不会相互污染 |
| AC-3 | `/api/otters/big` 端点已移除 | 访问 `/api/otters/big` 应返回 404 |
| AC-4 | 对话列表 API 不再需要 otterId 参数 | `GET /api/conversations` 应返回所有对话 |
| AC-5 | 所有测试通过 | 执行 `npm test` |

## 决策记录

| 决策 | 理由 | 替代方案 | 决策模式 |
|------|------|---------|---------|
| 每个对话创建独立大獭 | 避免 Agent Session 上下文污染，简化架构 | 保持全局大獭但创建独立 Session 映射（复杂度高） | 用户明确要求，技术事实 |
| 移除 getBigOtter 相关代码 | 不再需要全局大獭，减少代码复杂度 | 保留但标记为废弃（增加维护成本） | 简化架构，自主决策 |
| 对话列表返回所有对话 | 每个对话有独立大獭，无法通过 otterId 筛选 | 保留 otterId 参数但改为可选（语义不清） | 架构调整，自主决策 |
