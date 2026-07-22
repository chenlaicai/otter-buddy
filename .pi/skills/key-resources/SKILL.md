---
name: key-resources
description: 关键资源管理策略。定义何时以及如何创建、查询和管理链接资源（artifacts）。
---

# 关键资源管理（Key Resources）

管理对话中的链接资源（artifacts）生命周期。

## 核心原则

**重要的东西要记录。** 产生的 PR、分支、决策事实等关键产出，必须通过 `create_linked_resource` 记录到产物清单中。

## 资源类型

| 类型 | 用途 | 必填字段 |
|------|------|----------|
| `fact` | 文本事实（决策记录、设计要点） | `content` |
| `pr` | Pull Request 链接 | `url` |
| `worktree` | 工作树路径 | `url` |
| `branch` | Git 分支 | `url` |
| `file` | 文件路径 | `url` |
| `url` | 通用 URL（默认） | `url` |

**关键规则**：`fact` 类型必须提供 `content`，其他类型必须提供 `url`。工具会校验这些必填字段。

## 何时创建资源

### 必须创建的场景

1. **创建 PR 后**：记录 PR 链接
2. **创建分支/工作树后**：记录分支路径
3. **重要决策确定后**：以 `fact` 类型记录决策内容
4. **生成关键文件后**：记录文件路径

### 建议创建的场景

1. 参考了外部文档链接
2. 达成了阶段性结论

## groupId 特性分组

使用 `groupId` 将同一特性的多个资源归为一组。

### 命名规范

格式：`F` + 日期 + 序号，例如 `F20260720a1b2`

### 使用场景

- 同一特性的 PR、分支、设计事实应使用相同的 `groupId`
- 用 `list_artifacts` + `groupId` 过滤查看单个特性的所有产物

## 资源生命周期

```
active → superseded（被新版本替代）
active → archived（已归档/已合入）
```

### 状态管理工具

- `list_artifacts`：查询产物清单（支持按 status/resourceType/groupId 过滤）
- `update_artifact_status`：更新产物状态
  - `superseded`：需要提供 `supersededBy`（替代者的产物 ID）
  - `archived`：标记为已归档

### 生命周期规则

1. 创建新版本资源时，旧版本应标记为 `superseded`
2. PR 合入后，相关资源应标记为 `archived`
3. 不要直接删除资源，使用状态管理

## 与记忆系统的关系

创建资源时，系统会自动将其内容索引到记忆系统中。

- `fact` 类型：`content` 字段被索引
- 其他类型：`url` 字段被索引

这意味着后续可以通过 `search_memory` 找到之前创建的资源。

## 查询策略

- **查看产物清单**：`list_artifacts`（快速浏览，结构化）
- **按特性查看**：`list_artifacts` + `groupId` 过滤
- **搜索历史资源**：`search_memory`（全文检索，跨会话）
- **查看资源详情**：`get_memory_detail`（渐进式披露）

## 禁止行为

- 不要遗漏关键产出的记录（PR、重要决策）
- 不要给 `fact` 类型传 `url`，也不要给非 `fact` 类型漏传 `url`
- 不要跳过生命周期管理（创建后不管状态）
- 不要使用无意义的 groupId
