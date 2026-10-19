---
id: F20261019syml
title: bash 守卫——symlink 逃逸链 realpath 归一化（ln -s 主仓→worktrees 区 + 写/删穿链两步全放收口）
summary: M-ed285d7c（#1515 delta 建议 2 立档）：ln -s <主仓内容> <worktrees 区>/link 后 git -C <link> 写族 / cd <link> && 写 / echo > <link>/f / rm <link>/sub 的字符串落点在运行时区（豁免命中）而真实落点在主仓内容树——两步全放。判定基元（wv pathWithinMain / prod isInsideMainCheckout、classifyDestructiveTarget、git -C 落点累积）路径比较前 symlink 穿透归一（safeRealpath 最深存在祖先回拼）；显式意图豁免加「声明形态=真实落点」分歧一票否决（诚实 cd 主仓照旧放行）
type: BugFix
date: 2026-10-19
capability_test: "n/a（change_type=BugFix）：回归钉 tests/frameworks/agent/bash-guard-symlink-realpath.test.ts（首轮 12 + 二轮 `..`-after-symlink 回归钉 8，真 fs symlink 拓扑，合计 20）"
intent:
  problem: "M-ed285d7c（#1515 delta 建议 2 立档）：symlink 逃逸链两步全放——ln -s <主仓内容> <worktrees 区>/link 之后，git -C <link> 写族 / cd <link> && git commit / echo x > <link>/f / rm -rf <link>/sub 的字符串落点在运行时区（判定豁免命中）而真实落点在主仓内容树；判定基元纯字符串路径比较（pathWithinMain / isInsideMainCheckout / classifyDestructiveTarget / git -C 落点累积均无 realpath），与 cwd 形态共享既有边界（显式意图豁免不辨声明真伪）"
  expected_effect: "逃逸链收口：ln -s + 写/删穿链形态两层同判拦截（git -C <link> 写族、cd <link> && git commit、echo > <link>/f、rm <link>/sub、rm <link>/*、多级 cd 撒谎链）；不误伤面钉死（rm <link> 链清理、反向链写穿落 worktree、诚实 cd 主仓显式意图、基线 worktree 形态、虚构路径 identity）；全量 vitest 零回归 + guard-touchstone exam 棘轮无 GAP_DIFF（语料判定零漂移）"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
---

编号溯源：原 F20261016syml（2026-10-16 创建），2026-10-19 特性编号顺延（日期段 10/16→10/19，合入定稿按 F20260914prdb「定稿时改名为合入当天日期」，搭档指令「顺延特性编号的日期」）改为现号。

## 排查结论（案情与根因，修前探针实证）

**案情**（M-ed285d7c，#1515 delta 复核建议 2 立档）：两步逃逸链——step1 `ln -s <主仓内容> <worktrees 区>/link`（链创建本身无害，#1513 不军备化不拦）；step2 使用链的命令**字符串落点在 worktrees 区**（判定豁免命中）而**真实落点在主仓内容树**：

| step2 形态 | 修前 | 修后 |
|---|---|---|
| `git -C <link> commit …`（-C 写族） | 双层放行 ✗ | 双层同拦 ✓ |
| `cd <link> && git commit …`（cwd 形态） | 放行 ✗ | 拦 ✓ |
| `echo x > <link>/f.md`（写穿链） | 放行 ✗ | 拦 ✓ |
| `rm -rf <link>/sub`、`rm -rf <link>/*`（删穿链） | 放行 ✗ | 拦 ✓ |
| `cd <wt> && cd <link> && git commit`（多级撒谎链） | 放行 ✗ | 拦 ✓ |

**根因**：判定基元纯字符串路径比较——wv `pathWithinMain`、prod `isInsideMainCheckout`（#1527 1a' 下沉基元）、`classifyDestructiveTarget`、git -C 落点累积、cd 豁免两层（modelCdExemption / segmentCdTarget）均不做 realpath，「声明形态」与「真实落点」的偏差无人辨认。与 cwd 形态共享既有边界（显式意图豁免不辨声明真伪），非 #1515 新泄漏。修前固化证据：`symlink-before-fix.txt`（10 例 6 failed——4 逃逸面 + 反向链 + 基元红，放行侧 4 例绿）。

