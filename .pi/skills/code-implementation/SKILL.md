---
name: code-implementation
description: >-
  Use when: 搭档要求按方案实现功能/写代码/写测试.
  Not for: 无方案的需求分析 → requirement-analysis. 小改动（lockfile、配置、文档订正）→ worktree-isolation.
  Output: 代码 PR（含测试、自检通过、对抗审视通过），呈搭档终审.
co_loads: []
category: technique
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
| 方案编号 | 是 | 从方案文档或特性文档 frontmatter 读取 |
| 工作分支 | 是 | 先走 worktree-isolation 创建 worktree |
| 特性文档 | 否 | 通过 `list_artifacts` 查找；不存在则跳过

## 工作流

1. **准备环境**：执行 `worktree-isolation` 最小流程创建 worktree。记录 worktree 名、分支名、特性编号。
2. **确认理解**：通读方案，确认涉及的文件和模块、核心逻辑、是否有破坏性变更。用 `search_terminology` 确认术语。不清楚就问，不猜。不在方案内的功能不实现。
3. **实现**：按方案逐步实现。遵守 `references/coding-principles.md` 中的架构约束和命名规范。匹配项目术语。非显而易见的设计意图加注释。
4. **写测试**：为新增或修改的行为写测试。见 `references/testing-rules.md`。测试失败时先诊断：是测试错还是实现错？不自动回退业务代码。
5. **自检**：测试通过、符合项目规范、无方案外变更、无兼容桥代码、视觉变更有截图证据、发现的问题全部修复。

   **CI 验证（必须）**：
   - 推送 PR 后，等待 CI 运行完成：`gh run watch`
   - CI 失败时立即诊断修复——检视也会将 CI 失败标记为严重发现

6. **文档**：将实现要点、变更说明追加到特性文档（参见全局约定「特性文档」）。写完/改完文档后调 `sync_docs`（root_dir 传 worktree 绝对路径）立即入库，并用 `link_memory` 声明"当前讨论 produced 本文档"——让"这文档怎么来的"之后可被 get_related 拼出链。

7. **提交**：按 `references/commit-convention.md` 格式 commit，署名见 `_shared/signature-convention.md`。
8. **推送 PR**：`git push -u origin <branch>` + `gh pr create`。
9. **对抗审视**：
   - 召唤检视獭（`otter-summon`），systemPrompt 中附上：`gh pr diff` 全文、worktree 绝对路径、测试与构建结果（标注为实现者自报）。要求其先 read `adversarial-review` skill
   - 收到报告后校验合规性（含"本轮焦点"声明、发现分级、file:line 引用）——不合规打回重做
   - **对抗审视原则**：检视发现不等于命令。对每条发现必须批判性评估：检视者有 fresh eyes 但上下文浅，作者上下文全但有立场——碰撞才有价值；照单全收等于把检视者的误读原样引入，对抗审视退化为单人审阅；**每条发现强制走决策树——回答"改了让系统变好还是变更差"，更好→修复/建 issue，更差→带证据反驳**；四类处置：接受并修复 / 反驳（必须附证据）/ 部分接受 / 呈搭档裁决；无证据的反驳（"我觉得没问题"、"过度设计"）等同未处置；不作为不允许
   - 按 `adversarial-review/references/author-response-protocol.md` 逐条处置：决策树判断 + 四分类响应（接受并修复 / 反驳 / 部分接受 / 呈搭档裁决）
   - 处置完成后，更新 PR review comment，追加处置结果（含更好/更差判断 + 四分类响应）
   - 更新命令：`gh pr comment <PR_NUMBER> --body "## 处置结果
[逐条处置，含更好/更差判断]"`
   - 修复后更新 PR，重新审视。第 2 轮起是 delta 审视（附上轮发现清单 + 处置（含更好/更差判断）+ 修复 diff + 更新后的 PR 描述，核对 Discovered Issues 节 issue 落实）
   - 收敛判据：修复验证全部通过 + 无严重发现未处置 + 无阻断回归 → 通过；对立僵局 / 移动靶 / 僵尸循环 → 呈搭档裁决
   - 审视通过 → 呈搭档终审

### 问题处理

发现问题后，按以下流程处理：

1. 问题在方案范围内？ → 立即修复，不问"要不要修"
2. 问题与当前变更相关（同一模块/文件/函数）？
   - 相关 + 数量 ≤ 5 → 顺手修复，PR 描述 Discovered Issues 节记录（格式见 `references/commit-convention.md`）
   - 相关 + 数量 > 5 → PR 描述 Discovered Issues 节记录，审查者决定是否拆分 PR
3. 问题与当前变更无关？ → 不能静默丢失：执行 `gh issue create`（带标签 tech-debt / bug），issue 链接写入 PR 描述 Discovered Issues 节（格式见 `references/commit-convention.md`）

检视獭报上来的发现不适用上述规则 → 走 review-protocol 作者处置协议，带证据的反驳是合法处置。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 代码 PR | 对抗审视 | 检视獭 |
| 排查结论（需修复） | worktree-isolation | 当前獭 |

## 参考（索引）

- `references/testing-rules.md` — 步骤 4 使用
- `references/coding-principles.md` — 步骤 3 使用
- `references/commit-convention.md` — 步骤 6 使用
- `_shared/signature-convention.md` — 步骤 6 使用
- `_shared/review-protocol.md` — 步骤 8 使用
- `adversarial-review/references/author-response-protocol.md` — 步骤 8 使用
