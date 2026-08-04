---
id: F20260803frmt
title: frontmatter-backfill
doc_type: feature

summary: |
  为 4 个直接以 markdown 标题开头、缺 YAML frontmatter 的特性文档补齐元信息（issue #124 Task D）。
  缺 frontmatter 的文档在启动同步时被跳过（磁盘 85 个 F 文档，features 表仅 46 条）。
  本补丁从 git commit message 确认各文档规范 ID（文件名前缀有截断），补全
  id/title/doc_type/summary/status/change_type/tags/modules/created_at/causal_links，
  顺手修正标题里的截断 ID。经对抗检视修正 stab 文档 modules 路径错误。

causal_links:
  from:
    - F20260721x7k3   # docs-format-sync：同步系统要求 frontmatter，本补丁为缺漏文档补齐

status: final
change_type: fix
tags: [docs, frontmatter, metadata, bugfix, sync, issue-124]
modules:
  - docs/features/2026/07/29/F20260729c113-code-quality-fix.md
  - docs/features/2026/07/29/F20260729im-lobby-feishu-integration.md
  - docs/features/2026/08/01/F20260801agent-stability-batch-fix.md
  - docs/features/2026/08/02/F20260802hybrid-architecture.md

created_at: 2026-08-03
---

# F20260803frmt 补齐特性文档缺失的 frontmatter

## 背景

issue #124 在测试记忆搜索时发现 4 个特性文档完全没有 YAML frontmatter，直接以 markdown 标题开头。启动时 `sync-documents` 跳过这些文档，导致 `features` 表缺记录（磁盘 85 个 F 文档，表内仅 46 条；启动日志 `{"synced":0,"skipped":46,"errors":41}`）。

issue 拆为 4 个并行任务（A/B/C/D），本补丁是 Task D：补齐缺 frontmatter 的文档。

## 问题清单

全量扫描 `docs/features/**/*.md` 与 `docs/research/*.md`，确认仅以下 4 个文档缺 frontmatter：

| 文件 | 规范 ID（来自 commit message） | change_type |
|------|-------------------------------|-------------|
| `F20260729c113-code-quality-fix.md` | F20260729c113 | bugfix |
| `F20260729im-lobby-feishu-integration.md` | F20260729imlo | feature |
| `F20260801agent-stability-batch-fix.md` | F20260801stab | bugfix |
| `F20260802hybrid-architecture.md` | F20260802hybr | feature |

### 根因

1. **文档作者遗漏**：4 个文档提交时未带 frontmatter，直接以 `# 标题` 开头
2. **文件名前缀截断**：文件名中的 ID 前缀有截断（如 `F20260729im-...` 实际 ID 是 `F20260729imlo`），标题里也用了截断值，造成文件内 ID 不一致
3. **无前置校验**：提交时没有 hook 校验 frontmatter，问题沉淀到运行时才暴露

## 修复

### 1. 补齐 frontmatter

为 4 个文档补全字段：`id/title/doc_type/summary/status/change_type/tags/modules/created_at`，stab 文档额外补 `causal_links`。

- **ID 确认**：从 `git log --diff-filter=A` 的 commit message 确认每个文档的规范 ID（文件名前缀不可靠）
- **4 个 ID 均符合严格正则** `F\d{8}[a-z0-9]{4}`，无需等 Task A 放宽正则
- **summary**：从文档正文概括，长度 1-500，覆盖关键信息（为 Task B 正文索引前的 summary 检索也有价值）
- **change_type/status**：与正文标注一致，与仓库惯例一致（main 上已有 16 个 `bugfix`、8 个 `final`）

### 2. 修正标题里的截断 ID

3 个文档标题使用了截断/错误的 ID，顺手修正为规范 ID：

| 文件 | 标题 ID 修正 |
|------|-------------|
| imlo | `F20260729im` -> `F20260729imlo` |
| stab | `F20260801` -> `F20260801stab` |
| hybr | `F20260802hybrid-architecture` -> `F20260802hybr` |

同一文件内 frontmatter.id 与标题 ID 应一致，故此修正属于元信息一致性范畴，非 scope creep。

### 3. 对抗检视修正

拉独立 agent 对 PR #125 做对抗检视，发现并修复 `F20260801stab` 文档 modules 字段问题：

- **2 个路径错误**：`agent-invoker.ts` 实际在 `interface-adapters/agent-runtime/`（原误写 `frameworks/agent/`）；`sqlite-conversation-repository.ts` 缺 `conversation/` 子目录
- **2 个遗漏模块**：正文修复表明确提到的 `api-contract/sse/events.ts`、`src/frameworks/config-service.ts`
- 补 `causal_links`：发言名字显示问题是 `F20260724regd`（sender-name-projection）的回归

## 与其他任务的关系

- **Task A（放宽 validator 枚举）**：软依赖。`change_type: bugfix` / `status: final` 不在当前 validator 允许列表，需 Task A 合入后本补丁的值才通过校验。文件不重叠（A 改 `frontmatter-validator.ts`，本补丁改 docs）
- **Task B（索引正文）**：本补丁让 4 个文档入库后，Task B 的正文索引才有意义
- **Task C（embedding）**：完全独立

## 验收

- 4 个文档都有合法 frontmatter（`yaml.parse` 通过）
- id/title/summary/文件路径校验全部通过
- 唯一 validator 失败项是 `status: final` / `change_type: bugfix`（预期，待 Task A）
- 全量扫描确认无遗漏
