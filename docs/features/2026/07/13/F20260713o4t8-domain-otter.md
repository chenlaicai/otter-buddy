---
id: F20260713o4t8
title: domain-otter
from_ids: [F20260709p4q7, F20260710b3m9, F20260713i5k2]
tags: [implementation, s4, domain, otter, ddd, agent]
modules: [domain/otter]
doc_kind: spec
status: locked
created_at: 2026-07-13
---

# F20260713o4t8 [domain/otter] Otter 领域模块

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。进入实现阶段后不得单方面修改，如需变更须通过问题卡片向用户提出并确认。
>
> 本文档设计 domain/otter 模块。经架构调整（D-S3-2），otter 模块不仅管理数据记录，还管理 pi-agent 实例的生命周期。实现顺序为步骤 ④（infra 层全部完成后），依赖 infra/db + infra/agent-core。

## 背景 [required]

S3-A8 原设计中 domain/otter 为纯 CRUD 模块，pi-agent-core 集成在 app/agent-runtime。用户纠正：每个海獭实例对应底层 pi-agent 的 session chain，otter 模块必须管理 Agent 实例，不只是数据库记录。经两位架构师交叉审视，将 pi-agent-core 抽象移到 infra/agent-core（D-S3-2），domain/otter 依赖 infra/agent-core 管理 Agent 生命周期。

### 约束输入

- S3-A1 DDL -- otters + otter_sessions 表结构
- S3-A2 OtterRepository 接口 -- 8 个方法
- S3-A8 代码目录结构 -- model.ts + port.ts + _internal/{repository, mapper, adapter, initor}
- S2 Pi Agent 能力映射 -- 大獭=持久 Agent 实例，小獭=临时 Agent 实例，重启獭生=Agent.reset()
- S2 UC3 时序图 -- OtterService 负责初始化 Agent(systemPrompt + context + tools)
- D-S3-2 偏差 -- pi-agent-core 从 app/agent-runtime 移到 infra/agent-core
- F20260710b3m9 -- infra/base 已完成

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| 模块结构 | model.ts + port.ts + _internal/ | S3-A8 D29 |
| OtterPort 范围 | 8 方法 + Agent 生命周期管理 | 架构师-1 + 架构师-2 共识 |
| Agent 管理方式 | 通过 infra/agent-core 的 AgentRegistry | D-S3-2 |
| getBigOtter 错误处理 | 找不到时 throw（系统不变量） | 架构师-2 提出 |
| Session 'restarted' 语义 | archive_reason='restart' -> status='restarted'，其余 -> 'archived' | 架构师-2 提出 |
| dissolve 范围 | otter 数据 + Agent 销毁。session 归档和 skill 回收由 app/orchestration 编排 | 架构师-2 提出 |
| create 不加载 Skills | 避免 domain-to-domain 依赖，Skill 加载由 app/agent-runtime 编排 | 架构师-2 提出 |
| OtterPort 不暴露 Agent 执行方法 | sendMessage/getResponse 由 app/agent-runtime 通过 AgentRegistry 直接操作 | 架构师-2 提出 |
| UUID 生成 | crypto.randomUUID() | 架构师-2 提出 |
| 测试位置 | tests/domain/otter/ 统一目录 | F20260710b3m9 用户确认 |

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | F20260710b3m9 UA-S4-2 | 应该是一个一个模块完整实现，不需要一次性将所有模块都实现 | 粒度：一个一个模块；要求：完整实现 | domain/otter 需完整实现含 Agent 管理 + 测试 |
| UA-2 | F20260710b3m9 UA-S4-4 | infra都应该全是基础设施，如果量不大，是否可以一次性做完呢 | 范围：全部 infra 应全是基础设施 | infra 层不应依赖 domain 层，pi-agent-core 属于 infra |
| UA-3 | 当前讨论 msg#4641 | 为什么infra/embedding要依赖memory domain？这是拆解的不够清晰吗？infra应该是基础设施，模块依赖途径一定要搞清楚 | 疑问：infra 依赖 domain；要求：依赖途径搞清楚 | S3-A8 表格 infra/embedding -> memoryPort 依赖方向错误，详见 D-S3-1 |
| UA-4 | 当前讨论 msg#4645 | 每一个海獭实例都对应底层pi agent的session chain（涉及到session交接、组成的链路） | 每个：海獭实例；对应：pi agent session chain；涉及：交接、链路 | otter 模块必须管理 pi-agent 实例，不只是数据 CRUD |
| UA-5 | 当前讨论 msg#4645 | 对话模块 与 海獭模块 的模块边界要清晰，前者是对话，后者是 海獭实例 | 边界：清晰；前者：对话；后者：海獭实例 | conversation 管对话数据，otter 管海獭实例（含 Agent） |
| UA-6 | 当前讨论 msg#4645 | 底层是pi agent、那海獭模块与pi agent又是如何交互的 | 疑问：如何交互 | otter 通过 infra/agent-core 的 AgentRegistry 管理 Agent 生命周期 |
| UA-7 | 当前讨论 msg#4645 | 是否可以先把pi agent和embding 这些 infra层都整理好，然后再来做domain | 建议：先 infra 后 domain | 实现顺序调整：先全部 infra，再 domain |
| UA-8 | 当前讨论 msg#4645 | 有多个小獭实例（每个小獭有自己的角色、描述） | 数量：多个小獭；属性：各自角色、描述 | 小獭创建时角色信息（名称+职责列表）必须正确存储 |
| UA-9 | 当前讨论 msg#4645 | 每个小獭被赋予的能力不同这些能力由什么机制来承载 | 疑问：能力由什么机制承载 | domain/capability 管理数据层，app/agent-runtime 将 Skill 转为 AgentTool 注册到 Agent（本模块不实现转换，但在非目标中声明） |

