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
> 本文档分析 otter 系统中"对话"（Conversation）与"Pi Session"之间的架构关系，聚焦于**工作记忆的交接机制**设计。

## 背景 [required]

在 otter 系统中，**对话**是用户交互场景，会长久存在使用。**Pi Session** 是 LLM 的上下文窗口，有 token 上限。两者生命周期不同：对话可能跨越多个 Session，而每个 Session 只覆盖对话的一个片段。

### 系统分层架构

otter 系统已经是分层架构：

| 层 | 对应 | 说明 |
|---|------|------|
| **工作记忆** | Pi Session（上下文窗口） | 当前活跃的、有 token 上限 |
| **历史记忆** | 记忆系统（持久化+检索） | 所有消息都会持久化，Agent 按需召回 |

**本次讨论的核心**：一个 otter 对话必然跨越多个 Pi Session，**工作记忆如何在 Session 之间交接？**

### 约束输入

- F20260713c7p2: 对话领域模型（Conversation, Message, Turn, treePath）
- F20260713o4t8: Otter 领域模型（OtterSession, previousSessionId 链）
- F20260713m5q3: 记忆系统（FTS5 + vec0 + RRF + 权重重排）
- F20260709p4q7: 数据模型设计（S3 DDL）
- Pi 能力分析: Session 管理、Compaction、冷启动模型

### 数据模型边界

**核心原则**：Session 是 Otter 的私有概念，属于 Otter 数据模型边界内，对话不直接关联 Session。

当前关联链路：
```
Conversation --[conversation_otters]--> Otter --[otter_sessions]--> OtterSession --[agent_sessions]--> Pi Session
```

这个边界划分是正确的，不需要改变。

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前 issue | 对话 是用户交互场景，因此对话 是会长久存在使用的 | 持续性：长久存在使用 | 对话生命周期 >> Session 生命周期，一个对话可能跨越多个 Session |
| UA-2 | 当前 issue | 一个对话做这么多事情，只会导致session频繁压缩 | 问题：频繁压缩；原因：一个对话做太多事 | 需要主动交接机制，而非被动压缩 |
| UA-3 | 当前 issue | session chain。主动交接 | 策略：chain；方式：主动交接 | Session 链式管理 + 主动上下文交接（而非被动压缩） |
| UA-4 | 当前 issue | 记忆系统是否支持 历史语义总结？（这一点我不确定，记忆系统（本质是搜索引擎）是否只能 关键字召回？还是还能自行总结？） | 疑问：语义总结 vs 关键字召回 | 需要澄清记忆系统的能力边界 |
| UA-5 | 当前 issue | 大獭是从始至终一直在的，而其他的小獭是按需进场/退场的 | 持续性：大獭始终在；临时性：小獭按需进出 | 架构设计必须区分大獭和小獭的 Session 策略 |
| UA-6 | 校准消息 | session就是作为otter底层agent私有信息，属于otter数据模型边界内 | 边界：Otter 私有；归属：Otter 数据模型 | Session 不应直接关联到 Conversation，保持现有间接关联链路 |
| UA-7 | 校准消息 | 对话不直接关联session，数据模型的边界划分清晰 | 边界清晰：不直接关联 | 维持现有数据模型边界，不引入 Conversation.activeSessionId |

## 分析 [required]

### 1. 当前架构的断点

#### 1.1 缺乏显式的上下文交接

当前 Session 归档流程（`ManageSession.archiveSession()`）：
1. 归档 Otter Session 记录（status -> archived/restarted）
2. 工作记忆转为历史记忆（`memoryLayer.updateLayer`）
3. 调用 `agentGateway.reset()` 创建新 Pi Session

**问题**：第 2 步只是切换了记忆的 layer 标签，没有生成结构化的上下文摘要。新 Session 启动时，LLM 需要自行从记忆系统检索历史上下文，这依赖于检索质量，且消耗 token。

#### 1.2 记忆系统的能力边界

**记忆系统能做的**：
- FTS5 关键词检索（BM25 排序，trigram 分词，CJK 友好）
- vec0 语义检索（bge-m3 embedding，KNN 搜索）
- RRF 融合 + 权重重排（time_decay, frequency, task_relevance, user_flag）

