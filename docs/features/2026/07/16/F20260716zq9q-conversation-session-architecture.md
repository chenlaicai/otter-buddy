---
id: F20260716zq9q
title: conversation-session-architecture
from_ids: [F20260713c7p2, F20260713o4t8, F20260713m5q3, F20260709p4q7]
tags: [architecture, analysis, conversation, session, pi-agent, memory, context-management]
modules: [architecture]
doc_kind: analysis
status: locked
created_at: 2026-07-16
---

# F20260716zq9q 对话与 Session 架构关系分析

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。
>
> 本文档分析 otter 系统中"对话"（Conversation）与"Pi Session"之间的架构关系，识别当前设计的断点，提出改进方案。经两位架构师交叉审视后锁定。

## 背景 [required]

在 otter 系统中，**对话**是用户交互场景，会长久存在使用。**Pi Session** 是 LLM 的上下文窗口，有 token 上限。两者生命周期不同：对话可能跨越多个 Session，而每个 Session 只覆盖对话的一个片段。

当前架构存在以下断点：
1. 对话与 Session 之间没有直接绑定关系（通过 Otter 实体间接关联）
2. Session 归档时，工作记忆转为历史记忆，但没有显式的上下文交接机制
3. 对话的连续性依赖 LLM 从记忆系统自行检索，而非结构化的上下文传递

### 约束输入

- F20260713c7p2: 对话领域模型（Conversation, Message, Turn, treePath）
- F20260713o4t8: Otter 领域模型（OtterSession, previousSessionId 链）
- F20260713m5q3: 记忆系统（FTS5 + vec0 + RRF + 权重重排）
- F20260709p4q7: 数据模型设计（S3 DDL）
- Pi 能力分析: Session 管理、Compaction、冷启动模型

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前 issue | 对话 是用户交互场景，因此对话 是会长久存在使用的 | 持续性：长久存在使用 | 对话生命周期 >> Session 生命周期，一个对话可能跨越多个 Session |
| UA-2 | 当前 issue | 一个对话做这么多事情，只会导致session频繁压缩 | 问题：频繁压缩；原因：一个对话做太多事 | 需要对话级别的 Session 管理策略，而非仅 Otter 级别 |
| UA-3 | 当前 issue | session chain。主动交接 | 策略：chain；方式：主动交接 | Session 链式管理 + 主动上下文交接（而非被动压缩） |
| UA-4 | 当前 issue | 记忆系统是否支持 历史语义总结？（这一点我不确定，记忆系统（本质是搜索引擎）是否只能 关键字召回？还是还能自行总结？） | 疑问：语义总结 vs 关键字召回 | 需要澄清记忆系统的能力边界 |
| UA-5 | 当前 issue | 大獭是从始至终一直在的，而其他的小獭是按需进场/退场的 | 持续性：大獭始终在；临时性：小獭按需进出 | 架构设计必须区分大獭和小獭的 Session 策略 |

## 分析 [required]

### 1. 当前架构的断点

#### 1.1 对话与 Session 的间接关联

当前数据模型中，对话和 Session 的关联路径是：

```
Conversation --[conversation_otters]--> Otter --[otter_sessions]--> OtterSession --[agent_sessions]--> Pi Session
```

这意味着：
- 一个对话关联到多个 Otter（大獭 + 参与的小獭）
- 每个 Otter 有多个 Session（链式）
- 但对话本身不知道"当前活跃在哪个 Session 中"

**问题**：当对话跨越多个 Session 时，无法从对话维度管理 Session 生命周期。

#### 1.2 缺乏显式的上下文交接

当前 Session 归档流程（`ManageSession.archiveSession()`）：
1. 归档 Otter Session 记录（status -> archived/restarted）
2. 工作记忆转为历史记忆（`memoryLayer.updateLayer`）
3. 调用 `agentGateway.reset()` 创建新 Pi Session

**问题**：第 2 步只是切换了记忆的 layer 标签，没有生成结构化的上下文摘要。新 Session 启动时，LLM 需要自行从记忆系统检索历史上下文，这依赖于检索质量，且消耗 token。

