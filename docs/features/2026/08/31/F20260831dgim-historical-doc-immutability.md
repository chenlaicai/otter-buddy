---
id: F20260831dgim
title: "历史特性文档不可变：追加新文档，记录变化过程而非最终状态"
summary: 搭档多次口头强调的「特性更新追加新文档、不改历史文档」铁律落地：skill 四处落规 + pre-commit 机械拦截（lint-historical-docs）+ 测试锁定。起因是 PR #607 两次修改历史文档 F20260829cstd 违规（已回滚），根因是规则只存在于口头，整条链路（开发獭/检视獭）无处可拦。
change_type: prompt
status: implemented
created_in_conversation: fe63e059-635f-4387-9dcd-5b685a58e6e8
capability_test: tests/lint-historical-docs.test.ts
from:
  - F20260812fdmc
  - F20260829cstd
tags: [feature-doc, lifecycle, lint, guardrail]
modules:
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/worktree-isolation/SKILL.md
  - .pi/skills/_shared/SKILL-TEMPLATE.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
  - scripts/lint-historical-docs.mjs
  - tests/lint-historical-docs.test.ts
  - .githooks/pre-commit
---

# 历史特性文档不可变

## 背景：同一条沟摔了两次

搭档多次口头强调：「特性更新，就追加新特性文档，而不要去修改历史特性文档！记录变化过程！而不是记录最终状态！」（2026-08-31 08:06，原话）

违规事实（PR #607，F20260830fx62）：

| commit | 对历史文档 F20260829cstd 的改动 |
|--------|--------------------------------|
| 8624ab3e | 指标表加删除线标注 + 模块表 12→11 |
| a42edabe | 订正数字（检视獭建议 1） |

两笔都违反铁律——而 #607 自己的新文档 F20260830fx62 本来就完整记录了这些变化，历史文档的修改纯属多余。已回滚（75b5b726 → rebase 后 bfc2ab4b，恢复至 #598 合入时点 56a99a20），检视獭 delta 复核通过。

**根因**：规则不在任何书面载体——SYSTEM.md 无、skill 只说「追加」未禁「改历史」、F20260812fdmc 文档生命周期规范无。更关键的是，**检视獭的建议 1 本身就是让我去改历史文档**——整条链路没有任何环节能拦住。口头规则靠不住，必须落成流程 + 机械防线。

## 规则定义

**历史文档不可变**：已在 main（或基准分支）出现过的 `docs/features/`、`docs/research/` 文档，禁止 M/D 修改。它是交付时点的快照，当时正确就是正确。

**正确姿势**：后续特性更新（续接、修正、演进）一律新建文档记录变化，frontmatter `from` / `supersedes` 关联前文。发现历史文档错误 → 在新文档中记录更正，不回改。

**例外**：仅限结构性迁移（如 F20260803frmt frontmatter backfill 这类不改语义的批量操作）。逃生门：`BYPASS_HISTORICAL_DOC_LINT=1`（commit 时带环境变量），须在特性文档中记录理由。

**判定「历史」**：`git log origin/main..HEAD --diff-filter=A --follow -- <file>` 无本分支 Add 记录 → 该文件是历史文档。本分支新建的文档是本特性的迭代载体，随便改。

## 方案：三层防线

| 层 | 载体 | 拦截时机 | 拦得住谁 |
|----|------|----------|----------|
| 规范文本 | 4 处 skill 落规 | 开发者写文档前 | 开发獭/大獭（读 skill 的都会被引导） |
| 机械拦截 | pre-commit lint 脚本 | commit 时 | 一切 commit（含绕过 skill 的裸 git 操作） |
| 审视核查 | adversarial-review B2 焦点 | PR 审视时 | 漏网到 PR 的修改 |

### 1. skill 落规（4 处）

| 文件 | 改动 |
|------|------|
| `code-implementation/SKILL.md` 步骤 7 | 「追加（不存在则创建）到特性文档」→ 明确「本特性已有文档（本分支/本 PR 内创建）则追加；否则新建……回改已合入的历史文档一律禁止」 |
| `worktree-isolation/SKILL.md` 步骤 3 | 特性文档默认交付物段追加铁律 + 判定命令 + BYPASS 逃生门 |
| `_shared/SKILL-TEMPLATE.md` 全局约定「特性文档」 | 新增「历史文档不可变」条目（模板是所有 skill 的共享约定源） |
| `adversarial-review/references/review-dimensions.md` B2 | 新增硬规则：历史文档被修改 → 严重发现（除非 PR 声明结构性迁移留痕） |

### 2. 机械拦截（新增）

`scripts/lint-historical-docs.mjs`（导出 `findViolations` 供测试）：

- 扫 `git diff --cached --name-status` 中 `docs/features/`、`docs/research/` 的非 A 状态行
- 判定历史：`git log origin/main..HEAD --diff-filter=A --follow -- <file>` 无输出 → 历史 → 违规
- 基准分支退化链：origin/main → main → 找不到则宽松放行（不误伤新仓库）
- BYPASS：环境变量 `BYPASS_HISTORICAL_DOC_LINT=1`

接入 `.githooks/pre-commit` 末尾。

### 3. 测试锁定

`tests/lint-historical-docs.test.ts`（4 用例，临时 git 仓库模拟）：

1. 修改已合入历史文档 → exit 1 + 违规路径
2. 修改本分支新建文档 → 通过（含新建已 commit 后再修改——曾误判场景，锁定）
3. 非 docs 路径 → 不拦截
4. BYPASS=1 → exit 0 + stderr 警告

## 实现记录

- 开发中自抓 1 个 bug：`--diff-filter=A` 不带 `--follow` 时，「本分支新建并已 commit、再修改」会被误判为历史文档（A 后的 M 不产生新 Add commit）——PR 内迭代自相残杀。修正：`--follow` 跟踪重命名链。
- 测试 harness 踩坑三连（与脚本无关）：vitest alias 不影响子进程但 `../../scripts` 相对层级写错、`execFileSync` 成功分支拿不到 stderr、`__dirname` 在 ESM 不存在。
- 本特性自身即遵守铁律：本文档新建，未修改任何历史文档；对 F20260812fdmc 的演进通过 frontmatter `from` 关联。

## 验证

- 定向：`tests/lint-historical-docs.test.ts` 4/4 绿
- 手工实测：干净仓库模拟三场景（改历史文档被拦 / 改本分支新建文档放行 / BYPASS 放行）全部符合预期
- 真实回归验证：PR #607 的违规场景（修改已合入的 F20260829cstd）若在本防线下，commit 会被拦截
- 已过最简检查：无更简实现（复用 git 原生 diff-filter + follow，零依赖）

## Goodhart 防线

不变：防线拦的是「修改历史文档」这个动作，不拦「新建文档记录变更」——后者恰是鼓励的姿势。BYPASS 逃生门不设审批，但要求特性文档留痕理由，审视层 B2 会核查。