**记忆系统不能做的**：
- **不能自行总结**：记忆系统是搜索引擎，不是 LLM。它只能检索已有的记忆条目，不能生成新的摘要文本。
- **不能跨条目推理**：每次检索返回独立的条目列表，不进行跨条目的语义综合。

**语义总结需要 LLM**：如果要实现"历史语义总结"，需要由 LLM（Pi Agent）读取检索结果后生成摘要。这是 Agent 的能力，不是记忆系统的能力。

### 2. 两种交接方案对比

#### 方案 A：旧 Session 生成交接摘要（推荐）

**流程**：
```
旧 Session (active)
  → LLM 生成结构化摘要 (一次 invocation)
  → 存入 OtterSession.handoffSummary
  → 归档旧 Session
  → 创建新 Session
  → 新 Session 读取旧 Session.handoffSummary 作为初始上下文
```

**优点**：
1. **上下文完整**：旧 Session 的 LLM 正在"现场"，对当前工作状态有完整理解，生成的摘要质量高
2. **结构化可控**：摘要格式可定义（keyDecisions, pendingTasks, activeContext），新 Session 可直接解析使用
3. **token 高效**：新 Session 只需注入摘要（几百 token），无需检索大量历史消息
4. **已有基础**：`OtterSession.summary` 字段已存在，`archiveSession` 已支持 `summary` 参数

**缺点**：
1. **额外 token 消耗**：生成摘要需要一次 LLM invocation，消耗 token
2. **延迟**：交接过程多了一步摘要生成，增加延迟
3. **摘要质量依赖 LLM**：如果 LLM 能力弱或上下文已接近上限，摘要可能不完整

**可行性验证**：结构化摘要只需 500-1,100 token 输出，阈值 ctxMax*0.7 留出 30% buffer，完全可行。

#### 方案 B：新 Session 自行总结旧 Session

**流程**：
```
旧 Session (active)
  → 直接归档（不生成摘要）
  → 创建新 Session
  → 新 Session 启动后，通过记忆系统检索旧 Session 相关信息
  → 新 Session 的 LLM 自行总结
```

**优点**：
1. **无额外 invocation**：旧 Session 归档时不需要额外的 LLM 调用
2. **归档更快**：交接过程更简单，延迟低

**缺点**：
1. **检索依赖记忆系统**：新 Session 需要通过记忆系统检索旧 Session 的历史，但记忆系统返回的是**原始条目列表**，不是结构化摘要
2. **token 消耗高**：检索结果可能很多条，每条都需要 token，且 LLM 还需要额外 token 来总结
3. **信息丢失风险**：如果关键信息没有被记忆系统捕获（例如临时讨论、上下文推理），新 Session 可能无法完整恢复状态
4. **冷启动问题**：新 Session 刚启动时没有上下文，需要先检索再总结，第一次响应会很慢
5. **总结质量不可控**：新 Session 的 LLM 对旧 Session 的理解是"二手的"，可能遗漏关键上下文

#### 对比总结

| 维度 | 方案 A（旧 Session 生成摘要） | 方案 B（新 Session 自行总结） |
|------|------------------------------|------------------------------|
| **交接时机** | 旧 Session **结束前** | 新 Session **启动后** |
| **信息来源** | 旧 Session 的 LLM（现场） | 记忆系统（历史） |
| **信息质量** | 高（正在"工作"的 LLM） | 中（从历史条目重建） |
| **token 消耗** | 低（摘要 500-1,100 token） | 高（检索结果+总结） |
| **冷启动** | 快（摘要直接可用） | 慢（需检索+总结） |
| **信息完整性** | 高（LLM 主动提取） | 中（依赖记忆系统覆盖） |

#### 业界参考

| 范式 | 代表 | 核心思想 | 与 otter 的关系 |
|------|------|---------|----------------|
| **Compaction** | Pi Session 压缩 | 在 Session 内部压缩历史 | 当前方案，被动压缩，质量不可控 |
| **Handoff** | OpenAI Agents SDK | 旧 Agent 生成结构化摘要传给新 Agent | 方案 A 的理论基础 |
| **Persistence** | MemGPT, LangGraph | 状态持久化，Session 只是视图 | otter 已有记忆系统，聚焦工作记忆交接 |