#### 1.3 记忆系统的能力边界

**记忆系统能做的**：
- FTS5 关键词检索（BM25 排序，trigram 分词，CJK 友好）
- vec0 语义检索（bge-m3 embedding，KNN 搜索）
- RRF 融合 + 权重重排（time_decay, frequency, task_relevance, user_flag）

**记忆系统不能做的**：
- **不能自行总结**：记忆系统是搜索引擎，不是 LLM。它只能检索已有的记忆条目，不能生成新的摘要文本。
- **不能跨条目推理**：每次检索返回独立的条目列表，不进行跨条目的语义综合。

**语义总结需要 LLM**：如果要实现"历史语义总结"，需要由 LLM（Pi Agent）读取检索结果后生成摘要。这是 Agent 的能力，不是记忆系统的能力。

### 2. 改进方案：对话级 Session 管理

#### 2.1 核心思路：对话-Session 绑定 + 主动交接

**方案概述**：
1. 在 Conversation 实体上增加"当前活跃 Session"指针
2. 定义 Session 交接触发条件（token 阈值 / 时间阈值 / 用户指令）
3. 交接时由 LLM 生成结构化摘要，注入新 Session 的上下文
4. 记忆系统作为辅助检索，而非主要上下文来源

#### 2.2 对话-Session 绑定

**新增概念**：`ConversationSessionBinding`

```
Conversation --[active_session]--> OtterSession
```

- 一个对话在同一时刻只有一个活跃 Session（大獭的）
- 当 Session 交接时，绑定指针更新
- 小獭的 Session 不与对话绑定（小獭是按需进场/退场）

**为什么只绑定大獭的 Session**：
- 大獭从始至终在对话中，是对话的"主持人"
- 小獭是临时参与者，它们的 Session 是独立的生命周期
- 对话的上下文连续性由大獭维护

#### 2.3 Session 交接流程

**触发条件**（任一满足）：
- Token 使用量接近上下文窗口上限（如 80%）
- 对话中累积了足够多的消息（如 100 条）
- 用户主动指令（"开始新的 Session"）

**交接步骤**：
1. **生成摘要**：LLM 读取当前 Session 的关键信息，生成结构化摘要
2. **归档当前 Session**：调用 `archiveSession()`，工作记忆转历史
3. **创建新 Session**：调用 `createSession()`
4. **注入上下文**：将摘要作为 system-reminder 注入新 Session
5. **更新绑定**：Conversation 指向新 Session

**摘要内容结构**：
```typescript
interface SessionHandoffSummary {
  conversationId: string;
  sessionSequence: number;        // 第几个 Session
  keyDecisions: string[];         // 关键决策
  pendingTasks: string[];         // 待完成任务
  activeContext: string;          // 当前工作上下文
  participantStatus: Record<string, string>;  // 参与者状态
}
```

#### 2.4 大獭 vs 小獭的 Session 策略

| | 大獭 | 小獭 |
|---|------|------|
| Session 生命周期 | 与对话同步（对话存在期间持续活跃） | 任务驱动（创建 -> 执行 -> 解散） |
| Session 交接 | 主动交接（token 阈值触发） | 不交接（任务完成即归档） |
| 上下文连续性 | 通过摘要链维护 | 通过工具返回值传递给大獭 |
| 记忆系统使用 | 检索历史上下文 + 存储关键信息 | 检索相关记忆 + 存储工作成果 |
| 对话绑定 | 绑定（Conversation.activeSessionId） | 不绑定 |

**小獭退场时的上下文传递**：
- 小獭完成任务后，通过工具返回值将结果传回大獭
- 大獭将结果存入记忆系统（key_fact / linked_resource）
- 小獭的 Session 归档，但记忆条目保留（layer=historical）

### 3. 记忆系统在上下文管理中的角色

#### 3.1 记忆系统 vs Session 摘要

