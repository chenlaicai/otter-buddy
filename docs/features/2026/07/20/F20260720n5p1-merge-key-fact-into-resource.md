---
id: F20260720n5p1
title: 合并关键事实到统一产物模型
doc_type: feature

# 记忆索引
summary: |
  将 KeyFact 合并到 LinkedResource，统一制品模型。
  消除三层记忆架构的复杂性，简化为两层，降低 Agent 认知负担。


# 元数据
status: development
change_type: refactor
tags: []
modules: []

# 时间
created_at: 2026-07-20
---

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