### 3. 设计决策

#### D1: 采用方案 A（旧 Session 生成交接摘要）

**决策**：采用方案 A，旧 Session 在 invoke 开始时检测到 token 超阈值后，主动生成结构化摘要，传递给新 Session。

**理由**：
1. **主动交接**符合用户意图（UA-3）："session chain。主动交接"
2. **信息完整性优先**：旧 Session 的 LLM 正在"现场"，对当前工作状态有完整理解，生成的摘要质量最高
3. **可行性已验证**：结构化摘要只需 500-1,100 token 输出，阈值 ctxMax*0.7 留出 30% buffer，完全可行
4. **invoke 前检查**：在 invoke 开始时触发（主动预防），而非 invoke 完成后（被动反应），确保每次 invoke 都在"健康" session 中进行
5. **token 效率高**：比方案 B 的"检索 + 总结"更省
6. **已有基础设施**：`OtterSession.summary` 已存在，只需定义结构化格式
7. **符合业界实践**：OpenAI Agents SDK 的 Handoff 模式采用类似思路

**降级策略**：如果旧 Session 生成摘要失败（网络错误、token 超限），则降级为方案 B，新 Session 从记忆系统检索 key_info 层条目。

#### D2: 记忆系统能力边界

**决策**：记忆系统是搜索引擎，不支持语义总结。语义总结由 LLM（Agent）完成。

**理由**：
1. 记忆系统的核心流程是"查询 -> 检索 -> 排序 -> 返回"，不包含"理解 -> 综合 -> 生成"
2. vec0 语义检索基于 embedding 距离，返回的是"相似的条目"，不是"综合的摘要"
3. 语义总结需要 LLM 的 generative 能力，这是 Pi Agent 的职责

#### D3: 维持现有数据模型边界

**决策**：Session 是 Otter 的私有概念，不引入 Conversation.activeSessionId 直接绑定。

**理由**：
1. 用户明确指出（UA-6, UA-7）：Session 属于 Otter 数据模型边界内，对话不应直接关联 Session
2. 现有关联链路（Conversation -> Otter -> OtterSession）已经清晰
3. 对话的连续性通过大獭维护，而非对话直接管理 Session

### 4. 大獭 vs 小獭的 Session 策略

| | 大獭 | 小獭 |
|---|------|------|
| Session 生命周期 | 与对话同步（对话存在期间持续活跃） | 任务驱动（创建 -> 执行 -> 解散） |
| Session 交接 | 主动交接（token 阈值触发） | 不交接（任务完成即归档） |
| 上下文连续性 | 通过摘要链维护 | 通过工具返回值传递给大獭 |
| 记忆系统使用 | 检索历史上下文 + 存储关键信息 | 检索相关记忆 + 存储工作成果 |

