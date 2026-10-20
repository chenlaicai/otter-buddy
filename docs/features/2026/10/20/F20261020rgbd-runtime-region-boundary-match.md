---
id: F20261020rgbd
title: 运行时区边界匹配——workforms 仿名 sibling 藏匿洞关闭（M-cf899ad2 A′ 落码）
summary: 台账两裁决互斥（2026-10-09「workforms-retire 落点全树外→放行」vs 2026-10-13「.otter 仅 worktrees/ 子区排除」）的消解落码：chen 2026-10-20 拍板 A′ 边界匹配——.otter/workforms 目录本体+子树豁免照旧、workforms-x 等仿名一律拦。wv pathWithinMainCore + classifyDestructiveTarget 两处裸前缀改精确边界（isInsideMainCheckout 原生即边界匹配，镜像注记统一），关闭任意 sibling 免检写藏匿面；2026-10-09 裁决族 5 条（3 git commit + 2 node -e 载荷写）走【重裁】机制翻红。
capability_test: tests/frameworks/agent/write-target-evaluator.test.ts（M-cf899ad2 A′ describe 5 钉 + 全文件 150/150）+ guard-touchstone 三库守恒（exam 棘轮 40/11/18 键零新增 + corpus 计数守恒 791/87/104 + v2-replay）+ 全量 409 files 6514 passed + 6 skipped 零失败 + tsc/eslint 零报
change_type: fix
intent:
  problem: "OTTER_RUNTIME_REGIONS 尾杠形态差（worktrees 带尾杠=仅子树 / workforms 不带=裸前缀）使 .otter/workforms-x 等任意仿名路径免检——rm/内容写双通道放行=守卫眼皮下藏匿点；且台账 2026-10-09（workforms-retire 树外放行）与 2026-10-13（.otter 仅 worktrees/ 子区排除）两裁决互斥未收敛"
  expected_effect: "workforms 本体+子树豁免照旧（运行时区语义保留，清理正道不动）、workforms-x/retire/evil 仿名双通道 BLOCK（藏匿面关闭）；2026-10-09 裁决族 5 条翻红为 BLOCK（台账矛盾消解，裁决乙正确内核保留、概括修正）；考试棘轮零新增缺口键"
  verify_by:
    type: behavior_check
modules:
  - src/frameworks/agent/write-target-evaluator.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/write-target-evaluator.test.ts
  - tests/fixtures/guard-touchstone-allow.json
  - tests/fixtures/guard-touchstone-block.json
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_by: 守卫修复獭
---

## 问题陈述（M-cf899ad2，论证材料 cf899ad2-口径论证材料.md 三件套在案）

`write-target-evaluator.ts:129` `OTTER_RUNTIME_REGIONS = ["/.otter/worktrees/", "/.otter/workforms", "/data/workspaces/"]`——**一个尾杠字符差承载全部不对称**：worktrees/data-workspaces 带尾杠（仅子树），workforms 不带（裸前缀=含裸名+任意仿名 sibling）。实测（真 root 双通道 10 形态探针）：

- `.otter/workforms-x`/`workforms-evil` 等**任意仿名**：`rm -rf` 与 `echo pwn > …/payload` 双通道免检（藏匿面——攻击者命名 `.otter/workforms-<任意>` 即得免检写点）
- 裸名反判：`rm -rf .otter/workforms` ALLOW vs `rm -rf .otter/worktrees` BLOCK（尾杠形态差）
- 台账互斥：2026-10-09 三条（TS-c8c1cafc/TS-4bd50e86/TS-5e30a8d5，`cd /repo/.otter/workforms-retire && git commit` ALLOW，裁决文「§3.2.1-1 写证据落点全树外→按落点判放行」）vs 2026-10-13 重裁（b1c9e7ec/TS-5c2eaad9，「.otter 仅 worktrees/ 子区排除」BLOCK，且带【重裁前裁决（已废）】先例机制）

## 拍板记录（L2 翻台账）

- 派工简报（大獭 2026-10-20 16:51 大白话双案对照：A′=关洞代价罕见操作人工放行 / C=不动代价洞常开）
- **chen 2026-10-20 17:00「按推荐」**（原话落档，大獭 16:58 显式索取一字裁决留痕）→ 大獭 17:01 A′ 定案派工
- 双签链（语料契约「追加须双签+呈报」）：chen 拍板 + 大獭定案为呈报侧，检视獭本 PR 对抗审视为第二签（meta.rejudge_20261020_cf899ad2 记档）
- 前置事实（大獭四源核实）：workforms*=獭运行时区（bash-sandbox.ts:22 F20261016gsbx G2 对表、write-target-evaluator.ts:117 F20261009phs2 裁决域口径、MAIN_CHECKOUT_WRITE_EXEMPT_REGIONS :1870、F20261016grdl 三元组）——「workforms 整族当内容域拦死」方向不成立

