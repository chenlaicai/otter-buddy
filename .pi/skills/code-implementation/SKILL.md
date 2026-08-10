---
name: code-implementation
description: >-
  Turn a technical plan into runnable, verifiable code changes.
  For ANY repository mutation, SYSTEM.md red lines always apply.
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
8. **对抗审视**：
   - 召唤检视獭（`otter-summon`），systemPrompt 中附上：`gh pr diff` 全文、worktree 绝对路径、测试与构建结果（标注为实现者自报）。要求其先 read `adversarial-review` skill
   - 收到报告后校验合规性（含"本轮焦点"声明、发现分级、file:line 引用）——不合规打回重做
   - 按 `adversarial-review/references/author-response-protocol.md` 逐条处置：接受并修复 / 反驳（必须附证据）/ 部分接受 / 呈搭档裁决
   - 修复后更新 PR，重新审视。第 2 轮起是 delta 审视（附上轮发现清单 + 处置 + 修复 diff）
   - 收敛判据：修复验证全部通过 + 无阻断回归 → 通过；对立僵局 / 移动靶 / 僵尸循环 → 呈搭档裁决
   - 审视通过 → 呈搭档终审

### 问题处理

发现问题后，按以下流程处理：

1. 问题在方案范围内？ → 立即修复，不问"要不要修"
2. 问题与当前变更相关（同一模块/文件/函数）？
   - 相关 + 数量 ≤ 5 → 顺手修复，PR 描述中记录
   - 相关 + 数量 > 5 → 记录到 PR 描述，审查者决定是否拆分 PR
3. 问题与当前变更无关？ → 必须记录，不能静默丢失：创建 issue（带标签：tech-debt / bug），PR 描述中记录发现的问题和对应 issue 编号

检视獭报上来的发现不适用上述规则 → 走 review-protocol 作者处置协议，带证据的反驳是合法处置。

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
