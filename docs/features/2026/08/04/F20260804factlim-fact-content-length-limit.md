---
id: F20260804factlim
title: fact-content-length-limit
doc_type: feature

# 记忆索引
summary: |
  fact 类型 linked_resource 的 content 字段限制为 ≤500 字符。
  工具描述引导 AI 将长内容写入文件后创建 file 类型资源。
  list_artifacts 返回的 content 截断为 ≤200 字符预览。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260720n5p1   # merge-key-fact-into-resource（fact 作为 LinkedResource 存储）

# 元数据
status: development
change_type: feature_update
tags: [linked-resource, fact, content-limit, context-window]
modules: [src/interface-adapters/agent-runtime/tools/, src/usecases/conversation/]

# 时间
created_at: 2026-08-04
---

## 问题背景

fact 类型的 `content` 字段无长度限制，AI 倾向于将大段设计文档、方案文本直接写入 content，
导致两个问题：

1. **上下文膨胀**：`list_artifacts` 将所有 fact 的完整 content 注入对话上下文，
   多个长 fact 占用大量 token 预算
2. **UI 体验差**：artifact 列表中显示大段文本块，视觉噪音大

## 设计决策

### D1: fact content ≤500 字符硬限制

**决策**：fact 类型资源的 content 字段限制为 500 字符，超过则拒绝创建并提示正确用法。

**理由**：
- 500 字符足以容纳一条关键决策摘要、结论或要点
- 硬限制比软提示更可靠——AI 可能忽略描述中的建议，但无法绕过代码校验
- 不影响 file/url/pr/branch/worktree 类型资源

### D2: 双层校验——工具层 + 业务层

**决策**：
- 工具层（`tool-factory.ts`）：`create_linked_resource` 的 execute 函数中，
  fact content > 500 时直接返回错误提示，不调用业务层
- 业务层（`manage-key-info.ts`）：`validateInput` 方法中增加相同校验，作为兜底

**理由**：
- 工具层校验提供即时反馈，避免不必要的业务层调用
- 业务层校验是安全网，防止绕过工具直接调用 API 的场景
- 两层校验逻辑一致，错误消息一致

### D3: 工具描述引导 AI 行为

**决策**：在 `create_linked_resource` 工具描述和 content 参数描述中，
明确说明 fact 的用途（简短摘要/关键决策）和长内容的正确处理方式（先写文件再创建 file 资源）。

**理由**：
- 预防优于治疗：引导 AI 从一开始就选择正确路径
- 工具描述是 AI 选择工具参数的主要依据
- 双重提示（总描述 + 参数描述）确保 AI 不遗漏

### D4: list_artifacts content 截断 ≤200 字符

**决策**：`list_artifacts` 返回的 content 字段截断为 200 字符，附加 "…(已截断)" 标记。

**理由**：
- 即使 fact content ≤500，在 list 上下文中多个 fact 累积仍可能膨胀
- 200 字符足够 AI 了解内容主题，需要完整内容时可通过 get_memory_detail 获取
- 截断标记让 AI 知道内容不完整，避免误解

### D5: 不做历史数据迁移

**决策**：仅对新创建的 fact 资源执行长度校验，已有的长 fact 不做截断或迁移。

**理由**：
- 现有长 fact 已被索引和引用，强制截断可能破坏关联
- 历史数据会随对话生命周期自然淘汰
- 新规则从本次部署起生效，影响范围可控

## 实现方案

### 工具层（tool-factory.ts）

- `description`：追加 "fact 用于简短摘要/关键决策（≤500 字符）。长内容（方案、设计文档等）必须先用 write 写入文件，再创建 file 类型资源指向文件路径。"
- `content` 参数描述：改为 "事实文本内容（fact 必填，≤500 字符的简短摘要）"
- `execute` 函数：fact 分支中，content 非空后增加 `content.length > 500` 判断，
  返回错误消息引导写文件

### 业务层（manage-key-info.ts）

- `validateInput` 方法：fact 分支中，content 非空校验后增加 `input.content.length > 500` 判断，
  抛出 Error 引导写文件

### 展示层（artifact-tools.ts）

- `createListArtifactsTool`：返回的 content 字段增加长度判断，
  `r.content.length > 200 ? r.content.slice(0, 200) + "…(已截断)" : r.content`

### 测试（manage-key-info.test.ts）

- 新增："throws when fact content exceeds 500 characters"
- 新增："creates fact resource with content at exactly 500 characters"

## 涉及文件

| 层 | 文件 | 改动类型 |
|---|---|---|
| Tool | `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改（description + 前端校验） |
| Tool | `src/interface-adapters/agent-runtime/tools/artifact-tools.ts` | 修改（content 截断） |
| Use Case | `src/usecases/conversation/manage-key-info.ts` | 修改（validateInput 校验） |
| Test | `tests/usecases/manage-key-info.test.ts` | 修改（新增 2 个测试用例） |

## 已知问题

- `tool-factory.ts` 已有 505 行，超出 ESLint 450 行限制（原始文件已 501 行，pre-existing tech debt）
- 未在 DB schema 层增加 CHECK 约束（SQLite TEXT 列无原生长度限制，依赖应用层校验）

## 验证清单

- [x] fact content ≤500 → 成功创建
- [x] fact content = 500 → 成功创建（边界）
- [x] fact content = 501 → 拒绝并提示写文件
- [x] file 类型资源 → 不受影响
- [x] list_artifacts 长 content 被截断为 200 字符
- [x] 全量测试 952 个通过（`npm test`）
