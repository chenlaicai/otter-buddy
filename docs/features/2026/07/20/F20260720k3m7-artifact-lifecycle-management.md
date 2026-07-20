# F20260720k3m7 - 外部产物生命周期管理

## 元信息

- **特性编号**：F20260720k3m7
- **创建日期**：2026-07-20
- **状态**：development
- **变更类型**：feature
- **模块**：conversation

## 问题背景

### 现象

在一次 conversation 中，用户提出问题 → 与海獭讨论形成报告 → 拆解为多个软件特性 → 串行开发（设计→实现→检视→合入）。过程中多个海獭进进出出，产生大量外部产物（讨论报告、特性文档、PR、worktree、branch）。

当前 `LinkedResource` 仅是 append-only 的链接记录，存在以下问题：

1. **无生命周期状态**：无法区分产物是"当前有效"还是"已被替代"或"已归档"
2. **无分组机制**：无法将产物关联到特定特性（如哪些 PR/worktree 属于特性 F20260720xxxx）
3. **无替代链追踪**：worktree 重建后，旧 worktree 记录仍然"活跃"，无从知道被谁替代
4. **无发现机制**：新进场的海獭无法快速了解当前对话中存在哪些产物及其状态
5. **无时间维度**：无法感知产物是"最近创建"还是"很久以前创建"的

### 根因分析

`LinkedResource` 实体设计为轻量链接记录，缺少产物管理所需的生命周期维度：

| 缺失项 | 影响 |
|--------|------|
| 状态字段 | 所有链接资源一律平等，无法区分活跃/过期/归档 |
| 分组字段 | 无法按特性聚合产物 |
| 替代关系 | 无法追踪"旧→新"的替代链 |
| 时间刻度 | 仅靠 wall-clock 时间，无法与对话内 Turn 进度关联 |

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | "如何记录、记录在哪、如何更新或移除" | 对话 | 记录/更新/移除 | 产物需要完整的 CRUD + 生命周期管理 |
| UA-2 | "各个海獭如何感知到" | 对话 | 感知 | 需要发现机制，新进场海獭能快速了解产物全景 |
| UA-3 | "产物肯定是具备时效的" | 对话 | 时效 | 产物有生命周期，需要状态管理 |
| UA-4 | "append-only 但有状态管理" | 对话 | append-only + 状态 | 不删除记录，通过状态标记下线 |
| UA-5 | "用 turn 机制来反映存活周期" | 对话 | turn 机制 | 用 Turn 编号而非时间戳度量产物存活 |

## 设计决策

### D1: 扩展 LinkedResource，不新建实体

**决策**：直接在 `LinkedResource` 实体和 `linked_resources` 表上扩展，不新建独立实体或表。

**理由**：
- `LinkedResource` 已有正确的领域概念（外部产物绑定到对话）
- `resourceType` 已是开放式字符串，`metadata` JSON 已有扩展能力
- 已有 `create_linked_resource` 工具、`ManageKeyInfo` 用例、`MemoryIndexAdapter` 索引链路
- 缺失的只是维度字段，不需要新的实体抽象

### D2: Turn 编号度量存活周期

**决策**：用 Turn 编号（`linkedAtTurnNumber` / `statusChangedAtTurnNumber`）替代时间戳。

**理由**：
- Turn 是对话内的进度刻度，与 `ConversationParticipant` 的 `joinedAtTurnNumber`/`leftAtTurnNumber` 模式一致
- 新海獭进场看到"这个产物是 3 个 turn 前创建的"比解析 ISO 时间戳更直觉
- Session handoff 按 token 量触发，不按时间，wall-clock 时间不能反映对话内的"远近"

### D3: 三态状态机

**决策**：`active → superseded → archived`，archived 为终态。

**理由**：
- `active`：当前有效，agent 应优先感知
- `superseded`：已被新版替代（如 worktree 重建），保留替代链
- `archived`：终态（如 PR 已合入），不再参与常规查询

### D4: supersede 操作原子性

**决策**：`supersedeResource` 在 repository 层用 `BEGIN/COMMIT/ROLLBACK` 事务包裹，确保"创建新资源 + 标记旧资源"原子完成。

**理由**：两步写操作如果分步执行，中间失败会导致"新旧两个 active 资源并存"的不一致状态。

## 实现方案

### 实体层

- 新增 `ArtifactStatus` 类型：`"active" | "superseded" | "archived"`
- `LinkedResource` 接口新增 5 字段：`status`, `linkedAtTurnNumber`, `statusChangedAtTurnNumber`, `groupId`, `supersededBy`
- 新增守卫函数：`canTransitionArtifactStatus`, `isArtifactActive`, `isArtifactVisible`
- 新增值对象：`ArtifactGroup`, `ArtifactIndex`

### Schema 层

- `linked_resources` 表新增 5 列 + 2 索引

### Repository 层

- `linkResource` INSERT 增加 5 列
- `getLinkedResources` 支持 `status`/`resourceType` 过滤
- 新增 `getLinkedResourceById`, `getLinkedResourcesByGroup`, `updateResourceStatus`, `supersedeLinkedResource`（事务）

### Use Case 层

- `ManageKeyInfo` 新增 `supersedeResource`（原子）, `archiveResource`, `getArtifactIndex`, `updateResourceStatus`（含守卫校验）

### Agent Tool 层

- 扩展 `create_linked_resource` 增加 `groupId`/`resourceType` 参数
- 新增 `list_artifacts` 工具（按 status/resourceType/groupId 过滤，默认排除 archived）
- 新增 `update_artifact_status` 工具（含运行时状态值校验）
- 工具通过 `getActiveTurnNumber` 获取实际 turn 编号

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/entities/conversation/conversation.ts` | 扩展 |
| `src/frameworks/db/schema.ts` | 扩展 |
| `src/frameworks/db/conversation/conversation-mapper.ts` | 扩展 |
| `src/usecases/conversation/conversation-repository.ts` | 扩展 |
| `src/frameworks/db/conversation/sqlite-conversation-repository.ts` | 扩展 |
| `src/usecases/conversation/manage-key-info.ts` | 扩展 |
| `src/usecases/conversation/manage-conversation.ts` | 扩展 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 扩展 |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` | 扩展 |
| `src/main.ts` | 接线 |
| `api-contract/api/key-info.ts` | 扩展 |
| `src/interface-adapters/http/dto/key-info-dto.ts` | 扩展 |
| `src/interface-adapters/http/controllers/key-info-controller.ts` | 扩展 |

## 验证清单

- [x] TypeScript 编译通过
- [x] 119 单元测试全过
- [x] 对抗检视通过（2 Critical + 6 Major 已修复）
- [ ] 集成验证：linked_resources 表新列正确创建
- [ ] 集成验证：supersedeResource 原子性（事务回滚）
- [ ] 集成验证：list_artifacts 工具过滤行为正确
- [ ] 集成验证：update_artifact_status 工具状态转换校验
