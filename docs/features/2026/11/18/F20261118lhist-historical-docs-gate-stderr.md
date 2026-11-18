---
title: 历史文档门禁不再把预期失败的 git fatal 泄漏到输出
id: F20261118lhist
date: 2026-11-18
module: extensions
change_type: fix
status: active
summary: |
  scripts/lint-historical-docs.mjs 的 git() helper 继承 stderr，导致探测式调用（cat-file -e 查
  新增文档是否已在 base、frontmatterLastLineOf 的 git show）在**预期失败**时把 git 自己的
  `fatal: path ... exists on disk, but not in <base>` 泄漏到门禁输出。退出码一直是对的（0），但
  安全门禁输出里出现 fatal 会训练人忽略它，真故障因此失去信号。修法：helper 统一
  stdio:["ignore","pipe","pipe"]，失败信息随异常 error.stderr 交调用方处置；并给既有用例补
  stderr 不含 fatal 的断言。
intent:
  problem: "本仓重复出现的「新增特性文档 + 后续 commit 修改它」形态（任何多轮修订的 PR）都会在历史文档门禁输出里打印 fatal。本次在 #1927 的检视中被独立检视獭指出，作者先前把他当成正常输出，属对门禁信号的钝化"
  expected_effect: "门禁输出只剩脚本自己的 judgement（违规/警告），预期失败的 git 探测彻底静默；真故障仍以非零退出码 + 脚本自身报错呈现；用例锁定该行为防回归"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/lint-historical-docs-cibase.test.ts：新增文档首 commit 新增、后续 commit 修改的放行用例，追加 stderr 不含 /fatal:/ 断言（修复前该断言必红）"
      - "修复前后实测：同一仓库同一分支，修复前 stderr 出现 `fatal: path 'docs/features/.../F20261118zzzzz-probe.md' exists on disk, but not in '3f9459bb...'`，修复后为空；退出码两态均为 0"
      - "回归：`npx vitest run tests/lint-historical-docs*.test.ts` → 6 files / 61 tests 全通过"
capability_test: "tests/lint-historical-docs-cibase.test.ts"
---

# F20261118lhist：门禁输出不再泄漏预期失败的 git fatal

## 现象

历史文档不可变门禁（`scripts/lint-historical-docs.mjs`）在**本分支新增文档、且后续 commit 修改该文档**时，会往输出里打：

```
fatal: path 'docs/features/2026/11/18/F20261118clkid-colink-identity-split.md' exists on disk, but not in 'a106a498…'
```

退出码是 **0**（判定正确），但这是安全门禁的输出。

## 根因

`git()` helper 只包了 `encoding`，**stderr 继承终端**。而脚本有大量**预期失败**的探测式调用：

- `pathExistsOnRef()`：`git cat-file -e <base>:<新增路径>` —— 新增文档当然不在 base 上，git 把这当成「路径参数」并提示 exists on disk；
- `frontmatterLastLineOf()`：`git show <ref>` —— ref 侧不存在时同样会打 fatal。

失败是判定语义的一部分，调用方 catch 后按「不是历史文档 / 宁拦」处理——但 git 的 stderr 已经泄漏出去了。

为什么值得修（不是洁癖）：门禁的价值在于**信号可信**。输出里混进 `fatal` 会让读的人习惯性忽略，真正的故障（base ref 解析失败、历史文档被改）也跟着被忽略。本次就是作者自己先把这两行当成「正常输出」，由独立检视獭指出来的。

## 修法

- `git()` helper 统一 `stdio: ["ignore", "pipe", "pipe"]`：stdin 关掉，stdout/stderr 都收进内存；失败时信息仍在异常对象上（`error.stderr`），调用方原有的 catch/降级逻辑不变。
- 既有用例 `range 内首个 commit 新增文档、后续 commit 改它 → 放行` 追加断言 `stderr` 不含 `fatal:`——修复前必红。

## 影响面与边界

- 只改**输出通道**，不改任何判定：违规判定、`.doc-fix` 配对语义、宽松放行条件、退出码全部原样（61 个用例全绿）。
- 未把 git 的全部 stderr 丢弃：错误仍随异常传递，脚本自身仍会打印自己的违规说明与警告。
- 不覆盖「git 在成功路径写 warning 到 stderr」的形态（本仓门禁不依赖它们）。