## 设计取舍

**机制识别检查点（修法决策树）**：七项按最严口径「新增跨模块调用路径」命中（共享 fs-realpath 模块被两个判定模块引接）→ **论证不涉净新增机制**：realpath 归一化是既有路径判定的纯计算补全（node:fs 内建 syscall，无状态/无配置/无持久化/无记忆），共享 helper 是代码组织（防三份区域清单式漂移）而非机制接线。→ 修法①既有语义内修（路径判定缺归一化，补归一化）。**Modification-Class: narrow-fix**（无新层/无新机制/无管辖扩大）。

**取舍 1：safeRealpath 失败语义=身份（fail-soft→现状）**。realpath 不可解析（ELOOP/EACCES）时同一 uid 的真实写删同样会失败（ELOOP 链上写不进、EACCES 组件下写不动），无穿链风险；fail-closed 强判主仓反而给怪路径造新误拦面。纯虚构路径（测试 /repo、语料库命令）恒等返回——**exam 棘轮零 GAP_DIFF 实证判定零漂移**。

**取舍 2：破坏侧末分量不穿链（safeRealpathParent，unlink/rename 语义）**。`rm <link>` 删链本体无害（恰是链清理正道，放行侧钉死）；`rm <link>/sub` 的 link 是父目录由 dirname 侧穿链收口；原目标带尾杠/glob（操作发生在链内）时全穿链——`rm -rf <link>/*` 删进真实目录=真破坏面，拦。

**取舍 3：显式意图豁免「声明=现实」分歧一票否决，边界本体不动**。探针实证既有边界：`cd /repo && git commit` 与 `cd /tmp && echo x > /repo/f.md` 均放行（「显式意图」设计，bash-safety-guard.test.ts:1154 pinned）——本刀不动它。收口规则：cd 目标的**字符串形态归类与真实落点归类分歧**（cdFormDiverges）才杀豁免——撒谎形态（字面 worktree 区、真身主仓）落严格通道按真实落点判；同类分歧不杀（macOS /tmp→/private/tmp、/var/folders→/private/var 等无辜链零误伤）。预扫覆盖全链：modelCdExemption「首个合法 cd 即授予」与 segmentCdTarget「首个合格 cd 即返回」的早返盲区（`cd <wt> && cd <link> && …`）由链级预扫收口。诚实 cd 主仓真路径版放行用例随行钉死。

**取舍 4：范围边界与残余面（记档）**。①ln -s 链创建不拦（#1513 不军备化：危害全在 use-time，step2 已收口；链创建是无害且可审计的独立操作）；②V1 parse-fail 链（hasRealCdSegment 兜底）无目标抽取能力，parseOk=false 载荷内的撒谎 cd 属残余面（既有静态判定边界，非本刀引入）；③guard-model-judge scripts 白名单（:406）是执行豁免窄面，非写逃逸，不在本刀射程；④旧「不做 realpath IO」声明（防自杀机制收敛文档）由本工单收口——realpathSync 为 node:fs 内建（当年约束「不引入新外部依赖」原意保持），同步 IO 成本=每判定点数个 syscall，无热路径风险。

## 影响范围

- 判定面 5 处：wv `pathWithinMain`（3 调用点）、prod `isInsideMainCheckout`（7 调用点）、`classifyDestructiveTarget`（rm/mv/find -delete 目标域）、git -C 落点累积（worktrees 下沉层豁免）、cd 豁免两层（modelCdExemption targetVeto 回调 + segmentCdTarget 预扫）——基元级修复，调用点一次继承（#1527 1a' 下沉红利）。
- 区域尾杠语义逐字保持（带尾杠=仅子树 / 不带=含裸名）——**M-cf899ad2 口径之争零漂移**，workforms-retire 冻结裁决不受影响。
- 显式意图边界不动（探针 + :1154 pinned + 真路径版用例三重钉）；链清理 / 反向链 / 基线 worktree 形态照常放行。

## 验证

