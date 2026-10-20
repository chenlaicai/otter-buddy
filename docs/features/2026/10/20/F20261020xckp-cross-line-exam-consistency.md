---
id: F20261020xckp
title: 跨产线考题一致性核对——#1467 replay 13 用例 vs #1466 touchstone 双库（M-3f8d8a0d 收口）
summary: 2026-10-20 全量重核（10-14 对照后 main 经 #1554/#1565/#1570/#1578 十余 PR 演化）：13 用例 × 三库全量 982 条（921 系语料守恒数=982−TS-smrj 新增系 61，比对面为全量 982）全等/近似同命令比对，全等命中仅 1 对（1013-B2 vs TS-smrjreg18f0c467）且系 2026-10-14 已裁决层差对（双法院两案非反判）——零新反判；层差注记落位收口：touchstone 侧 5 条 2026-10-14 已落，#1467 侧 2 处（1013-B2 双法院注记、1013-B5 重裁兑现钩子更新）本次补位。
capability_test: "n/a: 纯注释补记不改执行逻辑——guard-v2-real-replay + guard-touchstone-corpus 两套测试复跑 28 passed | 6 skipped（6 skip 系 1013-A1..A6 挂 #1468）双绿，行为断言零改动"
change_type: fix
intent:
  problem: "M-3f8d8a0d（2026-10-14 立）：#1467 guard-v2-real-replay 13 用例与 #1466 guard-touchstone 双库是跨产线两套考题，同命令不得反判。10-14 首轮对照查出 2 对同命令反判（层差），大獭裁决「层差记档口径成立，双库强行对齐不走」（L1），本库侧 5 条层差注记已落，#1467 侧注记由固化獭补——但未落位，matter 悬置 6 天"
  expected_effect: "跨产线一致性在 2026-10-20 main 上重核成立（零新反判）+ #1467 侧层差注记落位，M-3f8d8a0d 闭环条件齐备"
  verify_by:
    type: behavior_check
modules:
  - tests/frameworks/agent/guard-v2-real-replay.test.ts
from:
  - F20261015smrj
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_by: 守卫修复獭
---

## 背景（M-3f8d8a0d，2026-10-14 立项）

#1467（guard-v2-real-replay，10-13 拦截数据固化 13 用例）与 #1466（guard-touchstone 三库，921 条）是两条产线的考题：前者钉 V1/V2 判定链行为，后者钉 v2 求值器语义。两库考的是两个法院，但**同一命令不得反判**。

2026-10-14 首轮对照（F20261015smrj「与 #1467 的跨产线对照」节）结论：13 用例逐条对照 A1-A6 同族同判 ✓、B1/B3/B4/B6/B7 无同命令不涉 ✓；2 对同命令反判，均裁决为层差（大獭 2026-10-14 L1 拍板：层差记档口径成立，双库强行对齐不走——两库考的是两个法院，硬对齐反而搅浑）：

1. **1013-B2 对**：`git push origin --delete feature/F20261012orcl-acceptance-oracle-gate`（全等文本）——#1467 钉 BLOCK（策略层「破坏性远端操作」R1.4 负门）vs touchstone TS-smrjreg18f0c467/c170d88c 判 ALLOW（求值器法院「写没写主仓」零本地树写）→ 双法院两案非反判
2. **1013-B5 对**：`bash data/workspaces/…/do-commit.sh`（同形同脚本）——#1467 钉 BLOCK（V1 现状，自带「翻转须重裁」钩子）vs touchstone TS-smrjregc0c9c6a6/3064857e/cb2c9109 判 ALLOW（v2 载荷判读，脚本内容 git -C "$WT" add/commit 实质安全）→ 重裁已兑现（signal d5f2ae9a + 2026-10-14 全天候选裁决），终态以 v2 为准

处置：本库侧 5 条考题 adjudication 落层差注记（2026-10-14 已落）；**#1467 侧注记由固化獭补**（大獭回签 PR #1467 comment 6160667395），M-3f8d8a0d 转入等注记落位——悬置至今（6 天），本次收口。

