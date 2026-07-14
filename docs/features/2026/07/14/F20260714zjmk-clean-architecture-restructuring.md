---
id: F20260714zjmk
title: clean-architecture-restructuring
from_ids: [F20260709p4q7, F20260709m2n8, F20260709x7k3, F20260713o4t8, F20260713i5k2, F20260713m5q3, F20260713e8n4]
tags: [architecture, refactor, clean-architecture, incompatible]
modules: [src/]
doc_kind: spec
status: locked
created_at: 2026-07-14
---

# F20260714zjmk 架构调整：DDD 四层 → 整洁架构

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。进入实现阶段后不得单方面修改，如需变更须通过问题卡片向用户提出并确认。

本文档定义从 DDD 四层架构到整洁架构的 Greenfield 重构方案。经两位架构师交叉审视 + 用户指令，关键决策记录为 D30-D42 + KDR-1 至 KDR-6。

## 背景 [required]

### 当前架构状态

项目当前采用 **DDD 分层 + 六边形架构（Ports & Adapters）**，定义为 S3 的 D29 决策。四层结构为：

```
adapter (外部接口) -> app (跨模块编排) -> domain (原子业务模块) -> infra (技术能力)
```

已实现的模块：
- `infra/`：db、config、logger、llm-gateway、agent-core、embedding（全部完成）
- `domain/otter/`：model + port + _internal/{repository, mapper, adapter, initor}（完成）
- `domain/memory/`：model + port + _internal/{repository, search-engine, mapper, adapter, initor}（完成）
- `domain/conversation/`：model + port + _internal/{repository, mapper, adapter, initor}（完成）
- `app/`、`adapter/`、`web/`：未开始

### 用户提出的变更方向

用户参考 Uncle Bob 2012 年的 Clean Architecture 博文，提出直觉判断：整洁架构更符合 LLM 的思维方式，准备将项目调整为整洁架构。

### Clean Architecture 核心原则（摘要）

1. **依赖规则**：源代码依赖只能向内指向（外层依赖内层，内层不知道外层）
2. **独立于框架**：架构不依赖某个库的存在
3. **可测试性**：业务规则无需 UI、数据库、Web 服务器即可测试
4. **独立于 UI**：UI 可替换而不影响系统其余部分
5. **独立于数据库**：业务规则不知道数据库的存在
6. **独立于外部机构**：业务规则不知道外部世界

同心圆（由内向外）：
1. **Entities**（企业业务规则）—— 最通用、最不容易变化
2. **Use Cases**（应用业务规则）—— 编排数据流进出 entities
3. **Interface Adapters**（接口适配器）—— 控制器、展示器、网关
4. **Frameworks & Drivers**（框架与驱动）—— Web、DB、UI 等细节

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "参考https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html，你先分析" | 条件：参考指定文献；时序：先分析 | 用户要求架构师先分析 Clean Architecture 博文内容，不要跳到方案 | msg-1 |
| UA-2 | "我感觉 整洁架构 是符合LLM的思维方式" | 条件：符合 LLM 思维方式 | 用户直觉认为整洁架构的分层模式与 LLM 生成代码的思维路径一致，需要架构师验证此假设 | msg-1 |
| UA-3 | "我准备将本项目调整下，改为整洁架构" | 时序：准备（尚未最终决定）；对象：本项目；目标：改为整洁架构 | 用户有明确意图将项目从当前 DDD 四层架构调整为整洁架构，"准备"表明需要方案后再确认 | msg-1 |
| UA-4 | "我有个疑问，那其实现在其实可以将现有代码全都先移除？比如说放到一个临时目录作为参考。然后按照 整洁架构 从头开始 实现。就不用考虑迁移了。因为当前已实现的 可能是 整洁架构中的外层，而内层则还没有，所以没办法做迁移（因为没办法 现有外层 再有 内层）" | 对象：现有代码全部；操作：移除并放临时目录作参考；方式：从头开始实现；理由：现有=外层，内层未建，无法迁移（外层先于内层存在，无法反向构建） | 用户指出迁移路径不可行：现有代码属于整洁架构的外层，内层尚未存在，无法从外向内迁移。应采用 greenfield 方式，从内向外构建 | msg-4 |

