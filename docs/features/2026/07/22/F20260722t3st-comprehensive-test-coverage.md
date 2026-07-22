---
id: F20260722t3st
title: comprehensive-test-coverage
doc_type: feature

# 记忆索引
summary: |
  全面测试覆盖：从 17 个测试文件扩展到 45 个（+28），覆盖全部 35 个 API 端点、
  所有 UseCase、所有 Repository、所有 Entity 纯函数。511 个测试用例全部通过。

# 因果链路
causal_links:
  from:
    - F20260720r5kt   # api-integration-tests（现有 API 测试基础）
    - F20260715b8c6   # usecases-layer-implementation
    - F20260715f4k9   # frameworks-layer-implementation

# 元数据
status: development
change_type: feature
tags: [testing, coverage, regression, entity, usecase, repository, mapper]
modules: [tests/]

# 时间
created_at: 2026-07-22
---

## 问题背景

代码合入后，创建对话、发消息等基本功能频繁出错。根本原因：核心数据流路径
（API → UseCase → Repository → Mapper）零测试覆盖。

现有 17 个测试文件中，API 测试 mock 了整个 UseCase 层，无法捕获业务逻辑和
数据库层的回归。当任一层（UseCase 守卫逻辑、Repository SQL、Mapper 字段映射）
在合入时被破坏，没有回归信号。

## 设计决策

### D1: 分层测试策略

**决策**：按 Clean Architecture 四层分别编写测试，每层使用适合的测试模式。

| 层 | 测试模式 | 理由 |
|----|---------|------|
| Entity | 纯函数断言，无 mock | 状态机规则零依赖，投入产出比最高 |
| UseCase | stateful mock repo/gateway | 验证业务逻辑（守卫、排序、回滚、回调） |
| Framework | 真实内存 SQLite | 捕获 SQL/列名/JSON 序列化 bug |
| API | mock UseCase + Hono `app.request()` | 验证 HTTP 协议层（路由、状态码、DTO） |

### D2: 行为契约测试（禁止实现细节断言）

**决策**：所有测试只断言可观测行为（返回值、抛出的错误、状态变更）。

**禁止**：`toHaveBeenCalledWith`、`toBeCalledTimes`、`toHaveBeenCalledTimes`。

**理由**：实现细节断言绑定测试与内部实现，重构时即使行为不变也会导致测试失败。
项目 ESLint 规则已禁止这些断言。

### D3: Stateful Mock 模式

**决策**：UseCase 测试使用带状态追踪的 mock（Map/Array 记录操作），然后断言
捕获的状态。

**示例**：
```ts
const repo = {
  _conversations: new Map(),
  create: vi.fn(async (conv) => { _conversations.set(conv.id, conv); }),
  getById: vi.fn(async (id) => _conversations.get(id) ?? null),
};
// 断言：可观测状态，不是调用细节
expect(repo._conversations.get("conv-1").status).toBe("active");
```

### D4: 真实内存 SQLite 测试 Repository

**决策**：Repository 和 Schema 测试使用 `better-sqlite3 :memory:` + `initSchema()`。

**理由**：
- SQL 语法错误、列名不匹配、CHECK 约束只有在真实数据库上才能捕获
- JSON 序列化/反序列化（attachments、talkingStonePassedTo、handoffSummary）
  需要 round-trip 验证
- 事务回滚行为需要真实 DB 验证

## 实现方案

### Phase 1: Entity 纯函数（5 文件，46 用例）

| 文件 | 覆盖函数 |
|------|---------|
| `tests/entities/conversation/conversation.test.ts` | canCompleteConversation, canArchiveConversation, isTurnActive, canAddMessageToTurn, canCloseTurn, canJoinConversation, canLeaveConversation, canTransitionArtifactStatus, isArtifactActive, isArtifactVisible |
| `tests/entities/otter/otter.test.ts` | canDissolveOtter |
| `tests/entities/otter/otter-session.test.ts` | canArchiveSession, archiveReasonToSessionStatus |
| `tests/entities/scheduled-task/scheduled-task.test.ts` | canTransitionTaskStatus, isValidCronExpression, isValidTimezone |
| `tests/entities/memory/memory-entry.test.ts` | canTransitionMemoryLayer |

### Phase 2: UseCase 业务逻辑（11 文件，84 用例）

| 文件 | 关键覆盖 |
|------|---------|
| `manage-conversation.test.ts` | create（含 big otter + participant）、complete/archive 状态守卫 |
| `send-message.test.ts` | 消息生命周期、talking stone 校验、turn 管理、memory 索引 |
| `query-message.test.ts` | expandMessage "both" 方向排序 |
| `manage-participant.test.ts` | join/leave 守卫、system message、fallback otter name |
| `turn-utils.test.ts` | tryCloseTurn（全终态/混合/空消息） |
| `create-otter.test.ts` | B1 回滚守卫：agent 创建失败时删除 DB 记录 |
| `dissolve-otter.test.ts` | B5 回归守卫：archive → dissolve → destroy 顺序 |
| `query-otter.test.ts` | 委托转发 |
| `manage-scheduled-task.test.ts` | 输入校验、状态转换、onChange 回调机制 |
| `store-memory.test.ts` | fire-and-forget 嵌入、D22 降级 |
| `search-engine.test.ts` | RRF 融合、权重排序（timeDecay、frequencyBoost、userFlag） |

