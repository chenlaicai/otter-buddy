---
id: F20260722tools
title: agent-tools-audit-fix
doc_type: feature

# 记忆索引
summary: |
  对 18 个 agent 工具进行对抗审计，修复 6 项缺陷（DRY 违反、死代码、schema 校验缺失、
  hardcoded 参数、安全漏洞、小獭权限不一致），移除 1 个孤儿工具（store_memory，
  游离于 MemoryIndexGateway 管道之外），新增 2 个工具（get_active_participants、
  delete_context），新增 2 个 Skill（participant-management、key-resources）。工具总数 18→19。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716t2ab   # tool-skill-mechanism
    - F20260720k3m7   # artifact-lifecycle-management
    - F20260721speak   # speak-skill

# 元数据
status: development
change_type: feature
tags: [agent, tools, skills, audit, participant, context, artifacts]
modules: [src/interface-adapters/agent-runtime/tools/, skills/, src/frameworks/agent/]

# 时间
created_at: 2026-07-22
---


# F20260722tools Agent 工具审计修复 + 新增 Skill

## 背景

### 问题

对 18 个 agent 工具进行对抗审计后发现以下问题：

| 级别 | 问题 | 影响 |
|------|------|------|
| HIGH | 18 个工具零测试覆盖 | 回归风险 |
| MEDIUM | `textResponse` 辅助函数在 3 个文件中重复定义 | DRY 违反 |
| MEDIUM | `conversation.message.send()` 死代码（OtterToolClient 接口 + main.ts 实现） | 维护负担 |
| MEDIUM | `resource.getIndex()` 死代码（无工具调用） | 维护负担 |
| MEDIUM | `get_context`/`set_context` 用途模糊，无 delete 操作 | agent 不知何时使用 |
| LOW | `create_linked_resource` schema 只声明 resourceType 为 required，fact 需 content、非 fact 需 url 未校验 | 错误信息不友好 |
| LOW | `search_terminology` limit 硬编码为 10，忽略 LLM 参数 | 与其他搜索工具不一致 |
| LOW | `dissolve_otter` 无自我溶解防护 | LLM 可误删自己 |
| LOW | 小獭能 `create_linked_resource` 但不能 `list_artifacts`/`update_artifact_status` | 权限逻辑不自洽 |

### 根因

工具层快速迭代过程中缺少系统性审计。Skill 层也存在缺口——有工具但没有配套的行为规范（participant-management、key-resources）。

## 目标

### T1 — 修复工具缺陷

- 提取 `textResponse` 到共享 `tool-helpers.ts`
- 删除 `conversation.message.send()` 和 `resource.getIndex()` 死代码
- `create_linked_resource` 增加 execute 层校验
- `search_terminology` 暴露 `limit` 参数
- `dissolve_otter` 增加自我溶解防护

### T2 — 新增缺失工具

- `get_active_participants`：查询当前对话活跃参与者
- `delete_context`：删除 otter 上下文 KV 条目（全链路：repo→sqlite→usecase→client→tool）

### T3 — 修复小獭工具权限

小獭从 12 工具扩展到 16 工具，新增：`list_artifacts`、`update_artifact_status`、`delete_context`、`get_active_participants`

### T4 — 新增 Skill

- `participant-management`：参与者管理策略
- `key-resources`：关键资源 CRUD 策略

## 非目标

- 不新增工具测试（零测试问题单独处理）
- 不修改 `list_artifacts` 的客户端过滤逻辑（改为服务端过滤是独立优化）
- 不修改 `OtterToolClient` 中其他未被工具调用的方法（如 `otter.getById`、`memory.getById`）

## 设计

### 1. textResponse DRY 修复

新建 `src/interface-adapters/agent-runtime/tools/tool-helpers.ts`，导出 `ToolResponse` 接口和 `textResponse` 函数。三个工具文件改为 import。

注意：`ToolResponse` 需从 `tool-factory.ts` 移到 `tool-helpers.ts`，`tool-factory.ts` 通过 `export type { ToolResponse } from "./tool-helpers"` 保持对外兼容。

### 2. create_linked_resource 校验

在 execute body 中增加前置校验：

```typescript
const resourceType = (params.resourceType as string | undefined) ?? "url";
if (resourceType === "fact") {
  if (!params.content || (params.content as string).trim().length === 0) {
    return textResponse("[错误] resourceType 为 'fact' 时，content 不能为空。");
  }
} else {
  if (!params.url || (params.url as string).trim().length === 0) {
    return textResponse(`[错误] resourceType 为 '${resourceType}' 时，url 不能为空。`);
  }
}
```