**小獭退场时的上下文传递**：
- 小獭完成任务后，通过工具返回值将结果传回大獭
- 大獭将结果存入记忆系统（key_fact / linked_resource）
- 小獭的 Session 归档，但记忆条目保留（layer=historical）

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-CS-1 | 当 invoke 开始时 token 使用量（`input + output` 之和）>= ctxMax * 0.7 时 | 旧 Session 主动生成结构化摘要（500-1,100 token），存入 OtterSession.handoffSummary | ← UA-2, UA-3 |
| B-CS-2 | 当旧 Session 生成摘要后 | 归档旧 Session，创建新 Session，新 Session 读取摘要作为初始上下文 | ← UA-3 |
| B-CS-3 | 当新 Session 启动时 | 读取前一个 Session 的 handoffSummary，作为 system-reminder 注入 | ← UA-3 |
| B-CS-4 | 当小獭完成任务退场时 | 通过工具返回值将结果传递给大獭，大獭存入记忆系统 | ← UA-5 |
| B-CS-5 | 当需要查询历史上下文时 | Agent 调用记忆系统检索，而非依赖 Session 内的历史消息 | ← UA-4 |
| B-CS-6 | 当小獭进入对话时 | 大獭将当前对话的关键上下文（来自 Session 摘要或记忆系统）通过工具参数传递给小獭 | ← UA-5 |
| B-CS-7 | 当摘要生成失败时 | 降级为新 Session 从记忆系统检索 key_info 层条目作为临时上下文 | ← UA-3 |

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 交接方式 | 旧 Session 生成摘要（方案 A） | 新 Session 自行总结（方案 B） | 旧 Session 有"现场理解"，信息质量最高；结构化摘要仅需 500-1,100 token，ctxMax*0.7 留出 30% buffer 可行 |
| 摘要生成者 | 旧 Session | 新 Session | 旧 Session 正在"现场"，理解最完整；新 Session 只有"二手理解" |
| 触发时机 | invoke 开始前（主动预防） | invoke 完成后（被动反应） | invoke 前检查确保每次 invoke 都在"健康" session 中进行，保护当前轮 |
| 阈值来源 | `ctxMax * 0.7`（百分比） | 硬编码 70,000 | 不同模型有不同 context window，百分比更通用 |
| ctxMax 获取 | 配置注入 + 默认 128,000 | 从 Pi SDK 读取 | Pi SDK 未暴露 context window，配置注入不依赖 SDK 内部实现 |
| 摘要生成方式 | LLM 生成 | 记忆系统自动总结 | 记忆系统是搜索引擎，不具备总结能力 |
| 摘要存储位置 | OtterSession.handoffSummary | 仅记忆系统 | Session 级别存储，便于交接时直接读取 |
| 数据模型边界 | 维持现有间接关联 | 引入 Conversation.activeSessionId | Session 是 Otter 私有概念，不应突破边界 |
| 降级策略 | 方案 B 作为降级 | 无降级 | 保障交接的鲁棒性 |

## 硬约束 [required]

- 记忆系统不进行语义总结，总结由 LLM（Agent）完成
- Session 是 Otter 的私有概念，不引入 Conversation.activeSessionId 直接绑定
- Session 交接采用方案 A（旧 Session 生成摘要），方案 B 作为降级策略
- 摘要存储在 OtterSession.handoffSummary，便于新 Session 读取
- Handoff 在 invoke **开始时**触发（主动预防），而非 invoke 完成后（被动反应）
- Handoff 阈值为 `ctxMax * 0.7`（百分比），ctxMax 通过配置注入（`OTTER_CTX_MAX`），默认 128,000
- Compaction 阈值为 `ctxMax * 0.9`，invoke 完成后作为降级保护
- 小獭退场时通过工具返回值传递上下文，不直接修改对话状态
- 小獭存入记忆系统的条目必须包含 conversationId，支持按对话维度检索
- Session 交接优先于 Pi Compaction，保留结构化信息
- 摘要生成失败时，仍然执行 handoff（归档 + 新 Session），新 Session 降级为从记忆系统检索
- handoff 失败时回滚归档，旧 Session 继续运行

## 关联 [required]

- **对话领域模块**：[F20260713c7p2](./F20260713c7p2-domain-conversation.md)
- **Otter 领域模块**：[F20260713o4t8](./F20260713o4t8-domain-otter.md)
- **记忆领域模块**：[F20260713m5q3](./F20260713m5q3-domain-memory.md)
- **数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **Pi 能力分析**：[pi-capability-analysis](../../research/R20260716x2k9-pi-capability-analysis.md)

## 偏差记录 [required]

### D-ARCH-1: 记忆系统的能力定位

**偏差对象**：用户对记忆系统的预期（UA-4）

| 项目 | 用户预期 | 实际能力 |
|------|---------|---------|
| 语义总结 | 记忆系统可能支持历史语义总结 | 记忆系统是搜索引擎，仅支持检索，不支持总结 |

**依据**：
1. 记忆系统的核心流程是 query -> retrieve -> rank -> return，不包含 generate
2. vec0 语义检索基于 embedding 距离，返回相似条目，不进行语义综合
3. 语义总结需要 LLM 的 generative 能力，属于 Agent 职责

### D-ARCH-2: 数据模型边界澄清

**偏差对象**：第一版设计文档中的 Conversation.activeSessionId 设计

| 项目 | 第一版设计 | 校准后设计 |
|------|-----------|-----------|
| 对话-Session 关联 | Conversation.activeSessionId 直接绑定大獭 Session | 维持现有间接关联（Conversation -> Otter -> OtterSession） |