## 目标 [required]

1. 分析 Clean Architecture 是否确实符合 LLM 思维方式（验证 UA-2）
2. 识别当前架构与 Clean Architecture 的差距
3. 设计从当前架构到整洁架构的重构方案
4. 保留已有架构中的有效实践（Port 接口模式、Composition Root 依赖注入）

## 非目标

- 不改变已有数据库 schema（表结构、索引不变）
- 不改变产品功能和行为
- 不改变技术选型（TypeScript、Hono、better-sqlite3、pi-agent-core、bge-m3）
- 不改变已有的 5 个限界上下文划分

## 分析：Clean Architecture 与 LLM 思维方式的契合度

### 1. LLM 代码生成的思维特征

LLM 生成代码时呈现以下特征：

| 特征 | 描述 |
|------|------|
| **自顶向下分解** | LLM 倾向于先理解"做什么"（意图），再分解为"怎么做"（实现） |
| **接口驱动推理** | LLM 能从 TypeScript 接口签名推理行为契约，无需看实现 |
| **上下文窗口隔离** | LLM 在明确边界内工作时，幻觉更少；跨层引用会增加上下文污染 |
| **测试优先友好** | LLM 擅长为纯函数/无副作用代码生成测试；mock 基础设施时容易出错 |
| **分层抽象对齐** | LLM 的注意力机制天然分层——先关注高层语义，再关注底层细节 |

### 2. Clean Architecture 如何映射到 LLM 思维

| Clean Architecture 层 | LLM 思维映射 | 代码生成顺序 |
|----------------------|-------------|-------------|
| Entities | "这个领域的核心概念是什么？" | 1. 先生成纯数据模型和业务规则 |
| Use Cases | "用户能做什么操作？" | 2. 生成操作编排，定义数据访问接口 |
| Interface Adapters | "外部输入如何转换为内部格式？" | 3. 生成控制器/展示器/DTO |
| Frameworks & Drivers | "用什么技术实现？" | 4. 最后生成具体技术实现 |

### 3. 当前架构的 LLM 不友好点

| 问题 | 当前架构表现 | 对 LLM 的影响 |
|------|-------------|--------------|
| **Domain 直接依赖 Infra** | `domain/otter/_internal/repository.ts` 直接 import `better-sqlite3` | LLM 在修改 domain 逻辑时上下文被 SQL/DB 细节污染 |
| **无 Use Case 分层** | 业务编排逻辑混在 `domain/otter/_internal/adapter.ts` | LLM 无法区分"领域规则"和"应用编排" |
| **Provider owns Port 半措施** | domain 定义 Port 接口但同时实现它 | LLM 难以判断"这段代码是契约还是实现" |
| **跨层依赖增加幻觉风险** | domain -> infra 的直接依赖 | LLM 可能错误引入基础设施类型到业务逻辑中 |

### 4. 结论：UA-2 验证

**用户的直觉是正确的。** Clean Architecture 的同心圆分层与 LLM 的自顶向下代码生成路径高度一致。关键优势在于**依赖反转**——内层完全不知道外层的存在，LLM 在内层工作时上下文窗口天然干净。

## 差距分析：当前架构 vs Clean Architecture

### 层结构映射

| Clean Architecture | 当前架构 | 差距 |
|-------------------|---------|------|
| Entities | `domain/*/model.ts` | 部分对齐——但 model.ts 仅有类型定义，无业务规则方法 |
| Use Cases | `domain/*/port.ts` + `domain/*/_internal/adapter.ts` | **错位**——Port 是接口（偏 use case 定义），adapter 混合了应用编排和数据访问 |
| Interface Adapters | `adapter/`（未实现） | 未实现，无法评估 |
| Frameworks & Drivers | `infra/` | **方向反了**——当前 domain 依赖 infra，Clean Architecture 要求 infra 依赖 domain |

### 关键差距

#### 差距-1：依赖方向反转（Critical）

当前：
```
domain/otter/_internal/repository.ts
  └── import type Database from "better-sqlite3"  // domain 依赖 infra
```

Clean Architecture 要求：
```
entities/usecases 定义 Repository 接口
  └── frameworks/db 实现 Repository 接口  // infra 依赖 domain
```

