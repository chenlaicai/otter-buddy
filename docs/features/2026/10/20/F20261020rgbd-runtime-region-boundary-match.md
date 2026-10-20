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

## 审视 S1 处置（delta，2026-10-20 守卫修复獭）

来源：检视獭1578 首轮审视建议 S1（非阻断）——「guard-write-eval-corpus.json 的 4 条 ledger 样本（c080/c081/c083/c084，2026-10-09 workforms-retire 同族）verdict 仍 ALLOW 未随重裁同步，shadow-write-eval.mjs 下次影子跑会报假警报」；大獭裁决「合入前顺手收」路由本獭。机制识别检查点逐项核对全否（shadow status 系纯运行时报告分支，不持久化不影响后续行为）→ 修法决策树① narrow-fix，Modification-Class: narrow-fix。

### 处置 1：4 条 verdict 随 A′ 重裁同步（S1 字面）

- `tests/fixtures/guard-write-eval-corpus.json` c080/c081/c083/c084：verdict ALLOW→BLOCK，note 追加【重裁 2026-10-20·A′】留痕（与 guard-touchstone 翻红条目同源口径：workforms-retire 仿名 sibling 不豁免，隐式写/载荷写落主仓判定域），verdictBy 更新；c082（worktrees 子树正道）不动——同族同判，不拆条

### 处置 2：shadow 截断剔除条件对齐预注册（S1 达标的必要部分）

- **现象**（实跑取证，非推测）：处置 1 单独落地后跑 shadow，c080/c081 → AGREE（假警报消除）但 c083/c084 → RED-LINE-ESCAPE×2（假警报换形态）——截断载荷（commandHead 120 字符、引号不闭合、写调用在丢失的载荷尾部）下求值器判 evaluated 空集放行而非 FALLBACK，原剔除条件 `isTruncatedPayload && evalVerdict === "FALLBACK"` 不覆盖
- **论证（为何改剔除条件而非其他）**：
  1. 预注册原文「两类样本均从切换判据分母剔除」（scripts/shadow-write-eval.mjs 注释，F20261009phs2 预注册）——「均剔除」= 无条件；实现只剔 FALLBACK 是「截断→回落」单路径假设。实测截断 21 条仅 5 条 FALLBACK、16 条给出判定，实现与预注册的差距由数据实证
  2. 剔除语义 =「语料源缺陷不是求值器的覆盖缺口」——截断命令不是完整命令，其上的任何求值器输出都不度量求值器
  3. 不放宽任何真实防线：全形态行为由合成样本 + touchstone 钉死（guard-touchstone-corpus.test.ts 断言 workforms-retire 族全 BLOCK），截断样本留档不删、TRUNCATED_PAYLOAD 剔除数照旧单独披露
  4. 被否路径：修求值器「引号不闭合载荷判回落」（治本方向但超 S1 范围、影响 c044 等一批样本，转记档）；只翻 c080/c081 不翻 c083/c084（同族拆判，违同族同判纪律）；给 c083/c084 补 EXPECTED-CROSS 标注（语义撒谎——它们正是 main_write 维度）
- 修改：`scripts/shadow-write-eval.mjs` 剔除分支一行对齐 + 注释记档（无新增文件/依赖，已过最简实现检查）

### 验证（shadow 三跑数字链，dist = PR #1578 边界匹配 build）

| 状态 | AGREE | GAIN | OVERBLOCK | RED-LINE-ESCAPE | BOTH-DIVERGE | 判据 |
|---|---|---|---|---|---|---|
| 基线 HEAD（git stash 对照） | 71 | 29 | 1（c091 预存） | 0 | 16（含 c080/c081） | 未达标（误拦 1） |
| 仅处置 1 | 73 | 27 | 1 | 2（c083/c084 假警报换形态） | 14 | 未达标 |
| 处置 1+2（最终） | 72 | 15 | 0 | 0 | 14 | **达标**（剔除跨规则 6/截断 21） |

- 不能误伤的一侧：非截断样本 status 判定逻辑零改动（BOTH-DIVERGE 14 条全为预存样本，与基线 16 − c080/c081 转 AGREE 对账闭合）；CROSS_RULE 6 条剔除照旧；c080/c081 拦截侧由 touchstone 测试 + 本 PR 钉子 5 组固化（放行侧 worktrees/workforms 本体+子树同批固化）
- 基线证据文件：对话工作区 shadow-baseline-head.json（git stash 复跑产出，pre-existing 声明硬门禁合规）
- 全仓 vitest 见 PR Verification 节

### 记档（不入本 PR，Discovered Issues 归口）

- 观察项 A：求值器对引号不闭合/截断 node -e 载荷判 evaluated 空集放行（fail-open 形态）——真实命令引号不闭合 bash 起不来，实际不可利用（低危），但「空集=有把握放行」的口径值得求值器覆盖 gap 治理时一并看
- 观察项 B：c091（`python3 -c "import ast; ast.parse(open(...).read())"` 截断样本）求值器判 BLOCK 疑似对只读链误判——剔除后不可确证是否截断误导，留 M-141dde95 影子观察域，不随本 PR 排期