| | Session 摘要 | 记忆系统检索 |
|---|------------|------------|
| 生成方式 | LLM 主动生成 | 检索引擎被动召回 |
| 内容 | 结构化摘要（决策、任务、上下文） | 原始记忆条目（消息、事实、资源） |
| 粒度 | 粗（coarse） | 细（fine）或粗（coarse） |
| 用途 | Session 交接时的上下文注入 | 按需检索历史信息 |
| token 消耗 | 低（摘要简短） | 高（多条检索结果） |

**两者互补**：
- Session 摘要提供"当前状态的快照"，用于 Session 交接
- 记忆系统提供"历史细节的检索"，用于回答具体问题

#### 3.2 记忆系统能否支持"语义总结"？

**当前能力**：不支持。

记忆系统的检索流程是：
1. 用户查询 -> FTS5 + vec0 检索 -> RRF 融合 -> 权重重排 -> 返回 top-N 条目

这个流程返回的是**原始条目列表**，不进行任何语义综合或总结。

**如果要支持语义总结**，有两种路径：

**路径 A：Agent 侧总结（推荐）**
- Agent 检索记忆后，自行读取条目内容，生成总结
- 优点：利用 LLM 的语义理解能力，总结质量高
- 缺点：消耗 token，需要 Agent 主动调用

**路径 B：记忆系统增加摘要索引**
- 在 `memory_entries` 中增加 `contentType: 'conversation_summary'` 的条目
- 由 app/orchestration 在对话完成/归档时生成摘要并存储
- 检索时可直接命中摘要条目，无需 Agent 再次总结
- 优点：摘要可复用，减少 Agent token 消耗
- 缺点：摘要可能过时，需要维护更新机制

**建议**：采用路径 B 作为主要方案，路径 A 作为补充。

### 4. 实现路径

#### 4.1 短期改进（不改变数据模型）

1. **在 System Prompt 中注入 Session 链信息**：
   - 当前 Session 是第几个
   - 前一个 Session 的摘要（如果有）
   - 对话的关键事实列表

2. **优化记忆检索策略**：
   - Session 交接时，将关键信息存入 `key_info` 层（持久化）
   - 新 Session 启动时，优先检索 `key_info` 层的记忆

3. **利用已有的 Session 链**：
   - `previousSessionId` 已经形成链式结构
   - `archiveSession()` 已支持 `summary` 参数
   - 只需要在交接时生成高质量摘要

#### 4.2 中期改进（数据模型扩展）

1. **Conversation 增加 activeSessionId 字段**：
   - 直接绑定当前活跃的大獭 Session
   - 支持从对话维度查询 Session 状态

2. **Session 增加 handoffSummary 字段**：
   - 存储交接时生成的结构化摘要
   - 新 Session 启动时读取前一个 Session 的摘要

3. **记忆系统增加 conversation_summary 索引**：
   - 对话完成/归档时自动生成摘要条目
   - 摘要条目存入 `memory_entries`，contentType='conversation_summary'
   - 检索时可命中摘要，提供粗粒度上下文

#### 4.3 长期改进（完整 Session 管理）

1. **自动 Session 交接**：
   - 监控 token 使用量，接近阈值时自动触发交接
   - 交接过程对用户透明

2. **对话树与 Session 映射**：
   - 对话树的每个节点可以有独立的 Session 策略
   - 子对话可以"继承"父对话的 Session 上下文

3. **跨对话记忆整合**：
   - 相关对话的记忆条目可以跨对话检索
   - 通过 treePath 计算 task_relevance，提升检索精度

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 对话绑定大獭 Session | 只绑定大獭 | 绑定所有参与 Otter 的 Session | 大獭是对话主持人，小獭是临时参与者 |
| Session 交接触发 | Token 阈值 + 用户指令 | 仅用户指令 | 自动交接减少用户负担，但保留手动控制 |
| 摘要生成方式 | LLM 生成 | 记忆系统自动总结 | 记忆系统是搜索引擎，不具备总结能力 |
| 摘要存储位置 | Session handoffSummary + memory_entries | 仅 Session | 双重存储：Session 用于交接，memory 用于检索 |
| 记忆系统角色 | 检索辅助 | 主要上下文来源 | 检索结果 token 消耗高，摘要更高效 |

## 关键设计决策

