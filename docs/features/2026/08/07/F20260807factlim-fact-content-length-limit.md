---
id: F20260807factlim
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
created_at: 2026-08-07
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

**计量口径**：「字符」= JS `String.length`（UTF-16 code unit）。中文（BMP）1 字 = 1；
emoji 等增补平面字符 1 个可见字 = 2，实际限额对其收紧。收紧方向无安全危害，故不额外做码位换算。

**理由**：
- 500 字符足以容纳一条关键决策摘要、结论或要点
- 硬限制比软提示更可靠——AI 可能忽略描述中的建议，但无法绕过代码校验
- 不影响 file/url/pr/branch/worktree 类型资源

### D2: 双层校验——工具层 + 业务层，口径同源

**决策**：
- 工具层（`tool-factory.ts`）：`create_linked_resource` 的 execute 函数中，
  fact content 超限时直接返回错误提示，不调用业务层
- 业务层（`manage-key-info.ts`）：`validateInput` 方法中做相同校验，作为兜底
- 两层共用同一组常量（`FACT_CONTENT_MAX_LENGTH` / `FACT_CONTENT_TOO_LONG_MESSAGE`，
  定义于 usecase 层，工具层导入），保证边界值与错误消息**同源一致**；
  工具层按工具响应约定附加 `[错误] ` 前缀
- 空白处理两层一致：纯空白 content 均被拒绝

**理由**：
- 工具层校验提供即时反馈，避免不必要的业务层调用
- 业务层校验是安全网，防止绕过工具直接调用 API 的场景
- 共享常量消除「两份文案漂移」风险（检视发现初版两层消息不一致）

### D3: 工具描述引导 AI 行为

**决策**：在 `create_linked_resource` 工具描述和 content 参数描述中，
明确说明 fact 的用途（简短摘要/关键决策）和长内容的正确处理方式（先写文件再创建 file 资源）。

**理由**：
- 预防优于治疗：引导 AI 从一开始就选择正确路径
- 工具描述是 AI 选择工具参数的主要依据
- 双重提示（总描述 + 参数描述）确保 AI 不遗漏

### D4: list_artifacts content 截断 ≤200 码位

**决策**：`list_artifacts` 返回的 content 字段截断为 200 个码位（code point），
附加 "…(已截断)" 标记。截断按码位（`Array.from`）而非 UTF-16 code unit 切片，
避免 `slice()` 切断 emoji 代理对产生乱码。

**理由**：
- 即使 fact content ≤500，在 list 上下文中多个 fact 累积仍可能膨胀
- 200 码位足够 AI 了解内容主题，需要完整内容时可通过 get_memory_detail 获取
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

- 导出共享常量 `FACT_CONTENT_MAX_LENGTH` / `FACT_CONTENT_TOO_LONG_MESSAGE`
- `validateInput` 方法：fact 分支中，content 非空校验（含纯空白拒绝）后增加长度判断，
  抛出共享消息

### 展示层（artifact-tools.ts）

- `createListArtifactsTool`：content 经 `truncateContentPreview` 处理——
  按码位截断至 200，超附 "…(已截断)"，代理对安全

### 测试

- `tests/usecases/manage-key-info.test.ts`：超限拒绝 + 恰好 500 通过（既有）
- `tests/interface-adapters/create-linked-resource-tool.test.ts`（新增）：
  工具层 501 拒绝且不调用 `resource.link`；500 正常创建
- `tests/interface-adapters/artifact-tools.test.ts`（新增）：
  截断 + 标记、短内容不截、emoji 代理对不切断、码位/code unit 边界

## 涉及文件

| 层 | 文件 | 改动类型 |
|---|---|---|
| Tool | `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改（description + 前端校验，引用共享常量） |
| Tool | `src/interface-adapters/agent-runtime/tools/artifact-tools.ts` | 修改（content 码位安全截断） |
| Use Case | `src/usecases/conversation/manage-key-info.ts` | 修改（共享常量 + validateInput 校验 + 空白对齐） |
| Test | `tests/usecases/manage-key-info.test.ts` | 修改（新增 2 个测试用例） |
| Test | `tests/interface-adapters/create-linked-resource-tool.test.ts` | 新增（工具层校验 2 例） |
| Test | `tests/interface-adapters/artifact-tools.test.ts` | 新增（截断 4 例） |

## 已知问题

- ~~`tool-factory.ts` 超出 ESLint 450 行限制~~：main 已用 `/* eslint-disable max-lines */`
  豁免注释处理（本分支已合并 main，lint 实测通过）
- 用例层输入校验抛 plain `Error`，经 HTTP API 返回 500 而非 400——既有约定，
  统一整改见 issue #169
- 未在 DB schema 层增加 CHECK 约束（SQLite TEXT 列无原生长度限制，依赖应用层校验）

## 验证清单

- [x] fact content ≤500 → 成功创建
- [x] fact content = 500 → 成功创建（边界，工具层 + 业务层各有测试）
- [x] fact content = 501 → 拒绝并提示写文件（工具层测试断言不调用 `resource.link`）
- [x] 纯空白 content → 工具层 + 业务层均拒绝
- [x] file 类型资源 → 不受影响
- [x] list_artifacts 长 content 截断为 200 码位 + 标记（自动化测试）
- [x] emoji 代理对不被截断切断（自动化测试）
- [x] 全量测试 1059 个通过、lint 0 error（合并 main 后实测，2026-08-06）
