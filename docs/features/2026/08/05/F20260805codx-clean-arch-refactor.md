---
id: F20260805codx
title: clean-arch-refactor
doc_type: feature

summary: |
  架构重构：将 900 行 main.ts Composition Root 拆分为 8 个职责单一的 bootstrap 模块，
  消除跨层引用（13 → 2），修复类型安全问题，提升高内聚低耦合。
  经过两轮架构自检，确保 main.ts 仅做纯组装、零业务逻辑。

status: final
change_type: refactor
tags: [architecture, clean-arch, composition-root, refactoring, code-quality]
modules:
  - src/main.ts
  - src/bootstrap/types.ts
  - src/bootstrap/repositories.ts
  - src/bootstrap/database.ts
  - src/bootstrap/memory.ts
  - src/bootstrap/usecases.ts
  - src/bootstrap/clients.ts
  - src/bootstrap/platforms.ts
  - src/bootstrap/controllers.ts
  - src/bootstrap/server.ts

created_at: 2026-08-05
---

# F20260805codx 架构重构：Composition Root 拆分

**PR**: #155
**类型**: Feature Update（架构重构）
**日期**: 2026-08-05
**检视方法**: 架构师视角自检 → 修复 → 对抗性审查

---

## 项目背景

`main.ts` 作为 Composition Root 承担了所有依赖注入职责，随功能迭代膨胀至 ~900 行，
混合了 DB 初始化、Repository 创建、UseCase 组装、平台集成、HTTP 控制器装配、服务器启动等逻辑，
且存在 13 个直接跨层引用（frameworks/usecases/interface-adapters），违反整洁架构原则。

同期，发言链调度引擎（`DispatchChainEngine`）穿透访问 `SendMessage.repo`，
存在 interface-adapters → usecases 反向耦合。

---

## 问题清单与分级

| # | 问题 | 位置 | 风险 | 优先级 |
|---|------|------|------|--------|
| 1 | `DispatchChainEngine` 直接访问 `SendMessage.repo` | `dispatch-chain-engine.ts` | HIGH | P0 |
| 2 | main.ts 900 行，跨层引用 13 个 | `main.ts` | MEDIUM | P1 |
| 3 | bootstrap 模块存在 10 个 TS 编译错误 | `bootstrap/*.ts` | HIGH | P0 |
| 4 | `initUseCases` 6 参数（lint max-params） | `bootstrap/usecases.ts` | LOW | P2 |
| 5 | `startServer` 冗余 `port` 参数 | `bootstrap/server.ts` | LOW | P2 |
| 6 | `createFeishuBundle` 重复检查 `appConfig.feishu` | `bootstrap/platforms.ts` | LOW | P2 |
| 7 | SettingsConfig/NodeFileSystem 分散在 main.ts | `main.ts` | LOW | P2 |
| 8 | `{} as OtterToolClient` 危险空断言 | `main.ts` | MEDIUM | P1 |

---

## 修复策略

### 第一批：消除发言链穿透耦合（P0）

**文件**: `src/usecases/conversation/dispatch-chain-engine.ts`

**现状**: `DispatchChainEngine` 通过 `sendMessage.repo` 直接访问 `ConversationRepository`，
违反 usecase 层的依赖方向。

**方案**: 注入 `ConversationRepository` 作为独立依赖，消除对 `SendMessage` 内部实现的耦合。

---

### 第二批：main.ts Composition Root 拆分（P1）

将 main.ts 拆分为 8 个 bootstrap 模块，按职责划分：

#### `types.ts`（60 行）
- 定义 `Repositories` 和 `UseCases` 接口
- 聚合所有 Repository 和 UseCase 类型

#### `repositories.ts`（29 行）
- `initRepositories(db)` — 从 Database 实例创建所有 Repository
- 使用 `SqliteTerminologyRepository`（非 `SqliteMemoryRepository`）

#### `database.ts`（120 行）
- `initDatabaseAndModels` — DB 初始化 + schema/migration + 模型 + embedding
- `postInitDatabase` — 种子数据 + 孤儿修复 + ledger 回填
- `postSyncMigrations` — sync 后的 chunk 迁移
- `validateModelAliases` — 模型别名校验
- `shutdownDatabase` — DB 关闭
- `syncApiKeyToAgentAuth` — API key 同步

#### `memory.ts`（128 行）
- `MemoryIndexAdapter` — MemoryIndexGateway 实现
- `createMemoryIndex` — 工厂函数
- `syncDocuments` — 文档同步

#### `usecases.ts`（61 行）
- `UseCaseDeps` options 对象（解决 max-params）
- `initUseCases(deps)` — 创建所有 UseCase 实例

#### `clients.ts`（135 行）
- `buildOtterToolClient(uc)` — 构建 OtterToolClient
- `buildMessageClient / buildMemoryClient / buildResourceClient` — 子客户端

#### `platforms.ts`（195 行）
- `createAgentGateway` — 创建 PiSessionFactory，解决 OtterToolClient 循环依赖
- `createDispatchChainEngine` — 发言链调度引擎
- `initAgentAndScheduler` — Agent + Scheduler 初始化
- `createFeishuBundle` — 飞书集成
- `setupFeishu` — 飞书长连接启动
- `initPlatforms` — Healing + Recruiting 平台初始化

