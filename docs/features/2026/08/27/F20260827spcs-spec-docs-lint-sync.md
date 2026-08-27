---
id: F20260827spcs
title: 三处规范文档同步：R1 force-with-lease 豁免、SKILL-TEMPLATE 字段对齐、lint 校验补盲
summary: 一个 PR 带三个 issue 的规范同步批处理。#468 R1 红线第 4 条按分支类型区分——受保护分支 force push 永远禁止，本期创建未合入的 feature 分支 rebase 后放行 --force-with-lease；#455 SKILL-TEMPLATE 特性文档字段清单按真实使用率重排（核心五字段 + capability_test + created_in_conversation，冷门字段降为可选）；#470 validator 补 status 枚举 active、title 可读性、文件名 slug 三项校验 + lint:docs ratchet 约束存量。
change_type: prompt
status: development
created_in_conversation: 02e892ea-b291-4108-bacf-0d6148790511
capability_test: "n/a: 规范文档与 lint 逻辑改动（validator 有单元测试 tests/entities/document/frontmatter-validator.test.ts），无 LLM 参与行为"
tags: [spec, lint, validator, r1, docs]
modules: [src/entities/document, scripts, .pi, docs]
---

# F20260827spcs：三处规范文档同步（#468 + #455 + #470）

## 背景

三个规范漂移 issue 批量处理：

- **#468**：PR #465 流程中 mimo 在 worktree 内对本期创建的 feature 分支 rebase 后需 `--force-with-lease` push，被 R1 红线「禁止 git push --force」一刀切拦下。搭档反馈：推送本次干活创建的 PR 分支不应受此约束。R1 的保护本意是「不可丢弃的工作」——受保护分支上 force push 毁掉他人提交；自己本期创建、未合入的 feature 分支历史只是草稿。
- **#455**：SKILL-TEMPLATE.md:149 字段清单把使用率 ≤15% 的字段（doc_type 3/20、causal_links 2/20、created_at 2/20）列为标准，漏掉 lint:capability 明确检查的 capability_test（17/20）——新读者按模板写反而与主流脱节。
- **#470**：PR #467 的特性文档两处 lint 盲区由搭档人肉审出——`status: in-progress`（枚举外）与 `title: stock-cli-pr1-data-bridge`（英文 slug 应放文件名）；评论区补充第三处：文件名缺 slug 后缀（升级为必查项）。

## 改动明细

### #468：R1 红线 force-push 条款按分支类型区分

| 文件 | 改动 |
|------|------|
| `.pi/SYSTEM.md` R1 第 4 条 | `git push --force` 从一刀切列表移出，新增按分支类型区分的子句：受保护分支（main / develop / 生产分支 / PR 目标分支）永远禁止、征得搭档同意也不放行；本期创建未合入的 feature 分支 rebase 后允许 `--force-with-lease`（远端被他人推进时拒绝的保险保留）；整段历史重写（filter-branch / rebase -i 改根提交）仍需确认 |
| `.pi/skills/worktree-isolation/SKILL.md` 步骤 4 | push 指引补充 force-with-lease 场景说明（引用 #468，与 SYSTEM.md 双源一致） |

### #455：SKILL-TEMPLATE 字段清单对齐现行约定

`.pi/skills/_shared/SKILL-TEMPLATE.md:149` 字段清单重排：

- **核心字段**（必写）：`id` / `title`（人类可读描述，不用英文 slug——slug 放文件名，#470）/ `summary` / `change_type` / `status` + `capability_test`（feature/prompt 时声明）+ `created_in_conversation`
- **可选字段**（按需）：`doc_type` / `causal_links` / `tags` / `modules` / `created_at`（标注使用率低）

### #470：validator 补三项校验 + ratchet

校验规则落在单一真相源 `src/entities/document/frontmatter-validator.ts`（lint-docs.mjs 是壳，复用 dist 编译产物）：

1. **status 枚举补 `active`**（`known-values.ts`）：存量 33 篇在用，lint 长期误报 `Unknown feature status`。`in-progress` 等真正的枚举外值仍报警。
2. **title 可读性**（新函数 `validateTitleReadability`）：无 CJK 且无空白的纯 slug 形态报 warning——「Title looks like a slug ... slugs belong in the filename」。中文/英文多词 title 放过。
3. **文件名 slug 后缀**（新函数 `validateFilenameSlug`）：裸 ID 文件名（`^F\d{8}[a-z0-9]{3,10}\.md$`）报 warning。#470 评论的候选正则 `(-[a-z0-9-]+)?` 会让裸 ID 漏网，实现改为只对裸 ID 报警（存量 7 篇），带 slug 的一律放过。
4. **lint:docs ratchet**（`scripts/lint-docs.mjs`）：警告计数从「文件数」改为「警告条数」（一篇文档可产生多条警告），设 `MAX_WARNINGS = 269`（基线：221 title slug + 7 缺 slug 文件名 + 38 旧 change_type + 2 旧 status + 1 旧 exploration_type），警告数超上限阻断 commit——与 lint:capability 的 MAX_WARNINGS=63 同模式，存量只减不增。
5. **docs/README.md**（lint 硬规则真相源）：软警告章节补 title/slug 规则说明，status 枚举行补 active。

## 关键取舍

- **#470 修复位置在 validator 而非 lint-docs.mjs 本体**：issue 建议改 lint-docs.mjs，但读代码发现该脚本只是壳——真校验在 `frontmatter-validator.ts`（单一真相源，运行时 sync 与 commit-time lint 共用）。规则落 validator 一处，两条链路同时生效。
- **warn 不 error**：title slug 与文件名缺 slug 存量分别 221/7 篇，直接报 error 会阻断所有 commit；沿用仓库「存量宽容 + ratchet 只减不增」的既定模式（lint:capability 先例）。
- **R1 措辞克制**：#468 只动第 4 条，新增子句内嵌原句，不重写 R1 其他条款。

## 测试

`tests/entities/document/frontmatter-validator.test.ts`（新增，9 用例）：

- 纯 slug title 报警 / 中文 title 放过 / 英文多词 title 放过
- 裸 ID 文件名报警 / 带 slug 文件名放过 / 非 F 前缀放过
- `active` 是已知值 / `in-progress` 仍报 Unknown（#470 原始案例回归）
- 空白 title 不误报

全量自检：`npm run build` 通过；`npm run lint` 通过；vitest 149 files / 1755 tests 全过；lint:docs 269 warnings = 上限（通过）；lint:capability 63 = 上限（通过）。

## Discovered Issues

- 存量 38 篇旧 change_type（bugfix/design 等历史值）与 2 篇旧 status（review/reviewed）在 ratchet 内逐步治理，未单独开 issue——属存量数据清理非规则缺口
