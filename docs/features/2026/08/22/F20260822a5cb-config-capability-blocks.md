---
id: F20260822a5cb
change_type: feature
title: config 能力块约定
summary: 在 tool-manifest.json 中新增 capabilityBlocks 顶层字段，定义命名工具组（能力块）。types 可通过 groups 字段引用能力块，loader 自动展开合并去重。schemaVersion 从 1 升到 2，向后兼容 v1 格式。
tags: [agent, architecture, tool-routing, manifest, capability-blocks, config]
capability_test: n/a（纯配置+loader改动，无运行时行为变更）
modules:
  - src/frameworks/config/tool-manifest-loader.ts
  - config/tool-manifest.json
  - scripts/lint-tool-manifest.mjs
  - tests/frameworks/config/tool-manifest-loader.test.ts
created_in_conversation: 8f54f71f-7f40-4135-b67f-add5ed1e8378
from: [R20260817arnt, F20260820a4rt]
---

# config 能力块约定

## 背景

**意图锚**：R20260817arnt 落地路径中的 A5 项——A4（声明式工具路由）完成后，引入 capabilityBlocks 消除 small type 工具列表冗余。

**现状问题**：A4 的 small type 工具列表是 24 个工具的扁平数组，与 big type 的全量工具集之间缺乏结构化分组。新增工具时需要记住它属于哪个功能域（记忆/对话/上下文等），容易遗漏或归类错误。同时，未来如果新增 otter 类型（如 review otter），需要从头列举工具列表，无法复用已有的功能分组。

**来源**：R20260814mtrc（dsh-pluginization-lessons）落地路径明确 A5 为「config 能力块约定」，与 A4（per-type 路由）配合实现「能力可选」诉求。

## 目标

- **T1**：工具分组声明式——定义命名的能力块（capabilityBlocks），types 通过 groups 字段引用，新增/调整 otter 类型的工具集只需引用能力块组合
- **T2**：向后兼容——schemaVersion 2 的 loader 能正确加载 v1 格式的 manifest（无 capabilityBlocks 字段）
- **T3**：校验完备——lint 工具在 CI 阶段拦截无效的 capabilityBlocks 定义和 groups 引用

## 非目标

- **N1**：不做能力块嵌套——capabilityBlocks 是扁平的命名工具组，不支持 blocks 引用 blocks
- **N2**：不做运行时能力切换——能力块在 manifest 加载时展开，运行中不可变
- **N3**：不做 per-tool 粒度移除——groups 是可选的补充机制，types.tools 仍然支持直接列举工具

## 方案设计

### 核心概念

```
capabilityBlocks (定义命名工具组)
    ↓ 被引用
types.small.groups (引用能力块名称列表)
    ↓ loader 展开
getToolNamesFromManifest() → groups.tools ∪ type.tools (dedupe)
```

### 改动清单

#### 1. manifest schema 升级

**文件**: `config/tool-manifest.json`

新增 `capabilityBlocks` 顶层字段，定义 7 个能力块：

| 能力块 | 工具数 | 包含工具 |
|--------|--------|----------|
| memory | 7 | search_memory, create_linked_resource, get_memory_detail, link_memory, get_related, unlink_memory, sync_docs |
| conversation | 4 | get_message, list_messages, search_messages, get_turn_history |
| context | 3 | get_context, set_context, delete_context |
| terminology | 2 | search_terminology, add_terminology |
| artifacts | 2 | list_artifacts, update_artifact_status |
| system | 4 | get_active_participants, get_html_card_contract, create_scheduled_task, manage_healing_events |
| workspace | 4 | workspace_info, workspace_list, workspace_read, workspace_write |

small type 改为 groups 引用 + 直接工具：
```json
{
  "groups": ["memory", "conversation", "context", "terminology", "artifacts", "system", "workspace"],
  "tools": ["speak", "yield", "restart_otter"]
}
```

#### 2. loader 新增 capabilityBlocks 支持

**文件**: `src/frameworks/config/tool-manifest-loader.ts`

- 新增 `CapabilityBlock` 接口（description + tools）
- `ToolManifestType` 新增可选 `groups` 字段
- `ToolManifest` 新增可选 `capabilityBlocks` 字段
- 新增校验函数：`validateCapabilityBlocks`、`validateCapabilityBlockConfig`、`validateGroups`
- `getToolNamesFromManifest` 新增 groups 展开逻辑：groups 在前、type tools 在后、Set dedupe 保序

#### 3. lint 工具扩展

**文件**: `scripts/lint-tool-manifest.mjs`

新增校验项：
- capabilityBlocks 结构校验（每个 block 必须有 description 和 tools）
- groups 引用校验（引用的块名必须在 capabilityBlocks 中存在）
- capabilityBlocks 内工具名存在性校验（工具名必须在 tool-factory.ts 中注册）

### 设计决策

| 问题 | 决策 | 理由 |
|------|------|------|
| schemaVersion | 2 | 新增顶层字段 + types 内新字段，向后兼容 |
| groups 展开顺序 | groups 在前，type tools 在后 | groups 是基础能力，type tools 是补充 |
| capabilityBlocks 位置 | 与 types 同级 | 保持单文件简单性，不引入额外配置文件 |
| v1 兼容性 | capabilityBlocks 可选 | loader 不要求该字段存在，v1 manifest 正常加载 |

## 影响范围

| 模块 | 影响 |
|------|------|
| `config/tool-manifest.json` | schemaVersion 1→2，新增 capabilityBlocks |
| `tool-manifest-loader.ts` | 新增接口 + 校验 + 展开逻辑 |
| `lint-tool-manifest.mjs` | 新增 3 项校验 |
| 运行时行为 | 不变——groups 展开后的工具列表与 A4 版本完全一致 |

## 风险与约束

| 风险 | 缓解 |
|------|------|
| groups 引用了不存在的 block | lint 阶段拦截 + loader 校验 |
| 展开后工具列表与预期不一致 | lint 脚本验证生产 manifest 展开完整性 |
| loader 和 lint 校验逻辑重复 | 当前可接受（loader 运行时容错 vs lint 构建时报错），后续可抽取共享 |

## 不兼容更新

无不兼容更新。schemaVersion 2 向后兼容 v1——capabilityBlocks 是可选字段，不存在时 loader 行为与 v1 完全一致。

## 验证

- [x] `npm run lint` 通过
- [x] `npm test` 通过（1331 tests）
- [x] `node scripts/lint-tool-manifest.mjs` 通过
- [x] groups 展开后工具列表与 A4 版本完全一致（29 工具）

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `config/tool-manifest.json` | 修改 | schemaVersion 2 + capabilityBlocks 定义 |
| `src/frameworks/config/tool-manifest-loader.ts` | 修改 | CapabilityBlock 接口 + groups 展开 + 校验 |
| `scripts/lint-tool-manifest.mjs` | 修改 | capabilityBlocks/groups 校验 |
| `tests/frameworks/config/tool-manifest-loader.test.ts` | 修改 | 35 个测试（新增 v2 相关测试） |
