---
id: F20260820a4rt
change_type: feature
title: otter-type 级声明式工具路由
summary: 将硬编码的工具白名单改为声明式 manifest 配置，新增/调整 otter 类型只需修改 config/tool-manifest.json，不改代码。新增 lint 工具校验 manifest 与 DB 约束一致性。
tags: [agent, architecture, tool-routing, manifest, otter-type]
capability_test: n/a（纯配置+lint改动，无运行时行为变更）
modules:
  - src/frameworks/agent/session-helpers.ts
  - src/frameworks/agent/tool-builder.ts
  - src/usecases/ports/otter-config-provider.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/config/tool-manifest-loader.ts
  - config/tool-manifest.json
  - scripts/lint-tool-manifest.mjs
created_in_conversation: 8f54f71f-7f40-4135-b67f-add5ed1e8378
from: [R20260817arnt, F20260817a3rt]
---

# otter-type 级声明式工具路由

## 背景

**意图锚**：搭档说「架构增量」，指向 R20260817arnt 落地路径中的 A4 项——批次 3 完成后的第一个架构增量工作。

**现状问题**：当前 `getOtterToolNamesForType` 函数硬编码两组工具白名单（big=全部，small=子集）。每新增/调整一种 otter 类型，必须修改代码、重新部署。工具路由与代码耦合，无法实验。

**来源**：R20260817arnt 落地路径明确 A4 为「otter-type 级工具路由，含三条设计要求与 lint」。R20260814mtrc（dsh-pluginization-lessons）研究了 dsh 的 manifest 路由范式，提出三个待决问题（manifest 粒度、软能力路由、变更语义），本 F 回答这些问题。

## 目标

- **T1**：工具路由声明式——新增/调整 otter 类型的工具集不改代码，只改配置
- **T2**：manifest 可校验——lint 工具在 CI 阶段拦截无效配置（引用不存在的工具名、类型未注册等）
- **T3**：行为不变——big/small 两种 otter 类型在 manifest 生效后工具集与当前完全一致（回归验证）

## 非目标

- **N1**：不做 prompt/skill 路由——研究 doc Q2 明确「软能力路由与硬路由各自演进」，本 F 只管代码工具（24+3 个），prompt/skill 路由留后续
- **N2**：不做运行时热加载——manifest 变更需重启生效（研究 doc Q3 的简单方案：下次 invoke 生效 = restart）
- **N3**：不做能力组粒度——研究 doc Q1 提出 per-tool vs per-group 两种粒度，本 F 选 per-tool（最灵活），per-group 能力留待实验框架设计时引入（具体方案：manifest 增加可选 `groups` 字段，loader 先展开 groups 再展开 tools）
- **N4**：不做 config 能力块（A5）——那是独立的后续工作

## 方案设计

### 核心概念

```
otter-type (e.g. "big", "small", "review")
    ↓ 声明式映射
tool-manifest (JSON: { "big": [...all], "small": [...subset] })
    ↓ 运行时加载
getToolNamesFromManifest(manifest, otterType, allToolNames) → string[]
    ↓ 工具过滤
buildCustomTools(..., allowedNames)
```

### 改动清单

#### 1. 新增 manifest 配置文件

**文件**: `config/tool-manifest.json`

```json
{
  "schemaVersion": 1,
  "defaultType": "big",
  "types": {
    "big": {
      "description": "大獭 - 全功能",
      "tools": "*"
    },
    "small": {
      "description": "小獭 - 去除 otter 管理类",
      "tools": [
        "speak", "yield", "search_memory", "create_linked_resource", "get_memory_detail",
        "get_message", "list_messages", "search_messages", "get_turn_history",
        "get_context", "set_context", "delete_context",
        "search_terminology", "add_terminology",
        "list_artifacts", "update_artifact_status",
        "get_active_participants", "get_html_card_contract",
        "create_scheduled_task", "manage_healing_events",
        "restart_otter",
        "workspace_info", "workspace_list", "workspace_read", "workspace_write",
        "link_memory", "get_related", "unlink_memory",
        "sync_docs"
      ]
    }
  }
}
```

**设计决策**：
- `"*"` 表示全部工具（big otter 不需要逐个列举）。语义：「当前 session 可用的全部工具」——`allToolNames` 由调用方（pi-session-factory）从已注册工具列表传入，loader 在 `"*"` 展开时直接使用该列表
- `schemaVersion` 用于 loader 的 schema 兼容性判断——loader 校验 `schemaVersion === 1`，不匹配时报错并 fallback
- per-tool 粒度（非 per-group），保持最大灵活性。per-group 能力留待实验框架设计时引入
- `defaultType` 作为 fallback（未知类型时使用）

#### 2. 新增 manifest 加载器

**文件**: `src/frameworks/config/tool-manifest-loader.ts`（新建）

```typescript
export interface ToolManifestType {
  description: string;
  tools: string[] | "*";
}

export interface ToolManifest {
  schemaVersion: number;
  defaultType: string;
  types: Record<string, ToolManifestType>;
}

/**
 * 加载 manifest 文件。
 * 错误处理边界：
 * 1. 文件不存在 → 返回 null + warn 日志
 * 2. JSON 解析失败（语法错误）→ 返回 null + error 日志
 * 3. schema 不合规（缺字段/类型错误）→ 返回 null + error 日志
 * 调用方收到 null 后 fallback 到硬编码默认值。
 */
export function loadToolManifest(path: string): ToolManifest | null;

/**
 * 从 manifest 查询指定 otter 类型的工具名列表。
 * @param allToolNames - 由调用方从已注册工具列表传入，"*" 展开时使用
 */
export function getToolNamesFromManifest(
  manifest: ToolManifest,
  otterType: string,
  allToolNames: string[]
): string[];
```

