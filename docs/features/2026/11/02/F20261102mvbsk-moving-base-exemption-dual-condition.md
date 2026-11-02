---
id: F20261102mvbsk
title: moving-base 豁免误判修复——「分支内新建」豁免补 base 树存在性一票否决（#1300）
summary: |
  issue #1300（源自 #1290 事故复盘）：lint-historical-docs 的 isAddedOnBranch 判据只查
  窗口 ref..HEAD 内的 --diff-filter=A 记录，从未回答「该文档是否已在 main 存在」——文档
  已在 main 却靠窗口内 Add 记录被误放行（豁免语义失真）。本修复在豁免入口前置一票否决：
  路径经 git cat-file -e 判定在 base ref 树上已存在 → 无条件判历史文档，不豁免，改走
  .doc-fix 显式通道。直封「攻击者删历史文档重加同路径自造 Add」与一切「路径已在 main +
  窗口有 Add」形态。cat-file 查询异常按存在处理（宁拦勿放：误拦有 .doc-fix 通道兜底，
  误放无通道可救）。既有 54 条测试零回归 + 新增 moving-base 套件 5 条锁定。
change_type: fix
capability_test: "n/a: fix 类（lint 判定口径修正，不涉能力面）——回归由 tests/lint-historical-docs-movingbase.test.ts 5 条新增 + 既有五套件 54 条承担"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-11-02
causal_links:
  - F20260831dgim
  - F20260922dfch
  - F20261005imfg
  - F20261009hcig
---

## 背景

#1290 事故（2026-10-05）暴露 lint-historical-docs gate 结构性盲区：

1. 实现獭在分支 A 修改历史文档 F20261005imfg 正文（该文档已随 #1283 合入 main）——当时被拦（8b1f3b8f，--no-verify 硬绕）
2. #1283 合入后，同一改动落到基于新 main 的分支（df776564）再次提交——gate **未拦**，正文修改无 .doc-fix 直接通过

issue #1300 指出根因：`isAddedOnBranch()` 只在 `origin/main..HEAD` 窗口查 Add 记录，
main 是移动基准，豁免判据没有在回答「该文档是否在 main 已存在」。

## 根因考古（对 #1290 现场的 git 取证修正）

df776564（parent 9cb4b2b5）提交时点，imfg 文档的 Add 记录有两个：

- eb6c7029（分支 A 侧原 Add，2026-10-05 14:32，不可达自 9cb4b2b5）
- **381bb3be（main 侧 #1283 squash 合入，15:56，可达自 9cb4b2b5）**——squash 对 imfg 呈 A 形态

`git log 9cb4b2b5..df776564` 窗口内只有 df77 自身。**「实测未拦」要求窗口非空且含 imfg
的 Add** → df77 提交时本地 `origin/main` 引用停在 #1283 合入之前（陈旧），窗口因此把
381bb3be 包进来，`--diff-filter=A` 命中 → 误判「分支内新建」豁免。即事故第一现场是
**本地 origin/main 引用过期 + 窗口混入 main 侧 squash 的 A 记录**，与 issue 描述的
cherry-pick 时间线在机制上一致（都是「窗口含 Add 但路径已在 main」形态）。

## 修法

### 机制识别检查点（清单逐项）

- 新增配置字段/枚举/开关：否
- 新增状态生命周期：否
- 新增定时任务/后台进程：否
- 新增信号类型/消息格式：否
- 新增持久化存储：否
- 新增决策分支（结果被记住并影响后续行为）：否（纯运行时判定分支，无持久化）
- 新增跨模块调用路径：否

全部未命中 → **修法决策树 ①：既有机制语义内修**（缺啥补啥——豁免语义本就隐含「base 树
不存在」，补上直接判据）→ `Modification-Class: narrow-fix`。

### 实现

`scripts/lint-historical-docs.mjs`：

1. 新增 `pathExistsOnRef(p, ref)`：`git cat-file -e <ref>:<path>` 存在性判定；异常码
   128（路径不在 ref）返回 false，**其他异常码宁可判存在**（宁拦勿放——误拦走 .doc-fix
   显式通道可解，误放无通道可救）
2. `isAddedOnBranch()` 入口前置一票否决：`pathExistsOnRef(file, ref)` 为真 → 直接返回
   false（不豁免），原有窗口 Add 判定不再执行

攻击者自造 Add（删历史文档重加同路径）在旧代码下即可绕过（plain 查询命中自造 Add），
本修复将其直封——这与 #1273 delta-3 的 hasRenameLineageToBase（rename 血统判定内含
oldPath cat-file 检查）同源：rename 源存在性攻击者伪造不了，路径存在性同理。

## 验证

新增 `tests/lint-historical-docs-movingbase.test.ts`（族内第 6 个套件，按 cibase/rename
等先例独立文件）：