影响范围：3 个已实现的 domain 模块（otter、memory、conversation）的 `_internal/repository.ts` 和 `_internal/initor.ts` 全部需要重构。

#### 差距-2：Entities 与 Use Cases 分离（Major）

当前 `domain/otter/_internal/adapter.ts` 同时包含：
- 领域规则（如 `getBigOtter()` 找不到时 throw——这是系统不变量）
- 应用编排（如 `create()` 编排 DB 写入 + AgentRegistry 创建 + 失败回滚）

Clean Architecture 要求这两类逻辑分属不同层。

#### 差距-3：Repository 接口归属（Minor→Major）

当前：Repository 是 `_internal/` 的私有实现，不对外暴露。
Clean Architecture：Repository 接口应由 Use Case 层定义，由 Frameworks 层实现。

#### 差距-4：app/ 层定位（未实现，机会窗口）

当前设计：`app/` 包含 orchestration（5 个跨模块事务）+ agent-runtime。
Clean Architecture 映射：orchestration = Use Cases 层的跨模块编排；agent-runtime = Interface Adapters 层。
当前 app/ 尚未实现，重构成本为零。

## 设计方案

### 方案概述：保留限界上下文的整洁架构

保留 DDD 的限界上下文划分作为模块组织维度，同时引入 Clean Architecture 的层依赖规则。

### 目录结构

```
src/
  entities/                          -- 层 1：Entities（纯业务对象 + 规则）
    otter/
      otter.ts                       -- Otter 实体类型 + 业务不变量
      otter-session.ts               -- OtterSession 实体类型
    memory/
      memory-entry.ts                -- MemoryEntry 实体类型
    conversation/
      conversation.ts                -- Conversation 实体类型
      message.ts                     -- Message 实体类型

  usecases/                          -- 层 2：Use Cases（应用编排 + 接口定义）
    otter/
      otter-repository.ts            -- OtterRepository 接口（由 usecases 定义）
      agent-gateway.ts               -- AgentGateway 接口（Agent 生命周期抽象）
      create-otter.ts                -- CreateOtter use case（class + execute()）
      dissolve-otter.ts              -- DissolveOtter use case
      manage-session.ts              -- Session 管理 use cases
    memory/
      memory-repository.ts           -- MemoryRepository 接口
      embedding-gateway.ts           -- EmbeddingGateway 接口
      search-engine.ts               -- RRF 融合 + 权重重排算法（纯函数，无外部依赖）
      search-memory.ts               -- 检索 use case
      store-memory.ts                -- 存储 use case
    conversation/
      conversation-repository.ts     -- ConversationRepository 接口
      send-message.ts                -- 发消息 use case
      manage-tree.ts                 -- 对话树管理 use case
    orchestration/                   -- 跨模块编排（原 app/orchestration）
      dissolve-otter-flow.ts         -- 解散 Otter 全流程
      archive-session-flow.ts        -- 归档 session 全流程
      ...

  interface-adapters/                -- 层 3：Interface Adapters
    http/                            -- HTTP 接口适配（原 adapter/http）
      controllers/
      presenters/
      dto/
    agent-runtime/                   -- Agent 运行时适配（原 app/agent-runtime）
      tools/
      skill-adapter/
      sse-streamer/

  frameworks/                        -- 层 4：Frameworks & Drivers
    db/                              -- 数据库实现
      database.ts                    -- better-sqlite3 连接（原 infra/db）
      schema.ts                      -- DDL
      otter/                         -- 按限界上下文组织（mapper 仅服务于对应 repository）
        sqlite-otter-repository.ts   -- 实现 usecases/otter/otter-repository.ts
        otter-mapper.ts              -- Domain <-> DB row 转换
      memory/
        sqlite-memory-repository.ts
        memory-mapper.ts
      conversation/
        sqlite-conversation-repository.ts
        conversation-mapper.ts
    llm/                             -- LLM 实现（原 infra/llm-gateway）
      pi-ai-gateway.ts
    embedding/                       -- Embedding 实现（原 infra/embedding）
      bge-m3-worker.ts
      embedding-service.ts
    agent/                           -- Agent 框架实现（原 infra/agent-core）
      pi-agent-registry.ts
      agent-handle.ts
    web/                             -- 前端（原 web/）
      react-app/
    config.ts                        -- 配置（原 infra/config）
    logger.ts                        -- 日志（原 infra/logger）

  main.ts                            -- Composition Root（依赖注入装配）
```