## 修法（narrow-fix，机制识别检查点全否）

**边界匹配**（精确名或子树，仿名 sibling 不豁免）替换裸前缀匹配，两处同病同修：

1. `write-target-evaluator.ts pathWithinMainCore`：`p.startsWith(regionBase)`（无尾杠形态）→ `p === regionBase || p.startsWith(regionBase + "/")`
2. `bash-safety-guard.ts classifyDestructiveTarget` 区域循环：同款裸前缀 → 同款精确边界
3. `isInsideMainCheckout`（bash-safety-guard.ts:1883）**原生即精确名+子树**——镜像注记补 M-cf899ad2 统一声明（同源契约两侧语义归一）

尾杠形态语义逐字保持：带尾杠=仅子树（worktrees 裸名仍主仓域）；不带=本体+子树（workforms 裸名豁免照旧——A′ 明确保留）。

## 台账消解记档（重裁机制，b1c9e7ec 先例形状）

**2026-10-09 裁决族 5 条翻红**（allow→block，adjudication 双文本【重裁前裁决（已废）】+【重裁 2026-10-20·A′/§3.2.1】，recheck 字段留 old_verdict_1009=ALLOW→BLOCK）：

- TS-c8c1cafc / TS-4bd50e86 / TS-5e30a8d5（git commit 形态，gdfv 实验预告的 3 条）
- **TS-59b48d03 / TS-aa9786fe（node -e 载荷写形态）**——同裁决族但 gdfv 实验基线（补尾杠实验）未见，系 #1561 fixture 迁移带入的同族 2 条；棘轮禁止新增缺口键、留池必红，同族同判一并重裁（**3→5 的数量 delta 系事实修正**，在拍板意图「把 2026-10-09 过时裁决翻红」范围内）

**矛盾消解口径**：裁决乙正确内核（local-stash-backup=树内）保留；其「仅 worktrees/ 子区排除」概括修正为「**worktrees/ 子区 + workforms 本体/子树 + data/workspaces/ 子区**」。裁决甲的「workforms-retire 树外」结论过时（其运行时区语义由 workforms **本体+子树**承载，仿名不在内）。

## 影响范围

- 行为变化：`.otter/workforms*` 仿名路径（workforms-x/retire/evil/任意）从免检转保护（rm/内容写/破坏动词/写判定四通道同判）；workforms 本体+子树、worktrees/data-workspaces 子树、root 锚定防 decoy 均不变
- 三区语义统一后 `bash-sandbox.ts`（subpath 精确边界）与守卫两通道口径一致（G2 对表不变）
- 语料池计数：allow 796→791 / block 82→87（total_conserved 1006 守恒不变；考试棘轮 allow 40/block 11/cond 18 键零新增）

## 验证

- **钉子 5 组**（write-target-evaluator.test.ts M-cf899ad2 A′ describe）：判定核仿名不豁免×3、边界内豁免+worktrees 对照+decoy、wv 端到端（echo 写仿名 BLOCK/子树 ALLOW）、prod 双通道镜像（rm/echo 仿名 BLOCK、本体/子树清理 ALLOW）、台账翻转面（workforms-retire 语料形态现判 BLOCK）
- **守恒三库**：exam 棘轮键集零新增（shrink-only 不违）+ corpus 计数断言更新（791/87/104 + restate_changes cf899ad2_region_recheck: 5）+ v2-replay 零翻转
- **全量**：409 files **6514 passed + 6 skipped 零失败**；tsc 0 / eslint 0
- 探针基线对照：重裁前 10 形态真 root 双通道矩阵（工作区 probe-cf899ad2-out.txt）与重裁后判定一致（洞行翻 BLOCK、正道行不动）

## 残余记档

- **裸名反判保留**（知情取舍，A′ 明确保留）：`rm -rf .otter/workforms`（本体豁免照旧）vs `rm -rf .otter/worktrees`（尾杠=仅子树，裸名主仓域）——尾杠形态设计差异，非洞；若未来要统一需另拍板
- **B 案（root 锚定 `.otter/` 全豁免）死案存档**：delta 机械实验翻 11 条 block 全放水（含 local-stash-backup 真实备份面），比 A 的保守侧改动更危险（F20261016gdfv:61 在案）
- 2026-10-09 族翻红后，「目录改名退役」类一次性操作（在 `.otter/workforms-<名>` 开工作区）会被拦——运营纪律改走 `.otter/worktrees/`（R4.5 同源），罕见形态人工放行（chen 拍板时已知悉此代价）