#### 3. 替换 `getOtterToolNamesForType`

**文件**: `src/frameworks/agent/session-helpers.ts`

**改法**：删除 `getOtterToolNamesForType` 中的硬编码数组，改为调用 manifest loader。

**兼容性**：如果 manifest 加载失败（返回 null），fallback 到当前硬编码行为（big=全部，small=子集）。三种错误场景（文件缺失/解析失败/schema 不合规）均 fallback + 日志告警。

#### 4. 修改 `OtterType` 类型定义

**文件**: `src/usecases/ports/otter-config-provider.ts`

**改法**：将 `OtterType` 从联合类型 `'big' | 'small'` 改为 `string`。运行时校验交由 manifest loader + lint 处理，编译期约束让渡给运行时约束——与「声明式配置替代硬编码」的设计意图一致。

```typescript
// before
export type OtterType = 'big' | 'small';

// after
export type OtterType = string;
```

#### 5. 新增 lint 工具

**文件**: `scripts/lint-tool-manifest.mjs`（新建）

**校验项**（三条设计要求的 lint 化）：
1. **工具名存在性**：manifest 中引用的每个工具名必须在 `createTools` 返回的工具列表中存在
2. **类型注册完整性**：DB `otter_type` CHECK 约束中的类型必须在 manifest 中有对应条目（实现策略：解析 `src/frameworks/db/migration.ts` 中的 CHECK 约束，正则匹配 `CHECK(otter_type IN (...))` 模式，提取类型列表）
3. **默认类型存在性**：`defaultType` 必须指向 manifest 中已定义的类型
4. **schemaVersion 校验**：`schemaVersion` 必须为正整数

#### 6. 接入 package.json scripts

```json
"lint:tool-manifest": "node scripts/lint-tool-manifest.mjs"
```

### manifest 变更语义（回答研究 doc Q3）

- **生效时机**：重启后生效（manifest 在 session 创建时加载，运行中 session 不受影响）
- **未知类型 fallback**：使用 `defaultType`（当前为 "big"）
- **新增类型**：只需在 manifest 中添加条目 + DB migration 放行 CHECK 约束
- **删除类型**：manifest 中删除条目，存量 otter 的 fallback 到 defaultType

## 影响范围

| 模块 | 影响 |
|------|------|
| `session-helpers.ts` | 删除硬编码数组，改为 manifest 查询 |
| `pi-session-factory.ts` | 调用方式不变（`getOtterToolNamesForType` 签名不变） |
| `tool-factory.ts` | 不变（createTools 仍然创建全部工具） |
| `otter-config-provider.ts` | `OtterType` 从联合类型改为 `string` |
| DB schema | 不变（`otter_type` CHECK 约束保持 'big' | 'small'） |
| 新增 otter 类型时 | 只改 manifest + DB migration，不改代码 |

## 风险与约束

| 风险 | 缓解 |
|------|------|
| manifest 文件损坏导致启动失败 | 三种错误场景均 fallback + 日志告警 |
| 工具名拼写错误 | lint 阶段拦截 |
| 新增类型但 DB CHECK 未更新 | lint 检查 manifest 与 DB 约束一致性 |
| OtterType 改为 string 后失去编译期保护 | manifest loader + lint 提供运行时保护 |

## 不兼容更新

**[Incompatible]** `OtterType` 从联合类型 `'big' | 'small'` 改为 `string`。依赖 `OtterType` 联合类型特性的代码（如 `if (type === 'big')` 的类型收窄）需要调整。实际上当前代码中 `OtterType` 主要用于配置存储和 metrics 标签，不依赖联合类型特性，影响范围有限。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| manifest 粒度 | per-tool | per-group（检索类/派工类/系统类） | per-tool 更灵活，per-group 可在上层封装（本 F 只做 per-tool 基础设施，group 留待实验框架） |
| manifest 格式 | JSON | YAML | JSON 零依赖、TypeScript 原生支持 |
| 配置位置 | 独立文件 | 内嵌 DB | 独立文件可 lint、可 git 追踪 |
| 软能力路由 | 不做 | prompt/skill 同表声明 | 研究 doc Q2 结论：各自演进 |
| OtterType 约束 | string | 保留联合类型 | 声明式配置的目标要求运行时约束 |

## 验证

### 回归验证（T3）
- 导出当前 big/small 的工具列表
- 加载 manifest 后比对，确保 1:1 一致

### Lint 验证（T2）
- 故意写错工具名 → lint 报错
- 缺少类型条目 → lint 报错
- schemaVersion 缺失 → lint 报错

### 集成验证
- 创建 big otter → 拥有全部工具
- 创建 small otter → 只有子集工具
- 重启后行为不变

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `config/tool-manifest.json` | 新建 | 声明式工具路由配置 |
| `src/frameworks/config/tool-manifest-loader.ts` | 新建 | manifest 加载与查询（含三种错误场景 fallback） |
| `src/frameworks/agent/session-helpers.ts` | 修改 | 替换硬编码为 manifest 查询 |
| `src/usecases/ports/otter-config-provider.ts` | 修改 | `OtterType` 从联合类型改为 `string` |
| `scripts/lint-tool-manifest.mjs` | 新建 | manifest 校验工具（含 migration SQL 解析） |
| `package.json` | 修改 | 接入 lint script |
| `tests/frameworks/config/tool-manifest-loader.test.ts` | 新建 | 单元测试 |