### 依赖规则（ESLint 强制）

```
frameworks/  ──→  interface-adapters/  ──→  usecases/  ──→  entities/
     ↑                                                              ↑
     └──────────── 实现接口，不反向引用 ────────────────────────────┘
```

- `entities/` 不依赖任何其他层
- `usecases/` 只依赖 `entities/`
- `interface-adapters/` 只依赖 `usecases/` + `entities/`
- `frameworks/` 只依赖 `interface-adapters/`（实现其接口） + `usecases/`（实现 Repository 接口）+ `entities/`
- `main.ts` 依赖所有层（Composition Root 豁免）

**Cross-cutting 豁免**：`frameworks/logger.ts` 是基础设施级别的通用工具，不携带业务语义。`usecases/` 和 `entities/` 层可以直接 import logger。其他 frameworks 模块（db、llm、embedding、agent）不可被 usecases/entities 直接 import。

**Config 注入规则**：`frameworks/config.ts` 不享有 logger 豁免。config 中包含业务相关参数（如 RRF k=60、权重半衰期 7 天等），这些参数影响业务行为。usecases 需要的配置值应通过 main.ts 构造函数注入，不直接 import frameworks/config.ts。

### Use Case 形状与消费模式

**Use case 形状**：每个 use case 是一个 class，包含构造函数注入和 `execute()` 方法。

```typescript
// usecases/otter/create-otter.ts
export class CreateOtter {
  constructor(
    private readonly repo: OtterRepository,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(params: CreateOtterInput): Promise<Otter> {
    // ...业务编排逻辑
  }
}
```

**依赖注入**：main.ts（Composition Root）负责实例化所有 use case，注入 frameworks 层实现的具体 repository/gateway。

**消费模式**：消费者（interface-adapters/、usecases/orchestration/）直接 import 具体 use case class。模块边界通过目录划分 + ESLint 层依赖规则强制，不需要额外的 facade 层（"目录即边界"）。

### 关键设计决策

| ID | 决策 | 理由 |
|----|------|------|
| D30 | 采用整洁架构 4 层替换 DDD 4 层 | 依赖反转使内层独立于外层，符合 LLM 思维方式（UA-2） |
| D31 | 保留限界上下文作为模块组织维度 | 5 个限界上下文（S1 定义）仍有效，整洁架构不规定模块组织方式 |
| D32 | Repository 接口归属 usecases 层 | usecases 定义数据访问契约，frameworks 实现，实现依赖反转 |
| D33 | 废弃 _internal/ 封装机制 | 重构后 _internal/ 内容全部分配到其他层（repository->frameworks, adapter->usecases, initor->main.ts），_internal/ 不再有内容。层依赖 ESLint 规则已提供跨层封装，不需要额外约束。use case 内部辅助函数直接在同文件内定义 |
| D34 | agent-runtime 从 app 层移到 interface-adapters 层 | Agent 运行时是接口适配器，将外部 Agent 框架适配为内部工具接口 |
| D35 | orchestration 从 app 层移到 usecases/orchestration/ | 跨模块编排是应用层逻辑，归属 use cases 层 |
| D36 | entities 层含类型 + 不变量规则函数 | entities 导出纯函数（如 `archiveReasonToStatus(reason): SessionStatus`）集中管理领域不变量。纯函数不操作实例状态，不是"业务方法"，但能确保不变量规则不被分散到多个 use case 中 |
| D37 | frameworks/db/ 实现 usecases 定义的 Repository 接口 | 依赖反转：实现依赖接口，不是接口依赖实现 |
| D38 | frameworks/db/ 按限界上下文组织 repository + mapper | mapper 仅服务于对应 repository，放同一子目录减少导航成本（如 `frameworks/db/otter/sqlite-otter-repository.ts` + `frameworks/db/otter/otter-mapper.ts`） |
| D39 | logger 作为 cross-cutting concern 豁免层依赖规则 | logger 是基础设施级别的通用工具，不携带业务语义。usecases/entities 可直接 import。其他 frameworks 模块不可被内层直接 import |
| D40 | "目录即边界"--不需要模块级 facade | 消费者直接 import use case class。ESLint 层依赖规则强制方向，目录划分标识模块边界。额外 facade 层增加间接性而无额外价值 |
| D41 | search-engine.ts 归属 usecases/memory/ | RRF 融合 + 权重重排是应用层算法，纯函数无外部依赖，被 search-memory.ts use case 调用 |
| D42 | Greenfield 实现替代迁移 | 现有代码=外层，内层未建，无法从外向内迁移。旧代码移至 `reference/old-src/` 作参考，从内向外重新构建（UA-4 用户指令） |

