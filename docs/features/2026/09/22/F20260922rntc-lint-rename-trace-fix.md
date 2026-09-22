---
id: F20260922rntc
title: lint-historical-docs rename 溯源修复：分支新建文档 R 形态 rename 误拦
summary: isAddedOnBranch 的 `--follow --diff-filter=A` 查询存在两重 miss——①staged R 形态 rename 新路径无 Add 记录（分支新建改名误拦）②高相似派生文件的 Add 被 follow 到源文件过滤（派生文档修改/改名误拦）；修复为 R 形态仅按 oldPath 判定 + 非 R 形态并集查询（无 --follow 兜底派生、--follow 保留 rename 链溯源），行为不再随 git 相似度检测漂移。
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

`scripts/lint-historical-docs.mjs` 的 isAddedOnBranch 查询存在两重 miss（PR #1108 检视严重 1 实测矩阵坐实）：

1. **R 形态 rename 新路径 miss**（初版发现）：`git log --follow` 对已提交历史有效，但对「索引区里尚未提交的 rename」看不到——staged R 形态的新路径在 ref..HEAD 中查不到 Add
2. **高相似派生文件 miss**（delta 发现）：cp 历史文档+微改派生新文档，`--follow --diff-filter=A` 把内容来源 follow 到历史文档、派生文件自己的 Add commit 被过滤——实测查询矩阵：派生文件无 `--follow --diff-filter=A` 命中 ✓ / 有 `--follow --diff-filter=A` 空 ✗ / 独立内容文件有 `--follow` 命中 ✓（变因=内容相似度）

## 修复

- `parseStatusLine` 返回增加 `oldPath`（R/C 形态时取倒数第二列）
- `isAddedOnBranch` 判定语义修订（PR #1108 建议 1 并入）：
  - **R 形态（oldPath 存在）：仅按 oldPath 判定**——R 行语义上内容来源是 oldPath，「任一命中」中 newPath 一侧对 R 行恒 miss（依赖 git 怪癖的偶然正确），若 git 修正行为则留误放窗口
  - **非 R 形态：并集查询**——`--diff-filter=A`（无 `--follow`）兜住派生文件（按路径查直接命中 Add commit），`--follow --diff-filter=A` 保留已提交 rename 链溯源
- 测试：新增 3 个用例——R 形态 rename（独立内容）、派生文档普通修改、派生文档 R 形态 rename（后两个锁 delta 发现的派生子集）

## 验证

**修复前失败输出**（PR #1108 初版脚本 507f24af，检视獭 delta 复核实测矩阵）：

```
派生文档场景（cp 历史文档+微改 → commit → git mv）：
  staged: R100 derived.md → renamed.md
  查询矩阵：无 --follow --diff-filter=A 按旧路径 → 命中 Add commit ✓
            有 --follow --diff-filter=A 按旧路径 → 空（Add 被 follow 到历史文档过滤）✗
  → 派生子集行为依赖查询形态，独立内容对照组正常（变因=内容相似度）
```

**修复后通过输出**（当前版本，独立 shell 探针）：

```
场景1：派生文档普通修改（staged M）→ exit 0 ✓
场景2：派生文档 R 形态 rename（staged R100）→ exit 0 ✓
场景3：已提交 rename 链的派生文档再修改 → exit 0 ✓（--diff-filter=A 按新路径命中）
场景4：历史文档 rename → exit 1 仍拦 ✓（反向洞无）
```

- `npx vitest run tests/lint-historical-docs.test.ts` **18/18 过**（16 + 派生场景 2 用例）
- Golden Gate: n/a（verify_by=static_only）

**覆盖范围声明**（收窄到实测覆盖）：分支新建文档的修改与 rename（独立内容 + 派生内容两族）均按预期放行；历史文档的修改/rename/删除仍拦截。git 版本行为差异（--follow 怪癖的版本敏感性）未覆盖，靠「R 形态仅按 oldPath」的结构保证兜底（不依赖怪癖抵消）。

## 过程中的测试基建教训（探针驱动调试记录）

测试用例间 staged 污染的两个形态（均被 shell 探针定位，非盲猜）：
1. 上一用例「挪回 rename」收尾实际是内容改写（HEAD v3 vs 工作区 renamed+edited），残留 staged M 使后续 `git mv` 退化为 D+A——收尾序列：reset → `git show HEAD:<file>` 恢复内容 + add → `git mv -f` 归位 → reset
2. `git diff --cached -- <单路径>` 的 pathspec 过滤会抑制 rename 配对（只显示 A），断言 R 形态需全量 diff 输出中匹配