- **固化失败（修前）**：`bash-guard-symlink-realpath.test.ts` 10 例 6 failed——4 逃逸面（git -C / cd / 写穿 / 删穿）+ 反向链 + 基元穿链红，放行侧 4 绿（证据 `symlink-before-fix.txt`）。
- **修后**：同文件 12/12 绿（+多级撒谎链 +诚实 cd 真路径版）；**全仓 npx vitest run 373 files 5791 passed + 6 skipped**（基线 372/5779 + 新 12）零回归；guard-touchstone exam 棘轮**无 GAP_DIFF**（identity 归一零漂移，冻结语料零改动）；lint / npx tsc --noEmit 净。

## 二轮修复（`..`-after-symlink，检视 r1 严重 1，2026-10-19）

**案情**（检视獭1533 一审 review 5545631648 严重 1）：`..` 紧跟 symlink 分量时守卫口径与内核落点分歧——`path.normalize`/JS 版 `realpathSync` 在 symlink 解析**前**词法折叠 `..`（`<wt>/link/../probe1.txt` 折成 `<wt>/probe1.txt`，判 worktrees 区放行），内核逐分量落点=`<root>/probe1.txt`（主仓内容树）。修前固化 6 红（redirect / cd / git -C / 删穿链 / 多级 / 基元），honest-`..` 与 wv 侧 2 例绿。

**根因两半**：①基元半——safeRealpath 前置 normalize + JS 版 realpathSync 同样词法折叠（`link/../src` 直接 ENOENT）；②调用点半——基元之外 8 处调用点在 safeRealpath **之前**就把 `..` 折叠掉（基元修了也看不见）：classifyDestructiveTarget、checkDataDirDestructive cwd 跟踪、git -C 累积 resolveTarget、heredoc 绝对路径扫描、one-liner 路径字面量、segmentCdTarget 预扫+主环、cd 豁免 targetVeto 回调、redirect 通道（工作区豁免快捷判定）。

**修法**（检视处置建议 1）：①fs-realpath.ts 去前置 normalize，存在段解析换 `fs.realpathSync.native`（realpath(3) 逐分量：先解链再弹 `..`）；保留「最深存在祖先+尾段回拼」（realpath(3) 对不存在尾段恒 ENOENT）；新增 `joinNoFold`（拼接不折叠，折叠留给 safeRealpath）。②8 处调用点去折叠；cdFormDiverges 传参改 raw（normalize 会把撒谎形态洗成同类=不杀豁免）；segmentCdTarget 返回 cwdBase=真身；redirect 工作区豁免改按真身判（折叠形态可假豁免）。wv 侧零改动（evalPath 对 `..` 返 null→unevaluated→fail-closed，已拦，测试钉死）。

**设计取舍（二轮增量）**：

- **取舍 5：`..` 语义=内核逐分量**（先解链再弹栈）。尾段回拼保留；尾段含 `..` 时（仅祖先不可解析才会入尾段）对已解析真基座词法折叠——此时内核本就 ENOENT（写落空），守卫偏保守方向，无逃逸面。
- **取舍 6（⚠️ 与测试草稿相抵，delta 重点复审）**：多级例 `git -C <link>/../.. commit`（真落 `<root>` 父级=树外）**维持拦截**而非放行——git 写族对树外落点按 F20261014cwsp S1 既定语义 fail-closed 不豁免（bash-safety-guard.ts cwdInGitWorktree 注释：「树外任意目录（落点不确定，fail-closed）都不豁免」）。开「-C 树外即豁免」会放出**外部 worktree 间接写主仓 .git** 的口子（`git worktree add /tmp/x` 后 `git -C /tmp/x commit` 真写主仓 .git），本轮红线=不引入新豁免面。穿链解析正确性由基元例钉死；树外放行如需打开属独立工单+搭档拍板。

**影响范围（二轮增量）**：判定语义仅在「`..` 紧跟 symlink 分量」形态变化（原词法折叠=逃逸面，现逐分量=真实落点）；诚实 `..`（无链）两侧行为逐比特不变（normalize 与逐分量对无链路径同结果）；虚构路径恒等返回不变（exam 棘轮零 GAP_DIFF 复证）；区域尾杠（M-cf899ad2）/显式意图边界继续不动。