### D1: 记忆系统能力边界

**决策**：记忆系统是搜索引擎，不支持语义总结。语义总结由 LLM（Agent）完成。

**理由**：
1. 记忆系统的核心流程是"查询 -> 检索 -> 排序 -> 返回"，不包含"理解 -> 综合 -> 生成"
2. vec0 语义检索基于 embedding 距离，返回的是"相似的条目"，不是"综合的摘要"
3. 语义总结需要 LLM 的 generative 能力，这是 Pi Agent 的职责

**影响**：
- 记忆系统提供检索结果，Agent 负责理解和总结
- Session 交接时，Agent 读取记忆条目后生成摘要
- 摘要存入 memory_entries，供后续检索

### D2: 对话-Session 绑定范围

**决策**：对话只绑定大獭的 Session，不绑定小獭。

**理由**：
1. 大獭从始至终在对话中，是对话的连续性保障
2. 小獭是按需创建/销毁的临时 Agent，生命周期与对话不同步
3. 小獭的上下文通过工具返回值传递给大獭，不需要与对话绑定

### D3: Session 交接的上下文传递

**决策**：采用"摘要注入"而非"全量检索"作为新 Session 的上下文来源。

**理由**：
1. 全量检索消耗大量 token，且检索结果可能不完整
2. 摘要是 LLM 对当前状态的结构化理解，信息密度高
3. 摘要 + 按需检索记忆 = 低 token 消耗 + 高信息覆盖率

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-CS-1 | 当对话跨越多个 Session 时 | 每个 Session 交接时生成结构化摘要，注入新 Session 上下文 | ← UA-1, UA-3 |
| B-CS-2 | 当 Session token 使用量接近上限时 | 自动触发 Session 交接（生成摘要 -> 归档 -> 创建新 Session -> 注入摘要） | ← UA-2 |
| B-CS-3 | 当新 Session 启动时 | 读取前一个 Session 的摘要，作为 system-reminder 注入 | ← UA-3 |
| B-CS-4 | 当小獭完成任务退场时 | 通过工具返回值将结果传递给大獭，大獭存入记忆系统 | ← UA-5 |
| B-CS-5 | 当需要查询历史上下文时 | Agent 调用记忆系统检索，而非依赖 Session 内的历史消息 | ← UA-4 |
| B-CS-6 | 当对话归档时 | 生成对话级摘要存入 memory_entries（contentType='conversation_summary'） | ← UA-1 |
| B-CS-7 | 当小獭进入对话时 | 大獭将当前对话的关键上下文（来自 Session 摘要或记忆系统）通过工具参数传递给小獭，小獭不直接访问对话历史 | ← UA-5 |
| B-CS-8 | 当对话的 activeSessionId 指向一个非活跃状态的 Session 时 | 自动触发 Session 交接，从记忆系统检索最近的 key_info 层条目作为新 Session 的初始上下文 | ← UA-1, UA-3 |

## 偏差记录 [required]

### D-ARCH-1: 对话与 Session 的绑定方式

**偏差对象**：当前数据模型（F20260709p4q7）

| 项目 | 当前设计 | 本文档建议 |
|------|---------|-----------|
| 对话-Session 关联 | 通过 Otter 间接关联（conversation_otters -> otter_sessions） | 对话直接绑定大獭的活跃 Session（activeSessionId） |

**依据**：
1. 间接关联无法从对话维度管理 Session 生命周期
2. 对话的连续性由大獭维护，应直接绑定大獭 Session
3. 小獭是临时参与者，不与对话绑定

### D-ARCH-2: 记忆系统的能力定位

**偏差对象**：用户对记忆系统的预期（UA-4）

| 项目 | 用户预期 | 实际能力 |
|------|---------|---------|
| 语义总结 | 记忆系统可能支持历史语义总结 | 记忆系统是搜索引擎，仅支持检索，不支持总结 |

**依据**：
1. 记忆系统的核心流程是 query -> retrieve -> rank -> return，不包含 generate
2. vec0 语义检索基于 embedding 距离，返回相似条目，不进行语义综合
3. 语义总结需要 LLM 的 generative 能力，属于 Agent 职责

