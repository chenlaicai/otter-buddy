---
name: code-implementation
description: >-
  Turn a technical plan into runnable, verifiable code changes.
  For ANY repository mutation, SYSTEM.md red lines always apply.
triggers:
  phrases:
    - "写代码"
    - "实现这个功能"
    - "开始开发"
    - "编码实现"
    - "写测试"
    - "按方案开发"
    - "开干"
    - "开始写"
co_loads: []
---

# Code Implementation

把技术方案变成可运行、可验证的代码变更。

## 触发

**触发条件**：搭档要求按方案实现功能、写代码、写测试时。

**排除**：无方案的需求分析 → `requirement-analysis`。小改动（lockfile、配置）→ `worktree-isolation`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 技术方案（搭档确认后） | 是 | 停下来问搭档。禁止自行编造方案 |
| 方案编号 | 是 | 从方案文档 frontmatter 读取 |
| 工作分支 | 是 | 先走 worktree-isolation 创建 worktree |

## 工作流

1. **准备环境**：执行 `worktree-isolation` 最小流程创建 worktree。记录 worktree 名、分支名、特性编号。
2. **确认理解**：通读方案，确认涉及的文件和模块、核心逻辑、是否有破坏性变更。用 `search_terminology` 确认术语。不清楚就问，不猜。不在方案内的功能不实现。
3. **实现**：按方案逐步实现。遵守项目架构约束。匹配项目术语。非显而易见的设计意图加注释。
4. **写测试**：为新增或修改的行为写测试。见 `references/testing-rules.md`。测试失败时先诊断：是测试错还是实现错？不自动回退业务代码。
5. **自检**：测试通过、符合项目规范、无方案外变更、无兼容桥代码、视觉变更有截图证据、发现的问题全部修复。
6. **提交**：按 `references/commit-convention.md` 格式 commit，署名见 `_shared/signature-convention.md`。
7. **推送 PR**：`git push -u origin <branch>` + `gh pr create`。
8. **对抗审视**：按 `_shared/review-protocol.md` 中的"代码 PR 审视协议"执行。

> **问题处理**：方案范围内的问题 → 立即修复，不问"要不要修"。相关模块的顺手修复（≤5 个）→ 修复并在 PR 描述记录。无关问题 → 必须记录（创建 issue + PR 描述），不能静默丢失。检视獭报上来的发现 → 走 review-protocol 作者处置协议，带证据的反驳是合法处置。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 代码 PR | 对抗审视 | 检视獭 |
| 排查结论（需修复） | worktree-isolation | 当前獭 |

## 参考

- `references/testing-rules.md` — 行为契约测试
- `references/coding-principles.md` — 架构约束和命名规范
- `references/commit-convention.md` — 提交格式
- `_shared/signature-convention.md` — 署名约定
- `_shared/review-protocol.md` — 对抗审视协议
