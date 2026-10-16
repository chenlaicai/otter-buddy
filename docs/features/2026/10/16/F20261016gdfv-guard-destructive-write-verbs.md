---
id: F20261016gdfv
title: bash 守卫——破坏/写词表补齐族（rm 主仓破坏面 prod 洞 + git stash 写族子命令双层放行 + find -delete 双层放行）
summary: M-c78df9d4（X1/X2 探针：rm -rf 主仓根/内容树 prod:ALLOW / wv:BLOCK 双层反判，宪法洞表开放登记）+ issue #1522（stash pop/apply/drop/clear/store/branch 双层放行）+ find -delete 双层放行（探针新发现）并案收口——破坏命令目标域从 data/ 扩主仓内容树（与 wv pathWithinMain 同口径豁免运行时区）、git stash 写族子命令全集收编（STASH_WRITE_SUBS 两侧共享）、find -delete 入 wv 词表，双链同判
type: BugFix
date: 2026-10-16
capability_test: "n/a（change_type=BugFix）：回归钉 tests/frameworks/agent/bash-guard-destructive-verbs.test.ts 10 例（修复侧+不误伤侧）+ guard-intercept-classify 2 例；guard-touchstone exam 棘轮对照零 GAP_DIFF"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
intent:
  problem: "M-c78df9d4 + issue #1522 并案（大獭 16/10 12:08 派工「一个 PR 修齐」）：破坏/写词表三处覆盖缺口——① prod 侧破坏命令目标域只盖 data/，rm -rf /repo（主仓根/内容树）prod:ALLOW / wv:BLOCK 双层反判（X1/X2 探针实证，宪法洞表开放洞），mv 只查源端漏移入主仓；② git stash 写族子命令只认 push，pop/apply/drop/clear/store/branch（git-stash(1) 明文写面）双层放行；③ find 不在 wv 词表，find -delete 双层放行"
  expected_effect: "探针矩阵反判/双放行面收口：rm -rf /repo 与 /repo/src、mv 移入主仓、find -delete、stash pop/apply/drop/clear/store/branch 两层同判 BLOCK；worktree/工作区清理正道（运行时三区豁免与 wv 同口径）、stash 读面 list/show/create、find 无 -delete 形态照常放行；修复侧与不误伤侧都钉回归测试（bash-guard-destructive-verbs 10 例 + 分类 2 例）；全量 vitest 绿 + guard-touchstone exam 棘轮无 GAP_DIFF + 宪法洞表同步"
  verify_by:
    type: behavior_check
from: []
supersedes: []
---

# bash 守卫——破坏/写词表补齐族（M-c78df9d4 + #1522 并案）

## 排查结论（案情与根因，修前探针实证）

M-c78df9d4 的 X1/X2 探针（独立复跑实证，`checkBashCommandSafety` prod gate + `evaluateWriteVerdict` wv，projectRoot=/repo，sessionCwd=/repo/data/workspaces/conv-1）：

| 命令 | prod | wv | 定性 |
|---|---|---|---|
| `rm -rf /repo`（主仓根） | ALLOW ✗ | BLOCK ✓ | **双层反判（X1，宪法洞表开放洞）** |
| `rm -rf /repo/src`（内容树） | ALLOW ✗ | BLOCK ✓ | **双层反判（X2）** |
| `mv /tmp/x /repo/y`（移入主仓） | ALLOW ✗ | BLOCK ✓ | 双层反判（同族，探针新发现） |
| `find /repo -name x -delete` | ALLOW ✗ | ALLOW ✗ | **双层放行（真破坏面，探针新发现）** |
| `git stash pop/apply/drop/clear/store/branch` | ALLOW ✗ | ALLOW ✗ | **双层放行（#1522）** |

根因（三侧词表/目标域缺口）：