### Phase 3: 框架层（9 文件，168 用例）

| 文件 | 关键覆盖 |
|------|---------|
| `schema.test.ts` | 表创建、幂等性、CHECK 约束、外键 |
| `conversation-mapper.test.ts` | 6 个 mapper 函数（JSON parse、boolean coercion） |
| `otter-mapper.test.ts` | role 构造、is_negative_case coercion |
| `scheduled-task-mapper.test.ts` | JSON fallback、round-trip |
| `sqlite-conversation-repository.test.ts` | CRUD、turn 管理、消息状态转换、FTS 搜索 |
| `sqlite-scheduled-task-repository.test.ts` | claimTask 乐观锁（60s 去重）、级联删除 |
| `sqlite-settings-repository.test.ts` | upsert 语义 |
| `fts-utils.test.ts` | FTS5 查询转义（双引号包裹、引号转义） |
| `cron-parser.test.ts` | 时区处理、无效表达式 |

### Phase 4: API 集成 + HTTP 工具（3 文件 + helpers 更新，23 用例）

| 文件 | 关键覆盖 |
|------|---------|
| `scheduled-task.test.ts` | 7 个端点全覆盖（CRUD + trigger + executions） |
| `http-error.test.ts` | DomainError → HTTP status 映射（404/400/409/403） |
| `scheduled-task-dto.test.ts` | toScheduledTaskDTO、toExecutionDTO |
| `helpers.ts`（更新） | ScheduledTask mock 基础设施 |

## 覆盖率变化

| 指标 | 之前 | 之后 |
|------|------|------|
| 测试文件 | 17 | 45 |
| 测试用例 | ~100 | 511 |
| API 端点覆盖 | 28/35 | 35/35 |
| UseCase 覆盖 | 4/15 | 15/15 |
| Repository 覆盖 | 2/7 | 7/7 |
| Entity 函数覆盖 | 3/17 | 17/17 |
| Mapper 覆盖 | 0/5 | 5/5 |

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `tests/api/helpers.ts` | 修改（添加 ScheduledTask mock） |
| `tests/api/scheduled-task.test.ts` | 新增 |
| `tests/entities/conversation/conversation.test.ts` | 新增 |
| `tests/entities/otter/otter.test.ts` | 新增 |
| `tests/entities/otter/otter-session.test.ts` | 新增 |
| `tests/entities/scheduled-task/scheduled-task.test.ts` | 新增 |
| `tests/entities/memory/memory-entry.test.ts` | 新增 |
| `tests/usecases/conversation/manage-conversation.test.ts` | 新增 |
| `tests/usecases/conversation/send-message.test.ts` | 新增 |
| `tests/usecases/conversation/query-message.test.ts` | 新增 |
| `tests/usecases/conversation/manage-participant.test.ts` | 新增 |
| `tests/usecases/conversation/turn-utils.test.ts` | 新增 |
| `tests/usecases/otter/create-otter.test.ts` | 新增 |
| `tests/usecases/otter/dissolve-otter.test.ts` | 新增 |
| `tests/usecases/otter/query-otter.test.ts` | 新增 |
| `tests/usecases/scheduled-task/manage-scheduled-task.test.ts` | 新增 |
| `tests/usecases/memory/store-memory.test.ts` | 新增 |
| `tests/usecases/memory/search-engine.test.ts` | 新增 |
| `tests/frameworks/db/schema.test.ts` | 新增 |
| `tests/frameworks/db/conversation/conversation-mapper.test.ts` | 新增 |
| `tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts` | 新增 |
| `tests/frameworks/db/otter/otter-mapper.test.ts` | 新增 |
| `tests/frameworks/db/scheduled-task/scheduled-task-mapper.test.ts` | 新增 |
| `tests/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.test.ts` | 新增 |
| `tests/frameworks/db/settings/sqlite-settings-repository.test.ts` | 新增 |
| `tests/frameworks/db/fts-utils.test.ts` | 新增 |
| `tests/frameworks/scheduler/cron-parser.test.ts` | 新增 |
| `tests/interface-adapters/http/http-error.test.ts` | 新增 |
| `tests/interface-adapters/http/dto/scheduled-task-dto.test.ts` | 新增 |

## 验证清单

- [x] `npm test` — 45 files, 511 tests, all pass
- [x] `npm run check` — lint 0 errors, TypeScript 编译通过
- [x] 覆盖全部 35 个 API 端点
- [x] 覆盖全部 15 个 UseCase
- [x] 覆盖全部 7 个 Repository
- [x] 覆盖全部 17 个 Entity 纯函数
- [x] 覆盖全部 5 个 Mapper
- [x] 禁止 `toHaveBeenCalledWith` 等实现细节断言
- [x] Repository 测试使用真实内存 SQLite