## 目标 [required]

### P1 - domain/otter 模块完整实现

实现 domain/otter 模块，包含：
- 领域模型定义（Otter, OtterSession, OtterRole 及相关值对象）
- OtterPort 公开接口（8 个方法，含 Agent 生命周期管理）
- SQLite 持久化（Repository + Mapper）
- 业务逻辑适配器（Adapter，实现 OtterPort，编排 data + Agent 操作）
- 工厂函数（Initor，创建 repo + adapter + agentRegistry，返回 port）

### P2 - 可独立验证

通过集成测试验证：
- Otter CRUD 全流程（create -> getById -> dissolve），create 同时创建 Agent 实例
- Session 生命周期全流程（createSession -> getActiveSession -> archiveSession -> getSessionHistory）
- archiveSession 触发 AgentRegistry.reset()
- dissolve 触发 AgentRegistry.destroy()
- getBigOtter 在无大獭时 throw
- Session status 根据 archive_reason 正确设置

## 非目标 [required]

- 不实现 app/orchestration（跨模块编排属于步骤 ⑨）
- 不实现 app/agent-runtime（对话执行 + SSE 属于步骤 ⑩）
- 不实现 createSmallOtter 编排（含 skillIds 分配，由 app/orchestration 编排）
- 不实现 triggerRestart 编排（含 memory layer 变更，由 app/orchestration 编排）
- 不实现 dissolveOtter 编排（含 skill 回收 + session 归档，由 app/orchestration 编排）
- 不实现 Skill-to-AgentTool 转换（由 app/agent-runtime 编排）
- 不实现 Agent 执行方法（sendMessage/getResponse，由 app/agent-runtime 通过 AgentRegistry 直接操作）
- 不实现其他 domain 模块
- 不修改 infra 已有代码

## 设计 [required]

### 模块范围

```
src/domain/otter/
├── model.ts                 # 公开类型（Entity, Value Object）
├── port.ts                  # 公开接口（OtterPort）
└── _internal/               # 私有实现（ESLint 禁止跨模块 import）
    ├── repository.ts        # SQLite 持久化
    ├── mapper.ts            # 领域对象 <-> DB 行映射
    ├── adapter.ts           # 业务逻辑（实现 OtterPort，编排 data + Agent）
    └── initor.ts            # 工厂函数

tests/domain/otter/
├── repository.test.ts       # 集成测试（real SQLite :memory:）
└── adapter.test.ts          # 单元测试（mock repository + mock AgentRegistry）
```

### 1. model.ts -- 领域模型

```typescript
// 值对象
type OtterType = 'big' | 'small';
type OtterStatus = 'active' | 'dissolved';
type SessionStatus = 'active' | 'archived' | 'restarted';

interface OtterRole {
  name: string;
  responsibilities: string[];  // S3 DDL: JSON array of strings
}

// 实体
interface Otter {
  id: string;
  name: string;
  type: OtterType;
  status: OtterStatus;
  role: OtterRole | null;
  parentOtterId: string | null;
  createdAt: string;
  dissolvedAt: string | null;
}

interface OtterSession {
  id: string;
  otterId: string;
  status: SessionStatus;
  startedAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
  isNegativeCase: boolean;
  summary: string | null;
}

// 输入类型
interface CreateOtterInput {
  name: string;
  type: OtterType;
  roleName?: string;
  roleResponsibilities?: string[];
  parentOtterId?: string;
  systemPrompt?: string;     // Agent 系统提示词（大獭用默认 prompt，小獭由 app/orchestration 根据角色生成）
  context?: string;           // Agent 初始上下文（如小獭创建时注入的相关记忆/前情摘要）
}

interface ArchiveSessionInput {
  reason: string;              // 'restart' | 'dissolve' | 'manual'
  isNegativeCase?: boolean;
  summary?: string;
}
```