**依据**：
1. 用户明确指出（UA-6, UA-7）：Session 属于 Otter 数据模型边界内
2. 现有关联链路已经清晰，不需要突破边界
3. 对话的连续性通过大獭维护，而非对话直接管理 Session

**修正原因**：第一版设计错误地将 Session 概念引入 Conversation 聚合根，违反了数据模型边界原则。

### D-ARCH-3: 摘要生成时机修正

**偏差对象**：第二版设计中的"新 Session 生成摘要"方案

| 项目 | 第二版设计 | 校准后设计 |
|------|-----------|-----------|
| 摘要生成者 | 新 Session（从记忆系统检索历史后生成） | 旧 Session（token 阈值触发时直接生成） |
| 理由 | 旧 Session token 已满，无法生成摘要 | 结构化摘要仅需 500-1,100 token，阈值 70k 留出 30k buffer 可行 |

**依据**：
1. 结构化摘要（`SessionHandoffSummary`）只需 500-1,100 token 输出，不是之前假设的 2,000-5,000
2. 阈值从 80,000 调整为 70,000，留出 30,000 token buffer，完全足够
3. 旧 Session 有"现场理解"，信息质量最高；新 Session 从记忆系统检索只有"二手理解"
4. 方案 A 的核心优势（信息完整性）在量化分析后仍然成立

**修正原因**：第二版设计错误地假设"token 接近上限时无法生成摘要"，但未量化分析摘要实际需要的 token。经量化分析，结构化摘要仅需 500-1,100 token，阈值 70k 留出 30k buffer 完全可行。

### D-ARCH-4: 触发机制修正

**偏差对象**：第二版设计中的触发时机和阈值设计

| 项目 | 第二版设计 | 校准后设计 |
|------|-----------|-----------|
| 触发时机 | invoke 完成后（被动反应） | invoke 开始前（主动预防） |
| 阈值来源 | 硬编码 70,000 / 100,000 | `ctxMax * 0.7` / `ctxMax * 0.9`（百分比） |
| ctxMax 获取 | 未定义 | 配置注入（`OTTER_CTX_MAX`）+ 默认 128,000 |

**依据**：
1. invoke 后检查是"被动反应"，当前轮可能已超出模型限制
2. invoke 前检查确保每次 invoke 都在"健康"的 session 中进行
3. 不同模型有不同的 context window，硬编码值不通用
4. `ctxMax` 字段已定义在 `AgentRunResult` 中但从未填充，需要通过配置注入

**修正原因**：第二版设计的触发时机（invoke 后）无法保护当前轮，且阈值硬编码不适用于不同模型。修正为 invoke 前检查 + ctxMax 百分比阈值。

## 不兼容更新 [required]

以下代码在 PR #33 中已合入，但与本设计文档的 D3 决策矛盾，已在本 PR 中移除：

### 已移除的代码

| 层 | 变更 | 文件 | 说明 | 状态 |
|---|------|------|------|------|
| **Entity** | `Conversation.activeSessionId` 字段 | `src/entities/conversation/conversation.ts` | 对话不应直接绑定 Session | ✅ 已移除 |
| **Schema** | `conversations.active_session_id` 列 | `src/frameworks/db/schema.ts` | FK -> otter_sessions(id) | ✅ 已移除（新 DB 不再创建此列） |
| **Gateway** | `ConversationBindingGateway` 接口 | `src/usecases/otter/manage-session.ts` | 对话绑定更新 Gateway | ✅ 已移除 |
| **Use Case** | `handoffSession()` 中的绑定步骤 | `src/usecases/otter/manage-session.ts` | 步骤 4: updateActiveSessionId | ✅ 已移除 |
| **Repository** | `ConversationRepository.updateActiveSessionId` | `src/usecases/conversation/conversation-repository.ts` | 更新对话的 Session 绑定 | ✅ 已移除 |
| **SQLite 实现** | `updateActiveSessionId` 实现 | `src/frameworks/db/conversation/sqlite-conversation-repository.ts` | Repository 实现 | ✅ 已移除 |
| **Mapper** | `activeSessionId` 映射 | `src/frameworks/db/conversation/conversation-mapper.ts` | Row <-> Entity 映射 | ✅ 已移除 |

