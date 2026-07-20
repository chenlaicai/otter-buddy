# F20260720n5p1 - 合并关键事实到统一产物模型

## 元信息

- **特性编号**：F20260720n5p1
- **创建日期**：2026-07-20
- **状态**：development
- **变更类型**：refactor
- **模块**：conversation

## 问题背景

### 现象

对话子系统有两套平行的"关键信息"机制：`KeyFact`（关键事实）和 `LinkedResource`（链接资源/外部产物）。两者定位雷同——都是绑定到对话的重要信息，都有记忆索引，但数据模型、存储表、API 路由、前端状态完全独立。

#49 已将 `LinkedResource` 升级为完整的产物生命周期系统（三态状态机、分组、替代链、轮次感知），使其具备承载所有类型"关键资源"的能力。此时 `KeyFact` 作为独立概念的存在意义已弱化。

1. **AI 认知负担**：Agent 需要理解两套模型（`key_facts` 表 + `linked_resources` 表），增加工具选择和上下文构建的复杂度
2. **代码冗余**：Repository、Use Case、Controller、前端各层都有平行的 KeyFact / LinkedResource 两套方法
3. **记忆层碎片化**：KeyFact 用 `key_info` 层 / `key_fact` 内容类型，LinkedResource 用 `working` 层 / `linked_resource` 内容类型，搜索结果需要跨层聚合
4. **扩展受限**：KeyFact 无生命周期管理（不能 supersede/archive），无法与产物系统共享能力

### 根因分析

`KeyFact` 和 `LinkedResource` 在领域模型层面都是"对话关联的关键信息"，但实现层被当作两个独立实体，导致：

| 重复点 | KeyFact | LinkedResource |
|--------|---------|----------------|
| DB 表 | `key_facts` | `linked_resources` |
| Entity | `KeyFact` 接口 | `LinkedResource` 接口 |
| Repository | `addKeyFact/getKeyFacts/deleteKeyFact/flagKeyFact` | `linkResource/getLinkedResources/deleteLinkedResource` |
| Use Case | `ManageKeyInfo.addKeyFact/getKeyInfo` | `ManageKeyInfo.linkResource/getLinkedResources` |
| API | `POST/DELETE/PATCH /key-facts` | `POST/DELETE /resources` |
| 前端 state | `allKeyFacts` | `allLinkedRes` |
| 记忆索引 | `key_info` 层 / `key_fact` 类型 | `working` 层 / `linked_resource` 类型 |

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | "keyfact 完全可以放入到产物机制中" | 对话 | 放入 | KeyFact 变为 resourceType="fact" 的 LinkedResource |
| UA-2 | "产物机制是一种灵活的机制，也是支持文本内容的" | 对话 | 灵活/文本 | 产物模型的 resourceType + content 字段足以承载文本事实 |
| UA-3 | "统一一套比两套，让 AI 更好理解" | 对话 | 统一/AI 理解 | 合并的核心收益是降低 Agent 认知负担 |

## 设计决策

### D1: KeyFact 变为 resourceType="fact" 的 LinkedResource

**决策**：删除 `KeyFact` 实体和 `key_facts` 表，关键事实作为 `resourceType = "fact"` 的特殊 LinkedResource 存储。

**理由**：
- `resourceType` 本身是开放字符串，新增 `"fact"` 类型无需 schema 变更
- `LinkedResource` 已有 `content` 扩展能力（新增列），足以存储文本事实
- fact 类型可复用产物生命周期（虽然默认 active，但技术上支持 supersede/archive）
- Agent 只需理解一套 `create_linked_resource` 工具，通过 `resourceType` 区分

### D2: url 对 fact 类型可为空

**决策**：`linked_resources.url` 列改为 nullable。fact 类型使用 `content` 列存储文本，`url` 为空。

**理由**：
- 事实是文本知识，没有 URL 概念
- 强制填 URL 会导致语义污染（如填占位符 `""` 或 `"fact://..."`）
- SQLite 的 nullable 处理零成本

### D3: 记忆层统一为 working

**决策**：移除 `key_info` 记忆层和 `key_fact` 内容类型。fact 索引使用 `layer: "working"`, `contentType: "fact"`。

**理由**：
- `key_info` 层仅用于 KeyFact 和术语搜索结果的类型标注，语义不清
- `working` 层已覆盖对话进行中的所有活跃信息
- 新增 `"fact"` 内容类型保持与 `"linked_resource"` 的区分度

### D4: API 简化

**决策**：删除 `/key-facts` 路由，`/key-info` 改为 `/key-resources`。fact 的 CRUD 统一走 `/resources` 路由。

**理由**：
- 前端不再需要两套 API 调用
- `/key-resources` 返回全量资源列表，前端按 `resourceType` 过滤展示

## 实现方案

### Entity 层

- 删除 `KeyFact` 接口和 `KeyInfo` 组合值对象
- `LinkedResource` 新增可选字段：`content`, `category`, `userFlagged`
- `url` 改为 `string | null`
- `MemoryLayer` 移除 `"key_info"`，`MemoryContentType` 移除 `"key_fact"` 新增 `"fact"`

