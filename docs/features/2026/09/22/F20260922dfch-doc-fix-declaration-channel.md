---
id: F20260922dfch
title: 历史文档修改通道升级：BYPASS 环境变量自觉制 → .doc-fix 声明文件显式开口
summary: lint-historical-docs 的逃生门从 BYPASS_HISTORICAL_DOC_LINT 环境变量（自觉声明理由，可悄悄绕过）升级为 staged .doc-fix 声明文件（理由强制留痕进 git 历史、随 PR diff 可见），开口仅限元数据订正（frontmatter/id 对齐/格式），内容与设计修改一律走 supersede 新文档。
change_type: feature
capability_test: tests/lint-historical-docs.test.ts
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
tags: [toolchain, lint, governance, docs]
modules: [scripts/lint-historical-docs.mjs, tests/lint-historical-docs.test.ts, .pi/skills/worktree-isolation/SKILL.md]
---

# F20260922dfch 历史文档修改通道升级

## 背景与需求

历史文档不可变铁律 + lint-historical-docs 机械拦截自 F20260831dgim（#615）已生效。2026-09-22 外部洞察对话中，搭档对 lossless-memory 对比分析时质疑「特性文档 append-only」前提，触发全历史核查（`git log --diff-filter=M`）：

- main 上修改已合入文档的 commit 共 6 个，其中 5 案为「同 PR 内新建+修改」的合法形态（PR 内演化，squash 后等价一次创建）
- 唯一真·历史修改案 4cd428c5（doc-sync id 漂移对齐 DB 存量）走 `BYPASS_HISTORICAL_DOC_LINT=1` 且属结构性迁移，commit body 有理由记录——现有机制实际在正常工作

搭档决策（原话）：「lint 直接拦截，按照你说的规则，我认为很对，日常都拦，但也有 [doc-fix] 这个正常开口——只有当文档元数据（比如格式）需要修正、而不是文档内容需要修改时可以放行。其余的按你的来，开工。」

## 差距分析

现有 BYPASS 是「海獭自觉声明理由」：环境变量一带就过，无强制留痕、无 PR 可见性、无类型约束——机制上存在「悄悄绕过」的开口。

## 方案设计

### 通道形态选型

| 候选 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| BYPASS 环境变量（现状） | 简单 | 可悄悄绕过、理由靠自觉 | 否决 |
| commit message `[doc-fix]` 前缀 | 进 git 历史 | pre-commit 时 message 不存在，无法判定；需 commit-msg 钩子两跳 | 否决 |
| **staged `.doc-fix` 声明文件** | staged 即可判定；内容即理由强制留痕；随 PR diff 可见；一次性用途 | 多一个文件管理 | **采纳** |

### 规则

- 放行条件：staged 区存在 `.doc-fix` 文件（git show :.doc-fix 读索引区，不看工作区）且内容 trim 后 ≥10 字符
- 开口范围：仅限元数据订正（frontmatter 字段修正、id 对齐、格式订正）；内容/设计修改一律 supersede 新文档
- 一次性：声明文件提交后删除（lint 放行警告中提示）
- 拦截文案更新：指明两条正当通道（① .doc-fix 元数据订正 ② supersede 新文档），无声明/理由不足/未 staged 三种失败形态各有明确 hint

### 旧通道处置

`BYPASS_HISTORICAL_DOC_LINT` 环境变量直接移除（非过渡期警告）——该通道自 8/31 存在仅 3 周，全历史仅 1 次合法使用（4cd428c5），无兼容负担；新旧通道语义等价（都是显式声明），直接切换不留双轨。

## 影响范围

- scripts/lint-historical-docs.mjs：main() 通道判定逻辑 + readDocFixDeclaration() 新增
- tests/lint-historical-docs.test.ts：BYPASS 用例替换为 .doc-fix 三用例（放行/理由不足/未 staged），rename 用例 stage 方式顺带修正
- .pi/skills/worktree-isolation/SKILL.md：铁律段文案同步

## 验证

- 8 用例全过（vitest run tests/lint-historical-docs.test.ts）：历史修改拦截 / 本分支新建放行 / 管辖外路径 / .doc-fix 放行（理由留痕警告）/ 理由不足 10 字符拦截 / 未 staged 拦截 / rename 历史文档拦截 / rename 本分支新建放行
- lint:skills 与 lint:prompt-anchors 通过（SKILL.md 改动合规）

## 决策记录

- 搭档拍板（2026-09-22）：直接拦截（非警告模式）+ [doc-fix] 开口仅限元数据订正 + 其余按推荐方案
