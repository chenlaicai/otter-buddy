---
name: code-implementation
description: >-
  Use when: 搭档要求按方案实现功能/写代码/写测试.
  Not for: 无方案的需求分析 → requirement-analysis. 小改动（lockfile、配置、文档订正）→ worktree-isolation.
  Output: 代码 PR + 特性文档（含测试、自检通过、对抗审视通过），呈搭档终审.
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
| 特性文档 | 否 | 通过 `list_artifacts` 查找；不存在则步骤 7 创建

## 工作流

1. **准备环境**：执行 `worktree-isolation` 最小流程创建 worktree。记录 worktree 名、分支名、特性编号。
2. **确认理解**：通读方案，确认涉及的文件和模块、核心逻辑、是否有破坏性变更。用 `search_terminology` 确认术语。不清楚就问，不猜。不在方案内的功能不实现。
3. **预检查**：动手实现前，先检查相关测试断言和设计意图——尤其是权限白名单、配置约束、接口契约等易冲突区域。用 `grep` 扫描测试文件中的 `expect`/`not.toContain` 断言，识别潜在冲突。发现冲突时自行分析设计意图并给出建议方案，不把问题抛给用户。
4. **实现**：按方案逐步实现。遵守 `references/coding-principles.md` 中的架构约束和命名规范。匹配项目术语。非显而易见的设计意图加注释。
5. **写测试**：为新增或修改的行为写测试。见 `references/testing-rules.md`。测试失败时先诊断：是测试错还是实现错？不自动回退业务代码。
6. **自检**：测试通过、符合项目规范、无方案外变更、无兼容桥代码、视觉变更有截图证据、发现的问题全部修复。

   **pre-existing 声明硬门禁（#614）**：自检报告中的任何「pre-existing / 与本次变更无关」的测试失败声明，必须附验证证据——`git stash -u`（含未跟踪文件，防新增测试残留致假验证）后基线复跑输出，或基于 `origin/main` 的基线对照输出。无证据 = 未验证，不得写入自检报告（8/30 #599 现场：5 个自引入失败被误报为与己无关，靠大獭人工核实才兜住）。

   **最简实现检查**（必答，结论记入特性文档「验证」节）：此方案能否用更少代码/文件/依赖达成同等效果？先过一道阶梯——仓库已有实现 → stdlib/平台原生 → 已装依赖 → 才写新代码（思想源 R20260828pntr §0：LLM 天然偏好过度建设，"我要一个函数，它给我一个框架"）。发现更简实现且不改语义 → 采简弃繁；确认已最简 → 在验证节记"已过最简检查"。

   **Golden Gate 自检（软代码改动必须）**：
   - **触发条件**：本次变更涉及 prompt/skill/协议层（软代码）时，必须跑 golden gate
   - **执行**：在 worktree 内运行 `npm run test:capability` 或 `npx vitest run --config vitest.capability.config.ts`
   - **记录留存**：results.jsonl 会自动写入主仓根 `data/metrics/golden-results.jsonl`（P0-b 修通后）
   - **fail 处置闭环**（v6.3，glm-flash 发现 5）：
     - 单场景 fail → 实现者复跑一次，复跑通过则记后续通过记录
     - 连续两次 fail → 修问题再跑，直至通过
     - 无法修复 → 走申诉留痕决议（在 PR 描述中说明理由）
   - **复跑主体 = 实现者**（生产方职责），检视獭不重复跑

   **CI 验证（必须）**：
   - 推送 PR 后，等待 CI 运行完成：`gh run watch`
   - CI 失败时立即诊断修复——检视也会将 CI 失败标记为严重发现

7. **文档**：将实现要点、变更说明写入本特性的文档——**新建追加，不改历史**（铁律 F20260831dgim）：本特性已有文档（本分支/本 PR 内创建）则追加；否则新建 `docs/features/` 文档记录，包括「本次变更对旧特性做了什么」也写在新文档里，回改已合入的历史文档一律禁止（参见全局约定「特性文档」；pre-commit 的 lint-historical-docs 会机械拦截）。写完/改完文档后调 `sync_docs`（root_dir 传 worktree 绝对路径）立即入库，并用 `link_memory` 声明"当前讨论 produced 本文档"——让"这文档怎么来的"之后可被 get_related 拼出链。

   **Intent 块生成（软代码改动必须）**：
   - **触发条件**：本次变更涉及 prompt/skill/协议层（软代码）时，特性文档 frontmatter 必须生成 intent 块
   - **格式**：在 frontmatter 中添加 `intent` 字段，包含 `problem`（要解决什么问题）和 `verify_by`（如何验证，如 `golden_gate`、`capability_test`、`manual_review`）
   - **n/a 须附理由**：如果 verify_by 填 n/a，必须附理由说明为什么不需要验证
   - **示例**：
     ```yaml
     intent:
       problem: "海獭在召唤小獭前不搜记忆，违反 R4 约束"
       verify_by: "golden_gate"
     ```
   - **目的**：让评测机制知道这个变更需要什么验证方式，是 golden gate 的输入信号

8. **提交**：生成特性 ID 前必须先跑 `date` 取当前日期，禁止凭印象标日期（#422）；**新 ID 必须先查重**：`grep -rl '<title 或主题关键词>' docs/features/ docs/research/`，存在同 title/语义相同的文档直接复用原 ID——跨 worktree 自编新 ID 会造成旧 ID chunk 残留、污染 memory 召回（#524）；标题搜不到时改用主题关键词重试，仍无命中才可自编。按 `references/commit-convention.md` 格式 commit，署名见 `_shared/signature-convention.md`。
9. **推送 PR**：`git push -u origin <branch>` + `gh pr create`。

> ⚠️ PR 创建 ≠ 交付完成。步骤 9 完成后必须立即进入步骤 10。

10. **对抗审视**（流程细节：审视者产出校验、delta 审视、收敛判据，见 `_shared/review-protocol.md`）：
   > 小獭没有 create_otter 能力，无法自行召唤检视獭。小獭完成代码后，将产出（PR 链接、worktree 路径、测试结果）交回大獭，由大獭编排对抗审视。

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
| 特性文档（docs/features/F*.md，步骤 7） | 随 PR 接受对抗审视 B2 文档完整性检核 | 检视獭 |
| 代码 PR | **对抗审视（必须）** | 检视獭 |
| 审视通过 | 呈搭档终审 | 搭档 |
| 排查结论（需修复） | worktree-isolation | 当前獭 |

## 参考（索引）

- `references/testing-rules.md` — 步骤 5 使用
- `references/coding-principles.md` — 步骤 4 使用
- `references/commit-convention.md` — 步骤 8 使用
- `_shared/signature-convention.md` — 步骤 8 使用
- `_shared/review-protocol.md` — 步骤 10 使用
- `adversarial-review/references/author-response-protocol.md` — 步骤 10 使用