### 2. port.ts -- OtterPort 接口

```typescript
interface OtterPort {
  // --- Otter 生命周期（数据 + Agent） ---
  create(params: CreateOtterInput): Promise<Otter>;
  getById(id: string): Promise<Otter | null>;
  getBigOtter(): Promise<Otter>;
  dissolve(otterId: string): Promise<void>;

  // --- Session 生命周期（数据 + Agent reset） ---
  createSession(otterId: string): Promise<OtterSession>;
  getActiveSession(otterId: string): Promise<OtterSession | null>;
  archiveSession(sessionId: string, params: ArchiveSessionInput): Promise<void>;
  getSessionHistory(otterId: string): Promise<OtterSession[]>;
}
```

**方法行为说明**：

| 方法 | 数据层操作 | Agent 层操作 | 说明 |
|------|-----------|-------------|------|
| create() | INSERT otter | AgentRegistry.create(otterId, config) | 创建记录 + Agent 实例。**不加载 tools**（由 app/agent-runtime 编排） |
| getById() | SELECT otter | 无 | 纯数据查询 |
| getBigOtter() | SELECT otter WHERE type='big' AND status='active' | 无 | 未找到 **throw**（系统不变量） |
| dissolve() | UPDATE otter status='dissolved', dissolved_at=now | AgentRegistry.destroy(otterId) | 标记解散 + 销毁 Agent。session 归档和 skill 回收由 app/orchestration 编排 |
| createSession() | INSERT otter_session (status='active') | 无 | 新建 session 记录。Agent 实例不变 |
| archiveSession() | UPDATE otter_session status/archived_at/archive_reason/is_negative_case/summary | AgentRegistry.reset(otterId) | 归档 session + 重置 Agent 上下文。status: reason='restart'->'restarted'，其余->'archived' |
| getActiveSession() | SELECT session WHERE otter_id=? AND status='active' | 无 | 纯数据查询 |
| getSessionHistory() | SELECT sessions WHERE otter_id=? ORDER BY started_at DESC | 无 | 返回全部 session（含 active） |

**S2 接口委托路径**：

| S2 OtterService 方法 | 委托路径 | 说明 |
|---------------------|---------|------|
| getBigOtter() | OtterPort.getBigOtter() | 直接映射 |
| getOtter(id) | OtterPort.getById(id) | 直接映射 |
| createSmallOtter({ name, role, skillIds }) | app/orchestration: OtterPort.create({ type:'small', ...role }) + CapabilityPort.assignToOtter() + OtterPort.createSession() + app/agent-runtime 加载 tools | 跨模块编排 |
| dissolveOtter(id) | app/orchestration: OtterPort.dissolve(id) + CapabilityPort.revokeAll() + OtterPort.archiveSession() | 跨模块编排 |
| triggerRestart(id) | app/orchestration: OtterPort.archiveSession(reason='restart') + MemoryPort.updateLayer() + OtterPort.createSession() + 注入前情摘要到 Agent | 跨模块编排 |

### 3. _internal/adapter.ts -- 业务逻辑

**关键逻辑**：

| 逻辑 | 实现 |
|------|------|
| create | 1. crypto.randomUUID() 生成 ID 2. INSERT otter 记录 3. AgentRegistry.create(otterId, { systemPrompt, context }) |
| dissolve | 1. UPDATE otter status='dissolved' 2. AgentRegistry.destroy(otterId) |
| archiveSession | 1. 确定 status: reason='restart'->'restarted'，其余->'archived' 2. UPDATE session 3. AgentRegistry.reset(otterId) |
| getBigOtter 找不到 | throw new Error('Big Otter not found') |

**依赖注入**：

```typescript
// initor.ts 伪代码
function initOtter({ db, agentRegistry }: { db: Database.Database; agentRegistry: AgentRegistry }): OtterPort {
  const repository = new OtterRepository(db);
  const adapter = new OtterAdapter(repository, agentRegistry);
  return adapter;
}
```