**验证（二轮）**：①固化失败：8 例 `..` 回归钉 6 红（redirect/cd/git -C/删穿/多级/基元）+ 2 绿（诚实 `..` 放行、wv 同链判拦）；②修后：同文件 20/20 绿；**全仓 npx vitest run 397 files 6205 passed + 6 skipped 零失败**；exam 棘轮 3/3 无 GAP_DIFF；③测试文件特性编号同步 F20261016syml→F20261019syml（大獭 81da02e2 委托）；④首跑全量 7 失败定性为负载 flake（6 例 5s 超时 + mahjong game-shot 集成抖动）：同 6 文件隔离复跑 73/73 绿 + 二次全量零失败交叉实证。

## 三轮（#1523 合并集成，2026-10-19）

**背景**：main 合入 #1523「守卫单一求值器终态」（主仓写判定整体升级 `evaluateWriteVerdict` 语义判据，bash-safety-guard 删 main_write 重叠面），与本特性的去折叠改动在 bash-safety-guard.ts / write-target-evaluator.ts 硬冲突。集成原则（大獭指导）：**#1523 架构为准不回退 + 去折叠语义等价落位**。

**冲突解法**：bash-safety-guard 两处大冲突全取 main 侧（evaluateWriteVerdict 主体 + one-liner/cd 豁免面删除，S1 裁决不回退）；import 两处取并集后按实际引用清理（孤儿 statSync 去除）。

**去折叠语义等价落位（二轮 8 处的迁移）**：

1. **evalPath `..` 分支**：`climbPath` 词法爬升（字符串弹栈跨 symlink 分量与内核逐分量落点分歧 = `..`-after-symlink 同款逃逸面）→ 保留 `..` 交下游 `pathWithinMain`/fs 逐分量解析（非 symlink 形态两者逐比特同语义，exam 988 语料无扰；rebase 修的 `git -C ../` 误拦案例同样被 safeRealpath 修住）。climbPath 随之删除（无残留）。
2. **gitSegSelfWriteEvidence -C 累积**：两处 `path.normalize(v)` 去折叠（同二轮 R4/R5）。
3. **「末分量不穿链」等价落位**：`WriteTarget.entryOp`（rm=目录项操作）→ `pathEntryWithinMain`（父目录逐分量解析 + 末分量名保留）——`rm <link>` 只删链接不穿目标仍放行，`rm <root>` 删主仓根仍拦；find 起点/内容写保持全解析。
4. **孤儿清理（无残留）**：`cdFormDiverges`/`isInsideMainCheckoutRaw`（一轮撒谎形态否决器）——其守卫的 cd 豁免门已随 #1523 删除，同语义由求值器真实落点正证据承担（撒谎 cd 目标解析真身后落主仓写即 BLOCK）。

**语义迁移钉（测试对齐主侧 S1 口径）**：

- **显式意图边界翻转**：`cd 主仓 && git commit` 放行→拦（主侧 bash-safety-guard.test.ts:1148 同形态已翻转：「原『显式意图放行』是豁免门整条放行语义（S1 同源，期望翻转）」）——与 R1「主仓改动走 worktree+PR」一致化。
- **取舍 6 三轮复核：结论不变（多级树外例维持拦截）**，依据更新——结构兜底通道（checkSegmentStructuralWrite git 写族段，F20261014cwsp S1「树外不豁免」语义的保留面）对非工作树 cwd 的 git 写族 fail-closed「只加拦不放行」，覆盖求值器正证据 ALLOW；**外部 worktree 间接写主仓 .git 口子同被该通道关在 fail-closed 侧**（二轮取舍 6 担心的口子随判据迁移自动闭合）。

**验证（三轮）**：回归钉 20/20（两处语义迁移钉按主侧口径改写并注锚）；exam 棘轮 3/3 无 GAP_DIFF（climbPath→保留 `..` 对非 symlink 语料逐比特同语义实证）；**全仓 397 files 6219 passed + 6 skipped 零失败**（首跑过，无 flake）；tsc / eslint 净。
