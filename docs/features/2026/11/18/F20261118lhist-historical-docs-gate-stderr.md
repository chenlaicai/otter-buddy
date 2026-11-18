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
  stdio:["ignore","pipe","pipe"]；同时把降级放行从「静默 exit 0」改成「脚本自报诊断行」——
  否则收窄 stderr 等于连非预期故障的最后一条诊断也抹掉（独立检视阻断 1），逐条用例分别锁
  stderr 无 fatal 与降级必有诊断。
intent:
  problem: "本仓重复出现的「新增特性文档 + 后续 commit 修改它」形态（任何多轮修订的 PR）都会在历史文档门禁输出里打印 fatal。本次在 #1927 的检视中被独立检视獭指出，作者先前把他当成正常输出，属对门禁信号的钝化"
  expected_effect: "门禁输出只剩脚本自己的 judgement（违规/警告），预期失败的 git 探测彻底静默；非预期的 git 故障仍以脚本自身诊断行可见（降级放行的 exit 0 语义不变，但不再静默）；两条用例分别锁定「无 fatal 噪音」与「降级必有诊断」防回归"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/lint-historical-docs-cibase.test.ts：新增文档首 commit 新增、后续 commit 修改的放行用例，追加 stderr 不含 /fatal:/ 断言（修复前该断言必红）"
      - "修复前后实测：同一仓库同一分支，修复前 stderr 出现 `fatal: path 'docs/features/.../F20261118zzzzz-probe.md' exists on disk, but not in '3f9459bb...'`，修复后为空；退出码两态均为 0"
      - "fake-git 注入（`diff --cached --name-status` 以 42 失败 + stderr）用例：修复前 stdout/stderr 全空、修复后必须命中 /宽松放行/ 与注入字符串——去掉诊断行后该用例必红（实测 1 failed）"
      - "回归：`npx vitest run tests/lint-historical-docs*.test.ts` → 6 files / 63 tests 全通过"
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

### 阻断 1 的补救：收窄 stderr 不得顺手抹掉真故障诊断

独立检视实测：pre-commit 模式下 `findViolations()` 首个 `nameStatus()` 失败会返回 `degraded: true`，而 `main()` 丢弃该标志直接 `exit 0`——旧版靠 git 自己往终端打的那行 fatal 当唯一信号，本 PR 把 stderr 收进 pipe 后这条路径变成**完全静默的成功**。这与「让门禁信号可信」的修复目的正相反。

补救（保持 exit 0 放行语义不变，只补可观测性）：

- `findViolations()` 的 catch 保留诊断：新增 `briefGitFailure()`（stderr 首行、去 ANSI/换行、截断 200 字符）返回为 `degradedReason`；
- `main()` 收到 `degraded` 时打印 `[lint:historical-docs] 无法读取 staged diff，本次校验宽松放行（未校验）；诊断：…` 后 exit 0；
- `--base` 模式的逐 commit 降级本就自带警告，这里把 `degradedReason` 一并附上，两种模式诊断口径统一；
- 新增 fake-git 回归用例：PATH 前置假 git 命中 `diff --cached --name-status` 时以 42 失败并写 stderr，断言 **exit 0 + 输出含「宽松放行」+ 含注入字符串**；去掉诊断行后该用例必红（实测）。
- 第二处（检视 r2 非阻断）：`briefGitFailure()` 改「先 sanitize 再判空」——原实现先选原始首个非空行再清洗，纯 ANSI 首行清洗后为空会把真正的诊断（第二行）一起丢掉、输出 `unknown`，即诊断函数丢掉诊断本身。补用例：注入 `ESC[31m` + 换行 + `fatal: REAL_SECOND_LINE_DIAG`，断言输出含该串且不含 `诊断：unknown`、不外泄 ESC；**旧实现下该用例必红**（实测 1 failed）。
- 用例里的 ESC 用 `String.fromCharCode(27)` 构造（仓库 eslint `no-control-regex` 禁止字面控制字符；CI 因此先红过一次，本机 `npx eslint` 复验通过）。
- fake-git 的 stderr 注入改走 `printf '%b'`（把真实 ESC/换行转成 `\033`/`\n` 转义），否则 `%s` 会把转义写成字面反斜杠、边界形态根本构造不出来（第一版用例就是这么假绿的，已变异验证纠正）。

## 影响面与边界

- 只改**输出通道**，不改任何判定：违规判定、`.doc-fix` 配对语义、宽松放行条件、退出码全部原样（63 个用例全绿）。
- 未把 git 的全部 stderr 丢弃：错误仍随异常传递，脚本自身仍会打印自己的违规说明与警告。
- 不覆盖「git 在成功路径写 warning 到 stderr」的形态（本仓门禁不依赖它们）。
- 诊断行只放 stderr 首行摘要（截断 200 字符），不打印完整 git 输出，避免把仓库内容糊进 CI 日志。
- 降级放行的判定保持宽松（exit 0）是既有取舍，本次不动；把它改成 fail-closed 属另一个决策，需单独论证误报面。