### handoffSession() 流程（最终）

移除"更新绑定"步骤后，流程为：
1. 归档旧 Session（status -> archived + 工作记忆转历史）
2. 创建新 Session（status -> active，链式关系）
3. 存储交接摘要到新 Session（handoffSummary）
4. Agent reset（注入交接摘要作为上下文）

## 摘要格式定义 [required]

### SessionHandoffSummary 结构

代码中已定义 `SessionHandoffSummary`，作为交接摘要的标准格式：

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

### summary vs handoffSummary 职责划分

OtterSession 中有两个摘要字段，职责不同：

| 字段 | 类型 | 职责 | 写入时机 | 读取时机 |
|------|------|------|---------|---------|
| `summary` | string \| null | 自由文本，人类可读的归档摘要 | Session 归档时（可选） | 人工审查、调试 |
| `handoffSummary` | SessionHandoffSummary \| null | 结构化交接摘要，机器可解析 | Session 交接时（主动交接） | 新 Session 启动时注入上下文 |

**关系**：
- `handoffSummary` 是交接机制的核心，用于新 Session 的上下文注入
- `summary` 是可选的人类可读补充，用于人工审查和调试
- 两者独立，不互相依赖
- 交接流程中，`handoffSummary` 优先于 `summary`

## Handoff 与 Compaction 的架构关系 [required]

### 机制对比

| 维度 | Handoff（方案 A） | Pi Compaction |
|------|-------------------|---------------|
| 触发方 | 应用层（ManageSession） | Pi Session 内部 |
| 控制权 | 应用层完全控制 | Pi 内部机制，应用层无法干预 |
| 信息保留 | 结构化摘要（可控） | 压缩历史（不可控） |
| 优先级 | **优先** | 降级 |

### 关系定义

1. **Handoff 优先于 Compaction**：当 token 接近上限时，应用层应先触发 Handoff，而非等待 Pi 自动 Compaction
2. **Compaction 作为降级**：如果 Handoff 未能及时触发（如触发机制缺失），Pi 会自动 Compaction，这是可接受的降级
3. **两者不冲突**：Handoff 是应用层的主动管理，Compaction 是 Pi 的被动保护，可以共存
4. **Compaction 后仍可 Handoff**：如果 Compaction 先于 Handoff 发生，Handoff 仍可执行，但摘要质量可能下降（因为上下文已被压缩）

### 硬约束补充

- Session 交接（Handoff）优先于 Pi Compaction，应用层应主动管理交接时机
- 如果 Compaction 先于 Handoff 发生，Handoff 仍可执行，但摘要质量可能下降

## Handoff 触发机制 [required]

### 现有基础设施

Pi harness 层已有 token 监控能力：

| 能力 | 位置 | 说明 |
|------|------|------|
| `invoke()` 返回 `tokenUsage` | `PiHarnessFactory.invoke()` | 返回 `{ input: number, output: number }` |
| `checkAndCompact()` | `PiHarnessFactory` 私有方法 | invoke 后检查 token，超阈值触发 compact |
| `COMPACT_TOKEN_THRESHOLD` | 常量 = 100,000 | 当前 compaction 阈值 |

**数据流**：
```
Pi AgentHarness.getTokenUsage()
  -> PiHarnessFactory.invoke() 返回 AgentRunResult.tokenUsage
    -> AgentInvoker.invokeConversation() 返回 ConversationInvokeResult.tokenUsage
      -> SSE 事件 "message.complete" 中的 ctx 字段
```

### 触发方案：框架层自动触发（invoke 开始时）

**方案**：在 `invoke()` 开始时检查 token 使用量，提前触发 handoff，而非调用完成后被动检查。

**触发时机对比**：

| | 旧设计（invoke 后） | 新设计（invoke 前） |
|---|---|---|
| 检查时机 | LLM 调用完成后 | LLM 调用开始前 |
| 保护范围 | 仅保护下一轮 | 保护当前轮 |
| 信息质量 | 旧 Session 已完成本轮回复 | 旧 Session 在回复前生成摘要 |