### 不兼容更新

| 变更 | 影响 |
|------|------|
| 目录结构全量替换 | `src/` 下旧目录全部移除，新建整洁架构 4 层目录 |
| 旧代码归档 | 现有 `src/` 代码移至 `reference/old-src/` 供实现时参考，不参与编译 |

### 变更影响面

#### 后端
- `src/` 目录全量重建（旧代码移至 `reference/old-src/`）
- `tsconfig.json` path aliases 更新
- `eslint.config.mjs` 层依赖规则重写
- `reference/old-src/` 加入 tsconfig exclude + eslint ignores
- 测试目录同步重建

#### 前端
- 无影响（前端尚未实现）

#### 提示词/SOP
- 无影响

### 实现策略（Greenfield）

> 用户指令（UA-4）：现有代码属于整洁架构的外层（frameworks），内层（entities、usecases）尚未存在。无法从外向内"迁移"——只能从内向外重新构建。旧代码移至临时目录作为参考。

**Greenfield 实现**（按整洁架构四层拆分为多个 Issue，从内向外构建）：

**本 Issue（F20260714zjmk）的 development 阶段范围**：Setup（步骤 1-2,6）

| 步骤 | 内容 |
|------|------|
| 1 | 将现有 `src/` 移至 `reference/old-src/`（保留作业务逻辑参考，不参与编译） |
| 2 | 创建新目录结构（entities/、usecases/、interface-adapters/、frameworks/） |
| 6 | 更新 tsconfig paths、ESLint 层依赖规则 |

**后续 Issue**（由用户逐个创建）：

| Issue | 层 | 内容 | 前置 |
|-------|-----|------|------|
| Issue 2 | entities | 3 个上下文的实体类型 + 不变量规则函数（参照旧代码 `domain/*/model.ts` 实现） | 本 Issue |
| Issue 3 | usecases | 3 个上下文的 use case class + Repository/Gateway 接口 + search-engine（参照旧代码 `domain/*/port.ts` + `_internal/adapter.ts` 实现） | Issue 2 |
| Issue 4 | frameworks | db/llm/embedding/agent 实现 Repository/Gateway 接口 + config/logger（参照旧代码 `infra/` + `domain/*/_internal/repository.ts` + `mapper.ts` 实现） | Issue 3 |
| Issue 5 | interface-adapters | HTTP controllers + agent-runtime + main.ts 装配 + 测试重建 | Issue 4 |

每个后续 Issue 创建时引用 Feature 文档编号 `F20260714zjmk`，开发者从 Feature 文档获取完整设计上下文。

## 核心业务行为

> 本次变更是架构重构，不改变任何业务行为。以下行为条目是"重构后必须保持不变"的回归守护。

| ID | 触发条件 | 预期行为 | 追溯 |
|----|---------|---------|------|
| B1 | 创建 Otter 记录后，Agent 创建失败时 | DB 记录应被回滚删除，不残留孤立 Otter 记录 | ← UA-3（保持现有行为） |
| B2 | 查询大獭且系统中不存在大獭时 | 应抛出错误（系统不变量：大獭必须存在） | ← UA-3 |
| B3 | 归档 session 且 reason='restart' 时 | session 状态变为 'restarted'，Agent 上下文被重置 | ← UA-3 |
| B4 | 归档 session 且 reason 不为 'restart' 时 | session 状态变为 'archived'，Agent 上下文被重置 | ← UA-3 |
| B5 | 解散 Otter 时 | Otter 状态变为 'dissolved'，对应 Agent 被销毁 | ← UA-3 |
| B6 | 混合检索记忆时 | FTS5 全文匹配 + vec0 向量检索结果通过 RRF 融合后返回 | ← UA-3 |