### 4. _internal/mapper.ts -- 映射规则

| DB 列 | 领域字段 | 转换 |
|-------|---------|------|
| role_name | OtterRole.name | 直接映射（NULL -> OtterRole 为 null） |
| role_responsibilities | OtterRole.responsibilities | JSON.parse / JSON.stringify（TEXT <-> string[]） |
| is_negative_case | OtterSession.isNegativeCase | INTEGER 0/1 <-> boolean |
| parent_otter_id | Otter.parentOtterId | 直接映射（NULL -> null） |
| dissolved_at | Otter.dissolvedAt | 直接映射（NULL -> null） |

## 偏差记录 [required]

### D-S3-1: infra/embedding 依赖方向纠正

**偏差对象**：S3-A8 实现顺序表格（F20260709p4q7 第 1037 行）

| 项目 | S3-A8 表格（错误） | 正确设计 |
|------|-------------------|---------|
| infra/embedding 依赖 | memoryPort（domain） | 无 domain 依赖（纯 Worker Thread） |
| initEmbedding 参数 | { db } | () 或 ({ modelPath? }) |

**依据**：S2 部署图 + main.ts 伪代码 + 分层原则。按 D28 记录偏差，S3 文档不修改。

### D-S3-2: pi-agent-core 从 app 移到 infra

**偏差对象**：S3-A8 代码目录结构 + 实现顺序（F20260709p4q7 S3-A8）

| 项目 | S3-A8 原设计 | 修订设计 |
|------|-------------|---------|
| pi-agent-core 位置 | app/agent-runtime（步骤 ⑦） | infra/agent-core（步骤 ②） |
| domain/otter 职责 | 纯 CRUD | 数据 + Agent 生命周期管理 |
| domain/otter 依赖 | infra/db | infra/db + infra/agent-core |
| 实现顺序 | otter(①) 在 agent-core(⑦) 之前 | infra 先行，otter(④) 在 agent-core(②) 之后 |
| app/agent-runtime 职责 | pi-agent-core 集成 + Agent 管理 | 简化：对话路由 + Skill-to-AgentTool 转换 + SSE 分发 |

**依据**：
1. 用户纠正（msg#4645）：每个海獭实例对应 pi-agent session chain
2. S2 能力映射表：大獭=持久 Agent 实例，小獭=临时 Agent 实例
3. S2 UC3 时序图：OtterService 负责 Agent 初始化
4. 分层原则：pi-agent-core 是技术能力，属于 infra

**影响**：实现顺序调整，domain/otter 推迟到步骤 ④。F20260713o4t8 文档已修订反映此变化。

## 硬约束 [required]