#### `controllers.ts` + `server.ts`（131 行）
- `initControllers` — HTTP 控制器装配（内部构建 SettingsConfig）
- `startServer` — Hono 服务器启动 + 静态路由

---

### 第三批：架构自检修复（P1-P2）

自检发现 5 个问题，系统性修复：

| # | 问题 | 修复 |
|---|------|------|
| P0 | main.ts 13 个跨层引用 | agentGateway/DB 生命周期/SettingsConfig/NodeFileSystem 移入对应 bootstrap |
| P1 | `{} as OtterToolClient` | `resolveOtterToolClient` 回调模式，initUseCases 后注入真实实例 |
| P2 | `startServer` 冗余 `port` | 内部从 `appConfig.server.port` 提取 |
| P2 | `createFeishuBundle` 重复检查 | 移除冗余 guard |
| P2 | SettingsConfig 分散 | `initControllers` 接收 `appConfig + modelPool`，内部构建 |

---

## 类型安全修复

| 问题 | 修复 |
|------|------|
| `initDatabase(dbPath)` 传 string | → `initDatabase(appConfig.db)` 传 DatabaseConfig |
| `ensureBgeM3Model(path, hfMirror, logger)` 3 参数 | → `ensureBgeM3Model(appConfig.embedding, logger)` 2 参数 |
| `initEmbeddingService` 返回值未解构 | → `const { service, dispose } = await initEmbeddingService(...)` |
| `terminology` 类型为 SqliteMemoryRepository | → SqliteTerminologyRepository |
| MessageBroadcaster 重复导入 | 删除 `import type` 行 |
| `MemoryContentType` 用 `string[]` | → `MemoryContentType[]` |
| `ArtifactStatus` 用 `string` | → `ArtifactStatus` |

---

## 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| bootstrap 目录 vs 拆分到各层 | 集中 `bootstrap/` | Composition Root 豁免跨层引用，集中管理装配逻辑更清晰 |
| OtterToolClient 循环依赖 | `resolveOtterToolClient` 回调 | 比 `{} as T` 空断言安全；比 lazy proxy 简单 |
| `initUseCases` 参数模式 | options 对象 | 解决 max-params lint；语义更清晰 |
| `startServer` 参数模式 | `ServerDeps` 对象 | 消除冗余 port 参数；可扩展 |
| `SettingsConfig` 构建位置 | controllers.ts 内部 | 高内聚：SettingsConfig 仅 controllers 使用 |
| `postInitDatabase` 独立函数 | 是 | initDatabaseAndModels 聚焦 DB/模型；后置操作语义独立 |
| `createFeishuBundle` 返回类型 | `FeishuBundle`（非 optional） | 调用方已确认 `appConfig.feishu` 存在 |

---

## 架构改善

```
Before:
  main.ts (900行)
  ├── 13 个跨层引用（frameworks/usecases/interface-adapters）
  ├── DB 初始化 + 迁移 + 种子数据 + 修复
  ├── Repository 创建
  ├── UseCase 组装
  ├── Agent/飞书/Scheduler 初始化
  ├── HTTP 控制器装配
  └── 服务器启动 + 信号处理

After:
  main.ts (92行, 2个基础设施引用, 纯组装)
  └── bootstrap/
      ├── types.ts          — 类型定义
      ├── repositories.ts   — Repository 实例化
      ├── database.ts       — DB 生命周期（init/post/shutdown）
      ├── memory.ts         — Memory 索引 + 文档同步
      ├── usecases.ts       — UseCase 工厂
      ├── clients.ts        — OtterToolClient 构建
      ├── platforms.ts      — Agent + 飞书 + 平台集成
      ├── controllers.ts    — HTTP 控制器
      └── server.ts         — Hono 服务器
```

---

## 验证

| 检查项 | 结果 |
|--------|------|
| ESLint | 0 errors, 0 warnings |
| TypeScript | 编译通过 |
| 单元测试 | 84 文件, 1036 项全部通过 |
| main.ts 跨层引用 | 13 → 2（仅 PinoLogger + loadConfig） |
| main.ts 行数 | 900 → 92 |

---

## 提交历史

| Commit | 描述 |
|--------|------|
| `07f30e2` | 消除发言链对 SendMessage.repo 的穿透耦合 |
| `2223878` | 拆分 main.ts Composition Root 为 bootstrap 模块 |
| `9496af0` | 架构自检修复: 消除 main.ts 剩余跨层引用 |

---

## 不在范围

| 问题 | 排除理由 |
|------|----------|
| `platforms.ts` 仍然 195 行 | 可进一步拆分飞书/Agent/Scheduler，但当前职责边界已清晰 |
| `Repositories` 接口使用具体类型 | Composition Root 豁免；改为接口需全仓 sweep |
| `initControllers` 参数对象 15+ 字段 | 可拆分子对象，但当前可读性可接受 |

---

*本方案经过两轮架构自检，由架构师视角驱动。*