1. **prod 侧破坏命令目标域只盖 data/**：`classifyDestructiveTarget`（原 `resolvesToMainData`）只判 `data/` 归属——主仓根/内容树目标漏拦；mv 只查源（args[0]），目标端漏拦；
2. **git stash 写族子命令只认 push**：`isWriteVerbAt`（payload-extract-aux.ts）与 `evalGitWrite`（write-target-evaluator.ts）的 stash 限定语义 `next === "push"` 漏 pop/apply/drop/clear/store/branch（git-stash(1) 明文写面）；两条写族正则（SUBSHELL_GIT_WRITE_GATE / GIT_WRITE_LITERAL_PATTERN）同样只有 `stash\s+push`；
3. **find 不在 wv 词表**：TARGET_ARG_COMMANDS 无 find → `find -delete` 双层放行。

白名单侧不受影响（git-readonly-whitelist stash 只读面收窄为显式 list/show 已在 F20261016gwr1 修复轮落地）；`git stash create` 只打印对象名不落 stash ref/不动工作区（git-stash(1) 明文）→ 归读面。

## 设计取舍

**机制识别检查点（修法决策树）**：七项不命中——非输入校验缺、非加密/认证语义、非并发时序、非资源生命周期、非数据一致性、非错误传播、非接口契约破坏。病型=**既有规则覆盖缺口**（破坏命令判定/git 写族词表的声明语义（R1 主仓保护 + git-stash(1) 明文）已立、覆盖面漏）→ 修法①既有语义内修。**Modification-Class: narrow-fix**（无新层/无新机制/无管辖扩大——补的是宪法洞表已登记的洞与 git-stash(1) 明文写面）。

**取舍 1：破坏目标域扩主仓内容树（data/ → data/+内容树）**。旧 `rm -rf /repo` 漏拦是宪法洞表开放洞（「rm 族写词面归 wv」）——prod 补齐到与 wv 同判。豁免面与 wv `pathWithinMain` 的 OTTER_RUNTIME_REGIONS **逐字同口径**（.otter/worktrees、.otter/workforms、data/workspaces 三区，精确子树前缀）：worktree 清理/工作区操作/外部路径照常放。own-ws 子树豁免（F20261014cwsp S2/S8）与 ~ 保守面（GAP 键 TS-21cee677/TS-a32f51e7 既有误拦面）语义不动。

**取舍 2：mv 双端判定**。旧版只查源（args[0]）：`mv /tmp/x /repo/y`（移入主仓）双层反判；`mv /repo/src /tmp/x`（内容被移走）双层放行。修后双端都判：目标端与 wv 同判，源端 prod-strict（wv 按写入落点只判目标——`mv <主仓内容> /tmp` 的 prod 拦截是刻意保护面，与既有 `mv /repo/data /tmp` 拦截同族，不属本 PR 引入的反判类）。

**取舍 3：stash 写族全集=push/pop/apply/drop/clear/store/branch，读面=list/show/create**。逐词按 git-stash(1) 原文核对（issue #1522 的「假设」项本轮落实）：pop/apply 改工作区、drop/clear 删 stash、store 落 stash ref、branch 建分支+可动工作区=写；create 只打印对象名不落 ref/不动工作区=读。bare ≡ push（F20261016gwr1 修复轮既有结论）；旗标形（stash -m …）= push 形态=写。词表 STASH_WRITE_SUBS 单一真相源（payload-extract-aux 导出，isWriteVerbAt / evalGitWrite 共享），两条写族正则的 `stash\s+push` 同步为 `stash\b(?!\s+(?:list|show|create)\b)`（写族口径两侧同步契约）。

**取舍 4：find -delete 双侧入账**。prod 侧本有 find -delete 判定（只缺目标域）；wv 侧新增 find 条件写面（仅 -delete 表达式入账，读形态 find 不入）。落点=全部非旗标参数（表达式值混入落点集合=保守面，与 tee/touch 同款 fail-closed 哲学）——`find /tmp -name src -delete` 的 name 值被当落点属已知保守面，方向 fail-closed。

**新文案与指纹**：主仓内容树破坏面新文案 MAIN_DESTRUCTIVE_MSG（data/ 面既有 DATA_DESTRUCTIVE_MSG 不动，9/17 事故面语义与 GAP 键稳定）；指纹表加 2 行（对主仓内容区执行了删除/移动操作 → main_write；顺手修「写命令落点解析到主仓」fragment 缺失——session 工作目录形态主仓写文案此前落 unknown）。

**新规则必答三问**（宪法契约）：
1. **挂层**：L2 r1_gate（不可逆破坏→实时拦）——rm 族=data_destructive 既有规则扩目标域+main_write 文案变体；stash 写族/写族正则=main_write 既有判定扩词表。无新层。
2. **carve-out**：①运行时三区（.otter/worktrees、.otter/workforms、data/workspaces）+ own-ws 子树+外部路径照放（清理正道，与 wv 同口径）；②stash 读面 list/show/create 照放；③find 无 -delete 照放。
3. **退役条件**：量化形态——`data_destructive/main_write 两 ruleId 在 healing_events 聚合中连续 4 周误报率 >20% 且零真报 → 精化目标域`；`stash 写族拦截若连续 4 周零真报且正道使用 >100 次 → 收窄为 push/pop/drop 三形`。

**双向生长检查（豁免面自查）**：①运行时三区豁免会不会放走主仓内容？三区均为运行时产物非 git 内容（.otter/worktrees=worktree 清理正道、.otter/workforms=平台运行时、data/workspaces=对话沙盒），且 data/workspaces 落 data 分支先命中（S8 刻意保留跨工作区保护）；②stash 读面豁免逃逸面：create 悬空对象无 refs/工作区副作用（git-stash(1) 明文）；③find 读形态豁免：-delete 条件收口。

**对抗审视发现 1 处置（改判不修，口径之争归 M-cf899ad2）**：检视獭1526 建议 workforms 前缀补尾杠收严（`workforms-x` 三层放行判同型洞）。机械实验（补尾杠后跑 exam）：GAP_DIFF allow 113 vs 110，新缺口键恰为 TS-c8c1cafc / TS-4bd50e86 / TS-5e30a8d5 三条冻结语料裁决（`cd /repo/.otter/workforms-retire && git commit …`，verdict=ALLOW，adjudication「§3.2.1-1 写证据落点全树外→按落点判放行」，台账 2026-10-09）——即收严修法机械翻台账裁决。冻结裁决「workforms 前缀族 sibling=ALLOW」与收严诉求「workforms-x=BLOCK」在同一前缀族上互斥（无第三匹配形态，retire 特判=过拟合禁区）；bare root 不对称（`rm -rf .otter/workforms` 现 ALLOW vs `worktrees` BLOCK）同挂该前缀形态。大獭裁决（objection 3383396e）：方向 C——本 PR 不修，两方向（A 补尾杠+翻台账 / B region 边界改 `^<root>/\.otter/` 口径落码，贴 wv 侧「分界线画在 .otter/ 之外」既有口径注记）均属口径级变更（翻台账=L2、扩豁免面=违反本 PR 射程约束），登记 M-cf899ad2 独立工单拍板。实验改动已回退，本 PR 语义零改动（工作树 clean、exam 3/3 绿）。

## 影响范围

- `src/frameworks/agent/bash-safety-guard.ts`：classifyDestructiveTarget（resolvesToMainData 重写）+ segmentDestructive 目标域/mv 双端 + checkDataDirDestructive 文案分流 + 两条写族正则 stash 词位 + MAIN_DESTRUCTIVE_MSG；
- `src/frameworks/agent/payload-extract-aux.ts`：STASH_WRITE_SUBS 导出 + isWriteVerbAt stash 写族全集；
- `src/frameworks/agent/write-target-evaluator.ts`：evalGitWrite stash 同口径 + find 条件写面入 TARGET_ARG_COMMANDS；
- `src/frameworks/agent/guard-intercept-classify.ts`：指纹 2 行（新文案 + 顺手补 unknown 缺口）；
- `docs/designs/bash-guard-constitution.md`：洞表 rm-prod 行改已修复 + stash/find 双放行洞补录；
- 测试：bash-guard-destructive-verbs.test.ts 新 10 例（修复侧+不误伤侧各半）+ guard-intercept-classify 2 例 + bash-safety-guard.test.ts 2 例期望主动更新（旧断言「rm 主仓内容树放行」=洞面本身，理据注释随行）。

**已知保守面（记档不修）**：①`rm -rf /repo/.otter/worktrees`（裸区目录名）与 wv 同判 BLOCK（wv 路径前缀同边界，一致性优先）；②find 表达式值混入落点集合（fail-closed 方向）；③mv 源端 prod-strict（wv 只判目标，同既有 data 源端拦截类）；④`cd /repo && echo x > f.md` 重定向写主仓 cd 跟踪形态 prod=ALLOW（写链 cd 跟踪既有边界，M-49a4909d 族观察项，探针实证后入 PR Discovered Issues，本 PR 不扩面）。

## 验证

- **修前失败证据**：X1/X2/stash/find 探针矩阵存档（workspace probe-before-gdfv.txt：`rm -rf /repo` prod:ALLOW、stash 六写面双层放行、find -delete 双层放行）；
- **修后同矩阵全转正**（probe-after-gdfv.txt）：X1/X2 prod+wv 双 BLOCK、stash 写面 prod 全 BLOCK + wv main-cwd BLOCK、wrapper/子壳/-C 形态同愈、读面（list/show/create）双层照放、运行时区/工作区/外部路径照放、data/ 面文案守恒；
- 回归：bash-guard-destructive-verbs 10 例 + 分类 2 例 + 全族既有测试（bash-safety-guard #1038 块 2 例期望主动更新）；
- 全仓 `npx vitest run` **371 文件 5747 passed + 6 skipped**（基线 5735 + 新 12）零回归——**guard-touchstone exam 棘轮无 GAP_DIFF**（corpus 冻结面零改动）、guard-v2-real-replay、alias 等价性、F20261016gwr1 全族；
- `npx eslint` 改动面净（3 处体量/复杂度闸按 evalGitWrite 先例豁免注明理由）；`npx tsc --noEmit` 通过。
