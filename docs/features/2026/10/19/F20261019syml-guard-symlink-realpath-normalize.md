---
id: F20261019syml
title: bash 守卫——symlink 逃逸链 realpath 归一化（ln -s 主仓→worktrees 区 + 写/删穿链两步全放收口）
summary: M-ed285d7c（#1515 delta 建议 2 立档）：ln -s <主仓内容> <worktrees 区>/link 后 git -C <link> 写族 / cd <link> && 写 / echo > <link>/f / rm <link>/sub 的字符串落点在运行时区（豁免命中）而真实落点在主仓内容树——两步全放。判定基元（wv pathWithinMain / prod isInsideMainCheckout、classifyDestructiveTarget、git -C 落点累积）路径比较前 symlink 穿透归一（safeRealpath 最深存在祖先回拼）；显式意图豁免加「声明形态=真实落点」分歧一票否决（诚实 cd 主仓照旧放行）
type: BugFix
date: 2026-10-19
capability_test: "n/a（change_type=BugFix）：回归钉 tests/frameworks/agent/bash-guard-symlink-realpath.test.ts（拦截侧 5 + 放行侧 4 + 基元 3，真 fs symlink 拓扑）"
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