## 本次核对（2026-10-20，全量重核）

**方法**：10-14 对照后 main 经 #1515/#1518/#1519/#1526/#1533/#1554/#1565/#1570/#1578 等十余 PR 演化（词文本收编、运行时区边界匹配、5 条语料翻红），对照结论需在今日 main 重核。提取 guard-v2-real-replay.test.ts 1013 族 13 用例命令，与三库全量 **982 条**（allow 791/block 87/conditional 104，2026-10-20 实数；921 系 corpus 测试钉的语料守恒数=982−TS-smrj 新增系 61，corpus.test.ts:106/:125 口径，比对面为全量 982）做归一化全等比对 + token 集合 Jaccard>0.85 近似比对；两套测试实跑。

**结果**：

| 核对项 | 结果 |
|---|---|
| 全等同命令命中 | **仅 1 对**：1013-B2 == TS-smrjreg18f0c467（j=1.00）——已知层差对，无新增（该对属 TS-smrj 新增系，守恒口径 921 下不命中、全量口径 982 下命中——两条口径下结论一致） |
| 近似同命令命中 | 同上 1 对（其余 12 用例三库无同命令——「无同命令不涉」与 10-14 结论一致） |
| 新反判 | **零**（#1578 翻红的 workforms-retire 族与 13 用例无交集；#1570 词文本收编不涉 13 用例词面） |
| 两套测试实跑 | guard-v2-real-replay + guard-touchstone-corpus：**28 passed \| 6 skipped 双绿**（6 skip=1013-A1..A6 挂 #1468 修复，非遗留红） |

**口径注解（1013-B5 双层口径，检视獭1582 建议 S2 落位）**：上表「三库无同命令」系**测试固化命令层**（今日 test 文件文本 `bash …/wt-test.sh …`）口径；10-14 对照的「同形同脚本」层差对系**样本命令层**（healing 台账 7daea038 原文 `bash …/do-commit.sh`）口径。两层文本不同（脚本名已演化）但同属 script_file_exec 负门族同构；两层下 1013-B5 均系已裁决层差对（V1 现状 BLOCK vs v2 载荷判读 ALLOW，见用例内注记双层锚点）。

**同族不同判的边界确认**（设计差异非反判，10-14 口径沿用）：1013-B1 `git stash push`（cwd=主仓）BLOCK vs touchstone `cd wt && git stash` ALLOW 等——同族但 cwd/落点不同命令，按落点语义分判是设计。

## 层差注记落位（M-3f8d8a0d 闭环条件）

| 侧 | 状态 | 内容 |
|---|---|---|
| guard-touchstone 5 条（TS-smrjreg18f0c467/c170d88c、c0c9c6a6/3064857e/cb2c9109） | ✅ 2026-10-14 已落 | adjudication 含「层差注记（大獭裁决 2026-10-14，M-3f8d8a0d 跨库对照）」全文 |
| #1467 侧 1013-B2 | ✅ **本次落位** | 双法院注记（求值器法院/策略层法院两案非反判 + 2026-10-20 重核无新增） |
| #1467 侧 1013-B5 | ✅ **本次落位** | 承接原「翻转须重裁」钩子追加重裁兑现记录（d5f2ae9a + 2026-10-14 裁决，终态 v2=ALLOW，本用例钉 V1 现状系层差记档） |

旧注记不删不改（新建追加铁律），断言零改动。

## 影响范围

- 仅 tests/frameworks/agent/guard-v2-real-replay.test.ts 两处注释追加，执行逻辑/断言/期望值零改动
- 无 src 变更、无语料变更、无行为变化

## 验证

- 两套测试复跑：Test Files 2 passed，Tests 28 passed | 6 skipped（本页改动前后同数）
- 注记落位前后 diff 仅注释行（见 PR）
- 跨产线全等/近似比对脚本核对记录：见本文「本次核对」节表格