**为什么 invoke 前检查**：
1. 当前代码 `checkAndCompact()` 在 `harness.prompt()` 之后执行，是被动反应
2. 如果 session 已 99k token，`prompt()` 会把 99k + 新消息一起发给 LLM，可能超出模型限制
3. invoke 前检查确保每次 invoke 都在"健康"的 session 中进行

### 阈值设计：基于 ctxMax 的百分比

**阈值来源**：模型的 context window（`ctxMax`），而非硬编码值。

**ctxMax 获取策略**（优先级）：
1. 从配置注入：`OTTER_CTX_MAX` 环境变量，由部署者根据模型设置
2. 降级默认值：128,000（覆盖主流模型：GPT-4o 128k, Claude 200k）
3. 记录偏差：阈值基于配置，非模型实际值

**阈值计算**：

| 阈值 | 计算方式 | 示例（ctxMax=128,000） | 触发动作 |
|------|---------|----------------------|---------|
| Handoff | `ctxMax * 0.7` | 89,600 | 触发 Handoff |
| Compaction | `ctxMax * 0.9` | 115,200 | 触发 Compaction（降级） |

**判断条件**：使用 `>=`（大于等于），即 70% 时触发，保守策略。

### 完整触发流程

```
invoke(otterId, message)
  -> openSession, createHarness
  -> tokenUsage = harness.getTokenUsage()
  -> ctxMax = config.ctxMax || 128_000

  -> if tokenUsage >= ctxMax * 0.7:
    -> handoffSession(otterId)
      -> 旧 Session LLM 生成摘要（独立 invocation，不处理用户消息）
      -> 归档旧 Session
      -> 创建新 Session
      -> agentGateway.reset()（新 Session 上下文）
      -> 成功：用新 Session 的 harness 继续处理用户消息
      -> 失败：回滚，用旧 Session 的 harness 继续
  -> else:
    -> 正常流程

  -> harness.prompt(message)     // 处理用户消息
  -> checkAndCompact()           // invoke 后降级保护
```

### 关键设计

| 问题 | 决策 |
|------|------|
| 谁检测 token 使用量？ | 框架层（`PiHarnessFactory`） |
| 阈值来源 | `ctxMax * 0.7`（配置注入或默认 128,000） |
| 检测时机？ | 每次 `invoke()` **开始时** |
| 触发后谁调用 handoffSession()? | 框架层自动调用（通过 `ManageSession`） |
| 摘要生成者 | 旧 Session（独立 invocation） |
| 用户消息处理者 | 新 Session（handoff 成功后） |

### 边界情况处理

| 场景 | 处理 |
|------|------|
| tokenUsage 正好在 70% 边界 | `>=` 判断，触发 handoff（保守策略） |
| 摘要生成失败 | 仍然执行 handoff（归档 + 新 Session），新 Session 降级为从记忆系统检索 |
| handoff 本身失败（如新 Session 创建失败） | 回滚归档，旧 Session 继续运行，降级为 compaction 保护 |
| invoke 前检查漏掉 | `checkAndCompact()` 在 invoke 后作为降级保护 |

### 与 Pi Compaction 的协调

```
invoke() 开始
  -> 检查 tokenUsage >= ctxMax * 0.7
    -> 触发 Handoff（旧 Session 生成摘要 -> 归档 -> 新 Session）
      -> 成功：新 Session 处理用户消息
      -> 失败：回滚，旧 Session 继续

invoke() 完成
  -> checkAndCompact()（降级保护）
    -> tokenUsage >= ctxMax * 0.9
      -> 触发 Compaction（Pi 内部机制）
```

**优先级**：Handoff > Compaction
**降级关系**：Handoff 失败 -> 旧 Session 继续 -> invoke 后 Compaction 保护

## 未实现项 [required]

以下功能在本设计文档中定义，但需要后续独立 feature 实现：

| 项目 | 原因 | 依赖 |
|------|------|------|
| 对话归档时自动生成 conversation_summary（B-CS-6） | 需要 LLM 调用能力，属于 orchestration 层 | LLM 调用基础设施 |
| 小獭上下文传递的具体工具协议（B-CS-4, B-CS-6） | 需要工具系统设计 | 工具系统设计 |