## 硬约束 [required]

- 记忆系统不进行语义总结，总结由 LLM（Agent）完成
- 对话只绑定大獭的 Session，不绑定小獭
- Session 交接必须生成结构化摘要，不得依赖全量检索
- 小獭退场时通过工具返回值传递上下文，不直接修改对话状态
- 摘要存储双重化：Session handoffSummary（交接用）+ memory_entries（检索用）
- Session 交接必须是原子的——要么全部成功，要么回滚到交接前状态
- 摘要生成失败时，降级为从记忆系统检索 key_info 层条目作为临时上下文
- 小獭存入记忆系统的条目必须包含 conversationId，支持按对话维度检索
- Session 交接优先于 Pi Compaction，保留结构化信息
- 摘要不仅在对话归档时生成，也在 Session 交接时增量更新

## 关联 [required]

- **对话领域模块**：[F20260713c7p2](./F20260713c7p2-domain-conversation.md)
- **Otter 领域模块**：[F20260713o4t8](./F20260713o4t8-domain-otter.md)
- **记忆领域模块**：[F20260713m5q3](./F20260713m5q3-domain-memory.md)
- **数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **Pi 能力分析**：[pi-capability-analysis](../../research/pi-capability-analysis.md)

## 实现记录

### 已实现（中期改进路径）

| 变更 | 文件 | 说明 |
|------|------|------|
| `SessionHandoffSummary` 类型 | `src/entities/otter/otter-session.ts` | 交接摘要结构化类型（B-CS-1） |
| `OtterSession.handoffSummary` 字段 | `src/entities/otter/otter-session.ts` | 新 Session 继承前序 Session 的交接摘要（B-CS-3） |
| `Conversation.activeSessionId` 字段 | `src/entities/conversation/conversation.ts` | 对话直接绑定大獭的活跃 Session（D-ARCH-1） |
| Schema: `conversations.active_session_id` | `src/frameworks/db/schema.ts` | FK -> otter_sessions(id) |
| Schema: `otter_sessions.handoff_summary` | `src/frameworks/db/schema.ts` | JSON 存储 SessionHandoffSummary |
| `ConversationRepository.updateActiveSessionId` | `src/usecases/conversation/conversation-repository.ts` | 更新对话的 Session 绑定 |
| `OtterRepository.setHandoffSummary` | `src/usecases/otter/otter-repository.ts` | 存储交接摘要 |
| `ConversationBindingGateway` | `src/usecases/otter/manage-session.ts` | 对话绑定更新 Gateway 接口 |
| `ManageSession.handoffSession()` | `src/usecases/otter/manage-session.ts` | Session 交接核心流程（B-CS-1, B-CS-2, B-CS-3） |
| `AgentInvoker.buildDynamicContext` | `src/interface-adapters/agent-runtime/agent-invoker.ts` | 读取 handoffSummary 注入上下文（B-CS-3） |
| SQLite 实现 | `src/frameworks/db/otter/sqlite-otter-repository.ts`, `conversation/sqlite-conversation-repository.ts` | Repository 实现 |
| Mapper 更新 | `src/frameworks/db/otter/otter-mapper.ts`, `conversation/conversation-mapper.ts` | Row <-> Entity 映射 |
| 单元测试 | `tests/usecases/manage-session.test.ts` | 8 个测试覆盖 createSession/handoffSession/archiveSession |

### 未实现（需后续 feature）

| 项目 | 原因 |
|------|------|
| Token 阈值自动触发（B-CS-2） | 需要 Pi harness 层的 token 监控基础设施 |
| 对话归档时自动生成 conversation_summary（B-CS-6） | 需要 LLM 调用能力，属于 orchestration 层 |
| 小獭上下文传递的具体工具协议（B-CS-4, B-CS-7） | 需要工具系统设计 |
| 完整的事务原子性保障 | 当前实现依赖 DB 事务，但跨 Gateway 调用非原子 |
| 摘要生成失败降级策略 | 需要 LLM 调用失败的错误处理设计 |