### Schema 层

- `linked_resources` 表新增 `content TEXT`、`category TEXT`、`user_flagged INTEGER DEFAULT 0`
- `url` 列改为 nullable
- 新增 `idx_linked_resources_user_flagged` 索引
- 删除 `key_facts` 表及索引

### Repository 层

- 删除 `addKeyFact`、`getKeyFacts`、`deleteKeyFact`、`flagKeyFact` 方法
- `linkResource` INSERT 语句新增 3 列
- 新增 `flagResource(id, flagged)` 方法

### Use Case 层

- `ManageKeyInfo`：删除 KeyFact 相关方法，`linkResource` 支持 fact 类型（使用 content 字段）
- `MemoryIndexGateway`：删除 `indexKeyFact`，`indexLinkedResource` 签名新增 `resourceType` 参数

### Agent 工具层

- `create_linked_resource`：新增 `content` 参数，`resourceType` 加入 `"fact"` 选项，`url` 对 fact 可选
- `list_artifacts`：输出新增 `content`/`category`/`userFlagged` 字段

### HTTP API 层

- 删除 `KeyFactDTO`、`AddKeyFactRequestDTO`
- `LinkedResourceDTO` 新增 `content`/`category`/`userFlagged`
- `KeyInfoDTO` 改为 `{ resources: LinkedResourceDTO[] }`
- 路由：删除 `/key-facts`，`/key-info` → `/key-resources`

### 前端层

- 删除 `LocalKeyFact`、`mapKeyFactDTO`、`allKeyFacts` state
- `LocalLinkedResource` 新增 `content`/`category`/`flagged`
- RightPanel：关键事实 section 从 `linkedResources.filter(r => r.type === 'fact')` 渲染
- 记忆搜索页：`key_fact` → `fact`，移除 `key_info` 层选项

## 涉及文件

| 层 | 文件 | 改动类型 |
|---|---|---|
| Entity | `src/entities/conversation/conversation.ts` | 删除 KeyFact/KeyInfo，扩展 LinkedResource |
| Entity | `src/entities/memory/memory-entry.ts` | 移除 key_info/key_fact，新增 fact |
| Schema | `src/frameworks/db/schema.ts` | 扩展 linked_resources，删除 key_facts |
| Mapper | `src/frameworks/db/conversation/conversation-mapper.ts` | 删除 KeyFactRow，扩展 LinkedResourceRow |
| Repo | `src/usecases/conversation/conversation-repository.ts` | 删除 KeyFact 方法，新增 flagResource |
| Repo | `src/frameworks/db/conversation/conversation-repository-mixins.ts` | 删除 KeyFact 函数，扩展 linkResource |
| Repo | `src/frameworks/db/conversation/sqlite-conversation-repository.ts` | 同步接口变更 |
| Use Case | `src/usecases/conversation/manage-key-info.ts` | 删除 KeyFact 逻辑，统一到 resource |
| Gateway | `src/usecases/conversation/memory-index-gateway.ts` | 删除 indexKeyFact |
| Composition | `src/main.ts` | 适配器更新 |
| Tool | `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 工具支持 fact |
| Tool | `src/interface-adapters/agent-runtime/tools/artifact-tools.ts` | 描述和输出更新 |
| Tool Client | `src/interface-adapters/agent-runtime/otter-tool-client.ts` | Input 扩展 |
| API Contract | `api-contract/api/key-info.ts` | 删除 KeyFactDTO，扩展 LinkedResourceDTO |
| DTO | `src/interface-adapters/http/dto/key-info-dto.ts` | 删除 toKeyFactDTO |
| Controller | `src/interface-adapters/http/controllers/key-info-controller.ts` | 删除 fact handler |
| Router | `src/interface-adapters/http/router.ts` | 删除 /key-facts 路由 |
| Frontend | `web/src/api/client.ts` | 删除 fact API |
| Frontend | `web/src/lib/mappers.ts` | 删除 LocalKeyFact |
| Frontend | `web/src/pages/conversation/index.tsx` | 合并 state |
| Frontend | `web/src/pages/conversation/RightPanel.tsx` | 合并 UI section |
| Frontend | `web/src/pages/memory/index.tsx` | 更新 label |
| Memory | `src/usecases/memory/search-memory.ts` | 术语结果类型修正 |
| Tests | `tests/interface-adapters/dto.test.ts` | 更新测试 |

## 验证清单

- [x] TypeScript 编译通过（`npx tsc --noEmit`）
- [x] 119 单元测试全过（`npm test`）
- [ ] 集成验证：linked_resources 表新列正确创建
- [ ] 集成验证：fact 类型资源 CRUD 正常
- [ ] 集成验证：RightPanel 关键事实增删改查 + star toggle
- [ ] 集成验证：Agent create_linked_resource 工具支持 resourceType="fact"