- 所有表使用 `CREATE TABLE IF NOT EXISTS`，禁止 ALTER TABLE
- domain 模块间不互相依赖，跨模块操作全部在 app/orchestration 编排（D29）
- OtterPort 不暴露 Agent 执行方法（sendMessage/getResponse）
- OtterPort.create() 不加载 Skills（避免 domain-to-domain 依赖）
- ESLint 禁止跨模块 import `_internal/`（main.ts 豁免）
- OtterPort 是 domain/otter 唯一的公开接口
- OtterPort.dissolve() 假设调用方（app/orchestration）已归档活跃 session。未归档时 Agent message context 将丢失，不恢复不报错

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| Agent 管理位置 | domain/otter 通过 infra/agent-core | app/agent-runtime 集中管理 | otter 模块需完整管理实例生命周期，否则是半成品 |
| OtterPort 不含 Agent 执行 | 执行由 app/agent-runtime 通过 AgentRegistry | OtterPort 暴露执行方法 | 避免 infra 类型泄漏到 Port 接口 |
| create 不加载 Skills | app/agent-runtime 编排 | OtterPort.create 内加载 | 避免 domain-to-domain 依赖 |
| getBigOtter 找不到时 | throw | 返回 null | 大獭存在是系统不变量 |
| Session 'restarted' status | reason='restart' -> 'restarted' | 统一 'archived' + archive_reason | status 为主过滤条件，直观区分 |
| dissolve 范围 | otter 数据 + Agent 销毁 | 包含 session 归档 + skill 回收 | 跨模块操作由 app/orchestration 编排 |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/domain/otter/model.ts` | 新增 | 领域模型类型定义 |
| `src/domain/otter/port.ts` | 新增 | OtterPort 接口 |
| `src/domain/otter/_internal/repository.ts` | 新增 | SQLite 持久化 |
| `src/domain/otter/_internal/mapper.ts` | 新增 | 领域对象映射 |
| `src/domain/otter/_internal/adapter.ts` | 新增 | 业务逻辑（data + Agent 编排） |
| `src/domain/otter/_internal/initor.ts` | 新增 | 工厂函数（注入 db + agentRegistry） |
| `tests/domain/otter/repository.test.ts` | 新增 | 集成测试 |
| `tests/domain/otter/adapter.test.ts` | 新增 | 单元测试（mock repository + mock AgentRegistry） |

## 验证 [required]

### 验收标准

- [ ] `npm run check` 通过（lint + build）
- [ ] `npm run test` 通过
- [ ] create 同时创建数据记录 + Agent 实例（验证 AgentRegistry.create 被调用）
- [ ] dissolve 同时更新数据 + 销毁 Agent（验证 AgentRegistry.destroy 被调用）
- [ ] archiveSession 触发 AgentRegistry.reset()
- [ ] Otter CRUD 全流程（create -> getById -> dissolve）
- [ ] getBigOtter 在无大獭时 throw
- [ ] Session 生命周期全流程
- [ ] archiveSession reason='restart' -> status='restarted'，其余 -> 'archived'
- [ ] role_responsibilities JSON 序列化/反序列化正确
- [ ] 外键约束生效
- [ ] ESLint 对 `_internal/` 跨模块 import 报错

### 测试设计

#### tests/domain/otter/repository.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| create + getById | 创建 Otter 后可按 ID 查询 |
| create 大獭 | type='big' 的 Otter 可创建 |
| create 小獭含角色 | role_name + role_responsibilities 正确存储和读取 |
| dissolve | status -> 'dissolved', dissolved_at 非空 |
| getById 未找到 | 返回 null |
| createSession | 创建 session，status='active' |
| getActiveSession | 返回活跃 session |
| archiveSession restart | status -> 'restarted', archive_reason='restart' |
| archiveSession dissolve | status -> 'archived', archive_reason='dissolve' |
| getSessionHistory | 返回全部 session，按时间倒序 |
| 外键约束 | otter_id 不存在时 INSERT session 抛出异常 |
| role_responsibilities JSON | 存储 string[]，读取回 string[] |

#### tests/domain/otter/adapter.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| create 调用 AgentRegistry.create | mock AgentRegistry，验证 create 被调用 |
| dissolve 调用 AgentRegistry.destroy | mock AgentRegistry，验证 destroy 被调用 |
| archiveSession 调用 AgentRegistry.reset | mock AgentRegistry，验证 reset 被调用 |
| getBigOtter 找不到 | throw Error |
| create 生成 UUID | 返回的 Otter.id 为有效 UUID |

## 关联 [required]

- **S3 数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **infra/base 基础设施基础层**：[F20260710b3m9](../10/F20260710b3m9-infra-base-foundation.md)
- **infra 层 LLM+Agent+Embedding**：[F20260713i5k2](./F20260713i5k2-infra-llm-agent-embedding.md)
- **S2 能力模块架构设计**：[F20260709m2n8](../09/F20260709m2n8-capability-module-architecture.md)
- **项目实施计划**：[otter-buddy#5](https://github.com/chenlaicai/otter-buddy/issues/5)

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-Otter-1 | 当创建海獭时 | 同时创建数据记录和 pi-agent 实例 | ← UA-4, UA-6 |
| B-Otter-2 | 当解散小獭时 | otter.status='dissolved' + AgentRegistry.destroy | ← UA-4 |
| B-Otter-3 | 当归档 Session 时 | session status 更新 + AgentRegistry.reset 清空上下文 | ← UA-4 |
| B-Otter-4 | 当查询大獭但不存在时 | throw 错误（系统不变量） | 不适用（架构师决策） |
| B-Otter-5 | 当 Session 因重启归档时 | status='restarted', archive_reason='restart' | 不适用（架构师决策） |
| B-Otter-6 | 当 Session 因其他原因归档时 | status='archived', archive_reason 记录具体原因 | 不适用（架构师决策） |
| B-Otter-7 | 当查询 Session 历史时 | 返回全部 Session（含 active），按开始时间倒序 | 不适用（架构师决策） |
| B-Otter-8 | 当创建小獭含角色时 | 角色信息（名称+职责列表）和创建者 ID 正确存储 | ← UA-8 |
| B-Otter-9 | 当创建海獭时 | Agent 使用传入的 systemPrompt 和 context 初始化 | ← UA-4, UA-6 |