## 硬约束

1. 不改变数据库 schema（表名、字段、索引不变）
2. 不改变 `infra/config.ts` 的配置项（可迁移位置，不改内容）
3. 不引入新的第三方依赖
4. 重建后所有测试必须通过（参照旧测试的业务断言重写）
5. ESLint 层依赖规则必须覆盖所有 4 层之间的引用方向
6. `reference/old-src/` 必须加入 tsconfig exclude + eslint ignores，不参与编译

## 设计取舍

| 取舍点 | 正方 | 反方 | 最终选择 |
|--------|------|------|---------|
| Entities 是否含业务方法 | 含方法则更 OOP，实体自带不变量守护 | 纯类型更简单，LLM 生成时不易混淆实体逻辑与 use case 逻辑 | 类型 + 不变量规则函数（D36）。纯函数不操作实例状态，但能集中管理领域规则（如 `archiveReasonToStatus`），避免不变量分散到多个 use case |
| 是否保留 _internal/ 封装 | 已验证有效，ESLint 规则成熟 | 整洁架构本身通过层依赖规则实现封装，_internal/ 是额外约束 | 废弃（D33）。重构后 _internal/ 内容全部分配到其他层，层依赖 ESLint 规则已提供足够封装 |
| use case 文件粒度 | 一个文件一个 use case（如 create-otter.ts） | 一个文件多个 use case（如 otter-usecases.ts） | 单文件单 use case。LLM 生成时文件名即意图，上下文更聚焦 |
| frameworks 层组织方式 | 按技术关注点组织（repositories/、mappers/） | 按限界上下文组织（otter/、memory/） | 按限界上下文组织（D38）。mapper 仅服务于对应 repository，放同一子目录减少导航成本 |
| 模块边界强制方式 | 目录 + ESLint 层依赖规则 | 额外 facade 层聚合 use case | 目录即边界（D40）。ESLint 规则强制方向，facade 增加间接性无额外价值 |
| Use case 形状 | class + execute() | function | class（D-phase 2 共识）。class 天然有类型信息供 LLM 推理，构造函数注入适合 DI |
| Logger 依赖处理 | 定义 LoggerPort 接口由 frameworks 实现 | 直接 import（cross-cutting 豁免） | 豁免（D39）。logger 不携带业务语义，定义接口是过度抽象 |
| 重构方式：迁移 vs Greenfield | 迁移可复用已验证代码，减少重写工作量 | 现有代码=外层，内层未建，无法从外向内迁移 | Greenfield（D42，UA-4 用户指令）。旧代码移至 `reference/old-src/` 作参考，从内向外构建 |

## 关键决策记录

### KDR-1：Use case 形状（class + execute()）

- **决策点**：use case 是 class 还是 function？
- **正方论点（架构师-2）**：class + execute() 更适合 DI，TypeScript class 天然有类型信息供 LLM 推理，构造函数注入模式成熟
- **反方论点**：function 更轻量，不需要实例化
- **最终决策**：class + execute()
- **决策依据**：DI 友好性 > 轻量性。class 的构造函数明确声明依赖，LLM 能从构造函数签名推理 use case 的所有外部依赖
- **参与者**：架构师-1、架构师-2

### KDR-2：废弃 _internal/ 封装（D33 修正）

- **决策点**：重构后是否保留 _internal/ 机制？
- **正方论点（架构师-1 原方案）**：双重保护比单层更安全，ESLint 规则已验证
- **反方论点（架构师-2）**：重构后 _internal/ 内容全部分配到其他层（repository->frameworks, adapter->usecases, initor->main.ts），_internal/ 不再有内容。层依赖 ESLint 规则已提供跨层封装
- **最终决策**：废弃 _internal/
- **决策依据**：_internal/ 在新架构中无实际内容可封装。保留空机制增加认知负担
- **参与者**：架构师-1、架构师-2

### KDR-3：Entities 含不变量规则函数（D36 修正）