JSON Schema 无法表达条件必填，因此校验放在 execute 层而非 schema 层。

### 3. search_terminology limit

parameters.properties 新增 `limit: { type: "number", description: "最大结果数（默认 10）" }`，execute 中 `(params.limit as number) ?? 10` 替代硬编码。

### 4. dissolve_otter 防护

execute body 开头增加 `if (targetOtterId === ctx.otterId)` 检查。

### 5. delete_context 全链路

| 层 | 文件 | 变更 |
|----|------|------|
| Repository 接口 | `otter-context-repository.ts` | 新增 `delete(otterId, key)` |
| SQLite 实现 | `sqlite-otter-context-repository.ts` | `DELETE FROM otter_context WHERE otter_id = ? AND key = ?` |
| Use Case | `manage-context.ts` | 新增 `delete` 方法 |
| Client 接口 | `otter-tool-client.ts` | context 命名空间新增 `delete` |
| 接线 | `main.ts` | context 对象新增 `delete` |
| Tool | `tool-factory.ts` | 新增 `createDeleteContextTool` |

### 6. get_active_participants

调用已有的 `ctx.client.conversation.participant.getActive(ctx.conversationId)`，返回 `{ otterId, otterName, status, joinedAtTurnNumber }` 投影。

### 7. 小獭权限调整

`getOtterToolNamesForType()` small otter 返回数组新增 4 个工具名。

### 8. participant-management Skill

`skills/participant-management/SKILL.md`，覆盖：查询参与者场景、邀请规则、退场时机、发言石路由原则、上下文管理。

### 9. key-resources Skill

`skills/key-resources/SKILL.md`，覆盖：6 种 resourceType 及必填字段、创建时机、groupId 命名规范、生命周期管理、与记忆系统的关系。

## 硬约束

1. `textResponse` 从 `tool-helpers.ts` 导出，`tool-factory.ts` 通过 re-export 保持 `ToolResponse` 的对外接口
2. `create_linked_resource` 校验在 tool execute 层，不依赖 JSON Schema 条件表达式
3. `delete_context` 全链路必须经过 use case 层，不绕过直接操作 repository
4. `get_active_participants` 返回含 otterName 的投影，便于 LLM 做路由决策
5. 小獭不能获得 `pass_talking_stone`、`create_otter`、`dissolve_otter`——这些是管理级操作
6. 小獭**可以**获得 `list_artifacts` 和 `update_artifact_status`——小獭执行 code-implementation 和 adversarial-review 等实质性工作，需要管理自己产出的产物状态

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/interface-adapters/agent-runtime/tools/tool-helpers.ts` | 新增 | 共享 textResponse + ToolResponse |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | DRY 重构 + 4 项修复 + 2 个新工具 |
| `src/interface-adapters/agent-runtime/tools/artifact-tools.ts` | 修改 | DRY 重构 |
| `src/interface-adapters/agent-runtime/tools/message-tools.ts` | 修改 | DRY 重构 |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` | 修改 | 删除死代码 + context.delete |
| `src/main.ts` | 修改 | 删除死代码 + context.delete 接线 |
| `src/usecases/otter/otter-context-repository.ts` | 修改 | 接口新增 delete |
| `src/frameworks/db/otter/sqlite-otter-context-repository.ts` | 修改 | 实现 delete |
| `src/usecases/otter/manage-context.ts` | 修改 | 新增 delete 方法 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | 工具白名单更新 |
| `skills/participant-management/SKILL.md` | 新增 | 参与者管理 Skill |
| `skills/key-resources/SKILL.md` | 新增 | 关键资源管理 Skill |

## 验证清单

- [x] `tsc --noEmit` 编译通过
- [x] 工具总数 18→19（大獭 19，小獭 16）
- [x] Skill 总数 5→7
- [ ] `npm test` 现有测试不回归
- [ ] 集成验证：`get_active_participants` 返回正确参与者列表
- [ ] 集成验证：`delete_context` 正确删除 KV 条目
- [ ] 集成验证：`create_linked_resource` fact 类型无 content 时返回错误
- [ ] 集成验证：`dissolve_otter` 自我溶解被拒绝
- [ ] 集成验证：小獭可调用 `list_artifacts` 和 `update_artifact_status`