| # | 场景 | 预期 | 修复前 | 修复后 |
|---|------|------|--------|--------|
| t1 | 攻击者自造 Add：分支内 rm+re-add 历史文档同路径，再改正文 | 拦截 | **FAIL（放行）** | PASS |
| t2 | #1290 复刻（origin/main 新鲜）：基于新 main 重建分支改已合入文档正文 | 拦截 | PASS（空窗口语义） | PASS |
| t3 | 分支内新建文档提交后再修改（正常迭代载体） | 放行 | PASS | PASS（不误伤） |
| t4 | 历史文档正文修改（基础形态，issue 验证探针 1） | 拦截 | PASS | PASS |
| t5 | CI --base 模式（ref 新鲜）逐 commit 重放 #1290 场景 | 拦截 | PASS | PASS（残余缺口兜底锁定） |

修复前失败证据（t1，旧脚本放行 exit 0）：

```
× 攻击者自造 Add（删历史文档重加同路径）后再改正文 → 拦截（cat-file 一票否决直封）
Test Files  1 failed (1)
Tests  1 failed | 4 passed (5)
```

（t2/t5 修复前即绿——其拦截来自空窗口语义（base ref 新鲜时窗口天然不含 main 侧 Add），
非新判据；真正依赖新判据的红是 t1。诚实记录，不冒充 5 条全红。）

修复后：新套件 5/5 绿；既有五套件（主 15 + cibase + final + linkfix + rename）54/54 绿，
零回归。

issue 验证探针对照：探针 1 = t4 ✓；探针 2（分支内新建再修改放行）= t3 ✓；探针 3/4
（.doc-fix 配方）由既有主套件锁定（零回归）✓。

**最简实现检查**：已过——25 行（函数 12 行 + 调用点 3 行 + 注释），无新依赖、无新配置、
无状态。仓库已有 hasRenameLineageToBase 内含同型 cat-file 调用，本修复是该判据在 M 形态
主路径的复用而非新造。

**Golden Gate**: n/a（纯 lint 脚本代码改动，不涉 prompt/skill/协议层软代码，无场景可跑）
**锚点重放评审**: n/a（同上，lint 脚本不属 prompt/skill/tool description 行为触发语义）

## 设计取舍

### 为什么不过滤「可达自 main 的窗口 commit」（issue 提到的第一形态）

窗口 `ref..HEAD` 的集合论定义即「HEAD 可达且非 ref 祖先」——**窗口内 commit 恒不可达自
ref**。分支 A 场景（文档已在 main 但窗口含分支侧原 Add）的完整修复只需要 cat-file 否决
一项，可达性过滤是空操作，不实现。

### 残余缺口：本地 origin/main 引用完全过期（已声明不修）

本地 `origin/main` 停在「main 已合入该文档」之前时：cat-file miss + 窗口含 main 侧
squash 的 A 记录 → pre-commit 本地视图信息论上无法区分「main 侧 squash」与「分支侧
commit」（本地 git 对象无服务端合入事实）。不在此扩边界——伪造判据（如按 commit 时间/
author 猜 main 侧）比声明缺口更糟。兜底三层：CI `--base` 模式（CI checkout 的 ref 新鲜，
t5 锁定拦截）+ worktree-isolation fetch 纪律（开工前 `git fetch origin main`）+ PR 审视。
#1290 事故时点（2026-10-05）CI --base 模式尚不存在（#1281，F20261009hcig 于 10-09 合入），
同型事故在今天已由 CI 拦截。

### 为什么 cat-file 异常宁可判存在

误拦（路径实际不在 base）→ 作者走 .doc-fix 显式通道或重建分支，代价一次；误放（路径在
base 却 miss）→ 历史文档正文静默改写，无通道可救。fail-closed 方向与文件既有语义一致
（「查询失败宁拦」见 hasDocsTreeAncestry/hasHistoricalAncestry 同型处理）。

## 影响面自检

- 既有文档/决策描述失效：无——本修复收紧豁免口径，与 F20260831dgim（历史文档不可变）、
  F20260922dfch（.doc-fix 显式开口）设计意图完全同向，无描述冲突
- 行为变化面：唯一可能受影响的合法场景是「路径恰好在 base 树存在且窗口有分支侧 Add」——
  该形态在 main 真含此路径时本就不是「分支内新建」（豁免语义失真，正是要修的对象）；
  正常「分支新建→迭代」流程路径不在 base，零影响（t3 锁定）

## 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|------|------|----------|
| 自造 Add 绕过 | `npx vitest run tests/lint-historical-docs-movingbase.test.ts` | 5 passed，t1 stderr 含拦截路径 |
| 既有行为零回归 | `npx vitest run tests/lint-historical-docs*.test.ts`（全部 6 文件） | 59 passed（54 旧 + 5 新） |
| issue 探针 1 | 修改 main 已有文档正文无 .doc-fix（t4） | exit=1 |
| issue 探针 2 | 分支内新建文档再修改（t3） | exit=0 |
| issue 探针 3/4 | .doc-fix 配方（既有主套件） | frontmatter 放行 / 正文拦截 |
