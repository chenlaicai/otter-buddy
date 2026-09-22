---
id: F20260922rntc
title: lint-historical-docs rename 溯源修复：分支新建文档 R 形态 rename 误拦
summary: isAddedOnBranch 只按新路径查 Add commit，staged rename（R 形态）未提交时新路径查不到记录导致分支新建文档被误判为历史文档拦截；修复为 rename 溯源（同时按旧路径查 Add），行为不再随 git 相似度检测漂移。
change_type: fix
capability_test: tests/lint-historical-docs.test.ts
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
intent:
  problem: 分支新建文档 git mv 改名（R 形态，相似度≥50%）被 lint-historical-docs 误拦为历史文档修改；相似度<50%（D+A 形态）反而放行——行为随 git 相似度检测漂移，合法迭代被拦会把用户推向 .doc-fix 假理由
  expected_effect: R 形态 rename 按旧路径溯源查 Add 记录，分支新建文档 rename 无论相似度均放行；历史文档 rename 仍拦
  verify_by:
    type: static_only
    note: lint 脚本行为由 vitest 16 用例静态锁定（新增 R 形态 rename 用例 + 双向探针实测），无 LLM 场景
tags: [toolchain, lint, bugfix]
modules: [scripts/lint-historical-docs.mjs, tests/lint-historical-docs.test.ts]
---

# F20260922rntc lint-historical-docs rename 溯源修复

## 问题

Issue #1103（PR #1102 对抗审视建议 1，检视獭-dfch scratch 实测坐实）：分支新建文档 `git mv` 改名+微改，git diff 相似度 ≥50% 显示 R 形态 rename 时，lint-historical-docs exit 1 误拦；相似度 <50%（D+A 形态）正确放行——**行为随 git 相似度检测漂移**。

## 根因

`scripts/lint-historical-docs.mjs` 两处配合失误：
1. `parseStatusLine` 对 R 行（`R100\told\tnew`）只取新路径，旧路径信息丢弃
2. `isAddedOnBranch` 只按传入路径查 `ref..HEAD` 的 Add commit——staged rename 未提交时，新路径在 commit 历史中查不到 Add（`git log --follow` 对已提交历史有效，对索引区里未提交的 rename 看不到），误判为历史文档

## 修复

- `parseStatusLine` 返回增加 `oldPath`（R/C 形态时取倒数第二列）
- `isAddedOnBranch(file, ref, oldPath)`：新路径查不到 Add 且存在 oldPath 时，按旧路径再查一次，任一命中即本分支新建
- 测试：新增 R 形态 rename 用例（纯 `git mv` 不改内容保证 R100，断言 staged 确为 R 形态防假通过）

## 验证

- **失败用例证据**（修复前）：检视獭 scratch 实测 R 形态误拦（PR #1102 审视报告建议 1 案发现场）；本地探针复现 R072 → exit 1
- **修复后通过证据**：`npx vitest run tests/lint-historical-docs.test.ts` 16/16 过（含新增 R 形态用例）；独立 shell 探针双向验证——分支新建 R072 → exit 0 放行、历史文档 rename → exit 1 仍拦
- Golden Gate: n/a（verify_by=static_only）

## 过程中的测试基建教训（探针驱动调试记录）

测试用例间 staged 污染的两个形态（均被 shell 探针定位，非盲猜）：
1. 上一用例「挪回 rename」收尾实际是内容改写（HEAD v3 vs 工作区 renamed+edited），残留 staged M 使后续 `git mv` 退化为 D+A——收尾序列：reset → `git show HEAD:<file>` 恢复内容 + add → `git mv -f` 归位 → reset
2. `git diff --cached -- <单路径>` 的 pathspec 过滤会抑制 rename 配对（只显示 A），断言 R 形态需全量 diff 输出中匹配