- **决策点**：entities 层是否包含业务逻辑？
- **正方论点（架构师-2）**：纯函数（如 `archiveReasonToStatus`）能集中管理领域不变量，避免规则分散到多个 use case。纯函数不操作实例状态，不是"业务方法"
- **反方论点（架构师-1 原方案）**：纯类型更简单，LLM 生成时不易混淆
- **最终决策**：类型 + 不变量规则函数
- **决策依据**：不变量集中管理 > 极简主义。如果 `archiveReasonToStatus` 规则分散到多个 use case，修改时可能遗漏某处
- **参与者**：架构师-1、架构师-2

### KDR-4：frameworks/db 按限界上下文组织

- **决策点**：frameworks/db 下 repository + mapper 按技术关注点还是限界上下文组织？
- **正方论点（架构师-1 原方案）**：frameworks 层是技术实现，按技术关注点组织（repositories/、mappers/）
- **反方论点（架构师-2）**：mapper 仅服务于对应 repository，分离到不同目录增加导航成本。按上下文组织（otter/、memory/）更内聚
- **最终决策**：按限界上下文组织（D38）
- **决策依据**：内聚性 > 技术分类。同一上下文的 repository + mapper 总是一起修改
- **参与者**：架构师-1、架构师-2

### KDR-5：Logger cross-cutting 豁免

- **决策点**：usecases/entities 是否可以 import frameworks/logger？
- **正方论点（架构师-2）**：logger 是基础设施级别的通用工具，不携带业务语义。定义 LoggerPort 接口是过度抽象
- **反方论点**：严格依赖规则应无例外
- **最终决策**：logger 豁免（D39），其他 frameworks 模块不可被内层直接 import
- **决策依据**：logger 类似 Node.js 内置 console，是通用工具而非业务依赖。豁免范围严格限制为 logger.ts 一个文件
- **参与者**：架构师-1、架构师-2

### KDR-6：Greenfield 实现替代迁移（用户指令）

- **决策点**：重构方式是"迁移旧代码"还是"从头实现"？
- **正方论点（用户）**：现有代码属于整洁架构的外层（frameworks），内层（entities、usecases）尚未存在。无法从外向内迁移--只能从内向外构建。旧代码移至临时目录作参考
- **反方论点**：迁移可以复用已验证的代码，减少重写工作量
- **最终决策**：Greenfield 实现（用户指令 UA-4，不可推翻）
- **决策依据**：迁移路径在逻辑上不可行--你不能从外层"提取"内层，因为内层还不存在。现有代码的 adapter.ts 混合了领域规则和应用编排，拆分本质上是重写而非移动。Greenfield 方式更清晰：从内向外构建，旧代码作为业务逻辑参考
- **参与者**：用户、架构师-1、架构师-2

## 验证

### 本 Issue（Setup）验证
- [x] `reference/old-src/` 存在且包含旧代码
- [x] `src/` 下有 4 个空目录（entities/、usecases/、interface-adapters/、frameworks/）
- [x] `tsconfig.json` path aliases 更新为新路径
- [x] `eslint.config.mjs` 层依赖规则已写入
- [x] `tsc --noEmit` 通过（空目录不报错）
- [x] `reference/old-src/` 在 tsconfig exclude + eslint ignores 中

### 完整 Feature 验证（所有 Issue 完成后）
- [ ] `tsc --noEmit` 通过
- [ ] `eslint src/` 无违规
- [ ] `vitest run` 全部通过
- [ ] 层依赖方向验证：无 entities/ → 外层引用，无 usecases/ → interface-adapters/ 或 frameworks/ 引用
- [ ] 行为回归：B1-B6 全部通过

## 相关链接

- [The Clean Architecture (Uncle Bob, 2012)](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- F20260709p4q7（S3 数据模型设计，D29 四层架构决策）
- F20260709m2n8（S2 能力模块架构）
- F20260709x7k3（S1 产品形态定义）
- F20260713o4t8（Otter 领域模块）
- F20260713i5k2（Infra LLM/Agent/Embedding）
- F20260713m5q3（Memory 领域模块）
- F20260713e8n4（消息流式模型 + 对话领域模块）
