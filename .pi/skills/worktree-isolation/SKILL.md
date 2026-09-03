---
name: worktree-isolation
description: >-
  Precondition: MUST trigger BEFORE modifying or committing any git-tracked file.
  Use when: 准备提交任何 git 追踪文件（代码、文档、配置、lockfile）.
  Not for: 非 git 追踪文件（memory、.env、local config）. 功能开发 → code-implementation.
  Output: worktree + commit（按提交模板）+ 特性文档（docs/features/）+ PR 链接交搭档.
co_loads: []
category: technique
---

# Worktree Isolation

一切改动 git 追踪文件的提交操作，必须在 worktree 中完成。

## 触发

**触发条件**：准备提交任何 git 追踪文件（代码、文档、配置、lockfile）时。

**排除**：非 git 追踪文件（memory、.env、local config）。功能开发 → `code-implementation`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 任务描述 | 是 | 停下来问搭档 |
| 涉及文件类型 | 否 | 推断是否为 git 追踪文件 |

## 工作流

1. **验证环境**：`git rev-parse --show-toplevel` + `pwd`，确认是否已在 `.claude/worktrees/` 下。已在则跳到 step 2。
2. **认领协议（防跨对话撞车，F20260901cimp）**：任务对应 GitHub issue 编号时，创建 worktree 前必须执行——多条对话线（定时任务/手动对话/派工）可能同时盯上同一 issue（#665/#679 撞车实证）。
   - **开工三问**（按序检查，任一命中即停手核实）：
     1. 认领检查：`gh issue view <N> --json comments` 搜 `otter-claim` 标记——已有他人认领且无 release → 换目标，不抢
     2. 在途 PR：`gh pr list --state open --search "<N>"`——已有 open PR 引用该 issue → 换目标
     3. worktree 现场：`git worktree list` 有相关目录 → **零 commit ≠ 废弃**（唯一合法结论是「可能正在开工」，禁止据此接手）；确需判断时看目录 mtime（<48h 视为在途）
   - **认领动作**：三问通过后立即在 issue 发认领评论（人可读 + 机器可 grep 双层结构，评论永不删除）：
     ```
     🦦 认领 #<N>
     <!-- otter-claim: conversation=<对话短ID>; otter=<名号>; worktree=<worktree名>; at=<ISO时间> -->
     开工：<一句话任务>
     ```
   - **回读退场**（协议核心，不可省略）：发完认领评论后**立即回读全部评论**——存在更早的他人 otter-claim 且无 release → 自己输，直接退场换目标，不发难。回读是把「评论无原子性」补成秒级可裁决的关键一步（两线几秒内并发认领，靠 GitHub 服务端时间戳定胜负）。**回读硬门（PR #690 检视发现 1/2）**：回读工具调用失败或结果异常 → 不得继续开工，停手报告大獭处置（跳过回读 = 协议失效，等效无协议开工）；回读时发现自身认领评论缺失 → 同样停手核实，禁止当作「无认领」继续（评论被删 = 审计轨迹被破坏）。
   - **放弃认领**：发 `<!-- otter-claim-release: conversation=<对话短ID> -->` + 原因说明。
   - **双 PR 仲裁**（最坏情况已并存）：时间序优先（PR createdAt 不可伪造）；质量明显更优可升级搭档裁决；被弃方 close 并在关闭评论留判定依据（#665 先例模板）。
3. **创建 worktree**：`git worktree add .claude/worktrees/<name> -b <branch-name> origin/main`。失败时报告搭档，由搭档决定继续或中止。worktree 是特性开发的独立空间，特性文档（`docs/features/`）也在这里。
4. **在 worktree 内提交**：所有改动和验证在 worktree 内进行，主目录只读。生成特性 ID 前必须先跑 `date` 取当前日期，禁止凭印象标日期（#422）；**新 ID 必须先查重**：`grep -rl '<title 或主题关键词>' docs/features/ docs/research/`，存在同 title 或语义相同的文档则复用原 ID——自编新 ID 会让旧 ID 的 chunk 残留 memory 库形成重复污染（#524）。标题搜不到时改用主题关键词重试，仍无命中才可自编新 ID。按提交模板 commit，署名按 signature-convention skill。**特性文档（docs/features/F*.md）是默认交付物**（#443）：与改动同 worktree 提交。**特性文档约定**（原 _shared/ 全局约定，拆解后内联，F20260903）：特性文档是特性开发的全流程载体，贯穿探索、分析、设计、实现、审视各阶段——
   - **位置**：worktree 中（`<worktree>/docs/features/<yyyy>/<mm>/<dd>/F<date><id>-<title>.md`），随代码一起提交到 PR
   - **协调**：首次写入时用 `create_linked_resource(type: "file", groupId: "<特性ID>")` 注册（groupId 可选），所有参与者通过 `list_artifacts` 发现并追加
   - **时机**：当有需要记录的内容时就记录——各 skill 中的「写入特性文档」步骤是建议性的，不是强制检查点
   - **角色**：任何参与者（大獭/小獭）都可以创建和更新特性文档，无角色约束
   - **格式**：参考 docs/features/ 下已有文档的 frontmatter。核心字段：`id`、`title`（人类可读描述，不用英文 slug——slug 放文件名，#470）、`summary`、`change_type` + `capability_test`（change_type 为 feature/prompt 时声明，指向 `tests/capability/` 用例或 `n/a: 理由`）+ `created_in_conversation`；可选 `doc_type`/`causal_links`/`tags`/`modules`/`created_at`；新文档不写 `status` 字段（F20260902sigm）
   - **入库与关系**：写完/改完文档后调 `sync_docs`（root_dir 传 worktree 绝对路径）立即入库，并用 `link_memory` 声明"当前讨论 produced 本文档"；`created_in_conversation` 填当前对话 ID**历史文档不可变（铁律 F20260831dgim）**：`git log --oneline -- <file>` 已在 main 出现过的特性/研究文档，禁止 M/D——后续变更一律新建文档记录（frontmatter from/supersedes 关联前文），pre-commit 的 lint-historical-docs 机械拦截，结构性迁移用 `BYPASS_HISTORICAL_DOC_LINT=1` 并在特性文档记录理由。
5. **推送并创建 PR**：`git push -u origin <branch>` + `gh pr create`，PR 链接交给搭档。自己创建的 feature 分支 rebase 后需重写推送时，用 `git push --force-with-lease`——R1 第 4 条对此放行且无需确认（出处 #468）；受保护分支的 force push 仍禁止，见 SYSTEM.md 红线。

> 红线在 SYSTEM.md "仓库安全红线" 中全局定义，本流程严格遵守。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 特性文档（docs/features/F*.md，与改动同 worktree 提交） | 随 PR 接受对抗审视 B2 文档完整性检核 | 检视獭 |
| PR（小改动） | 搭档终审 | 搭档 |
| PR（功能开发） | 对抗审视 | 检视獭 |
| commit 失败 | 诊断修复 | 当前獭 |

**小改动**（可走简化审视，仅查 B1-B4）：
- lockfile 更新
- 纯配置值修改（版本号、环境变量默认值，不涉及逻辑变更）
- 文档订正（错别字、链接、格式，不涉及设计决策）

一切其他改动 → 走 `code-implementation` 全流程（含对抗审视）。
归属模糊时默认从严。

## 参考（索引）

- 署名按 signature-convention skill — 步骤 4 使用
