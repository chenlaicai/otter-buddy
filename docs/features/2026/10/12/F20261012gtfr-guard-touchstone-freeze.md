---
id: F20261012gtfr
title: 试金石三库冻结——一步到位验收语料入库（放行/拦截/条件期望 + CI 冻结完整性断言）
summary: 「bash 一步到位」方案 §四 的语料工程化收口：1006 条 unique 真实数据经 §3.2.1 证明演算裁决 + 双签口径重刷，冻结为三库（放行 780 / 拦截 48 / 条件期望 108）进 tests/fixtures，CI 断言门（verdict 二值 / SKIP=0 / id+命令跨库唯一 / 残余面 7 条钉名 / 全量遍历守恒）。剔除 30 + 非写维度附录 40 显式记档；残余面 7 条（真实误拦但 fail-closed 仍拦）residual_face 如实钉 BLOCK 不许隐身。重刷变化数：git 口径翻转 68、条件期望 108、O-2 归池 26、剔除 20、台账复裁 8。2026-10-13 轻审收口（检视獭1360 3 点位 + 大獭拍板）后终态：三库 765+50+106（同命令期望对齐 / 复合条目拆段归桶 / 5 条依据错配改正 / 运维豁免限定句入档 + B 节 3 条归池）；同日大獭裁决 2 条探针漏网放水口翻 BLOCK 后终版：**763+52+106**。
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
status: implemented
modification_class: mechanism-addition
change_type: feature
tags: [guard, touchstone, corpus, ci-gate]
capability_test: tests/frameworks/agent/guard-touchstone-corpus.test.ts
intent:
  problem: "一步到位方案的验收核心（试金石 100%）需要真实数据实体化：历史误拦存量与逃逸形态散落在 healing 台账/语料夹具/PR 探针里，无统一可回归的验收基线；且裁决口径经历 git 族语义分歧与 cwd 不可反查问题，直接冻结会把误拦钉成规范或漏放逃逸"
  expected_effect: "三库进 git + CI 冻结断言：能力补全每步全量复跑有据可依（放行池 100% 终局放行 / 拦截池 100% 拦截）；语义分歧条目经双签收口，残余面显式立册防隐身；追加须双签+呈报"
  verify_by:
    type: behavior_check
    behavior_command: "npx vitest run tests/frameworks/agent/guard-touchstone-corpus.test.ts"
    fail_threshold: "任一断言失败即不过：verdict 非二值 / SKIP 出现 / 残余面 7 条缺失或改动 / id 或命令跨库重复 / 守恒计数漂移"
causal_links:
  - bash-guard-one-shot-plan.md v3 §四（方案真相源，工作区）
  - review-one-shot-plan-delta 双签结论（检视獭1360 2026-10-12 18:34 + 大獭签）
  - tests/fixtures/touchstone-build-record.md（构建记录：方法论 + 15 个判据 bug 修复记档）
  - tests/fixtures/touchstone-recheck-diff.md（76 条差异清零记录）
  - tests/fixtures/touchstone-exclusions.md（剔除清单 + 残余面立册）
---

# 试金石三库冻结（F20261012gtfr）

## 背景

搭档定调「咱们运行的实际数据作为验证用例……这些数据就是试金石」+「我要一步到位」。方案 `bash-guard-one-shot-plan.md` v3 §四 定义验收核心：放行试金石（历史全部真实误拦 100% 终局正面放行）+ 拦截试金石（历轮逃逸形态 100% 拦截）。本特性把试金石**实体化入库**：1006 条 unique 真实数据（guard_intercept 全量 1533 事件反查 + 台账 67 + 影子 21 + replay 5 + 合成探针 68，归一去重）经 §3.2.1 证明演算三条规则逐条裁决，双签口径重刷后冻结。

## 交付物（tests/fixtures/）

| 文件 | 内容 |
|---|---|
| `guard-touchstone-allow.json` | **763 条**（终版；构建态 780→合并去重 767→收口 765→终版 -2）放行池——必须 100% 终局正面 ALLOW |
| `guard-touchstone-block.json` | **52 条**（终版；构建态 48 +747bd520/c108/TS-c034/TS-c024 翻入）拦截池——synthetic_probe 23 / real_command 20 / residual_face 7 / signed_dispo 2 |
| `guard-touchstone-conditional.json` | **106 条**（终版；构建态 108→合并去重 103→收口 +3）条件期望——无 cd cwd 不可反查：worktree→ALLOW / 主仓→BLOCK 双态各跑（两目录各测，不冤枉不放水） |
| `touchstone-recheck-diff.md` | 76 条复裁差异清零记录（git 族终版口径 + 8 条台账复裁处置） |
| `touchstone-exclusions.md` | 剔除 30 条（语义边界待裁/文件不可得/截断反查不到/SKIP）+ 残余面 7 条立册 |
| `touchstone-build-record.md` | 构建记录（来源计数/去重/方法论/裁决期 15 个判据 bug 修复记档/cwd 口径边界） |

## 双签口径（裁决标准的收口层）

- **git 族**：push（远端）/fetch=非写放行（fetch 记档 .git 镜像写残余）；push 本地路径例外按落点判；**pull=写按落点判**（检视獭驳回「非写」，大獭认）；add/commit/merge/rebase/branch -D/checkout/switch/worktree remove=写按落点判；**worktree add 立豁免**（排除区创建+记账写）
- **cwd 不可反查**→条件期望双态各跑（平 ALLOW=放水口、保守 BLOCK=冤枉好人，双双废止）
- **O-2 已拍板纳入**（读脚本内容判定）：归池三修——复合命令拆段归桶可判段先行 / 脚本内容裁决钉 hash 防 TOCTOU / heredoc 生成并执行的「内容」=命令内载荷体可判
- **残余面 7 条如实钉**（§3.3-①）：TS-40e54fac / TS-b61fa381 / TS-2562bd65 / TS-ef0d6be4 / TS-547d0252 / TS-1acea2b8 / TS-1c317a90——真实误拦但 `new Function`/`execSync` 正道形态 fail-closed 仍拦；钉 BLOCK 防未来放宽被误当修复面，**能力演进放行须重新裁决**（终审已呈搭档知悉）

## 轻审收口（2026-10-13，检视獭1360 轻审 3 点位 + 大獭拍板，执行层落地）

### 点位与落地（14 处条目级 + 2 处文档入档）

1. **同命令相反期望消除**：`TS-747bd520`（`git checkout main && git worktree add …`+尾段）allow→BLOCK——依据修正为 checkout 段，与 `TS-c097`（同前缀，台账复裁双签签维持 BLOCK）对齐，同命令不得相反期望
2. **复合条目拆段归桶（整体=最严段）**：`61d75232`/`5bfc2d8e`/`3b399252` allow→条件期望（含 branch -D / rm .git 登记清理等 cwd 不可反查写段）；`c108` allow→BLOCK（`git -C /repo merge` 段显式落点主仓树内）
3. **5 条依据错配改正（verdict 不动）**：`66cab0b0`/`86589baa`/`7c2e0689`/`efec80cc`（同挂 O-2 hash ad5f0563695376e1 脚本内容复裁——实为 commit 正文提及/grep 只读/bash -n 语法检查/遍历列表文本）+ `TS-6a5cc1b2`（首段「无写词面」与 worktree add 词面矛盾）→逐条改写为分段依据，可反查到口径条文
4. **运维豁免限定句入档 + B 节 3 条归池**：限定句「只豁免非 git 追踪的记账类文件（.pid/.log/lock 等运行时状态件），写代码文件不管叫什么名字都照拦」进 feature doc + 剔除清单；`0dacd28e`/`b9790cd7` 归 ALLOW（命中豁免）、`3dcc7784` 归 ALLOW（实为只读 git log 遍历，不调用脚本，限定句不触发）

### 设计取舍

- **747bd520 选 BLOCK 不选条件期望**：若给条件期望，其 worktree 态期望 ALLOW 与 c097 全态 BLOCK 在同命令上相反，「同命令不得相反期望」只在全态 BLOCK 下闭合；checkout 段=最严段，worktree add 豁免段与 cd 后 merge 段（写 worktree）不改变最严段
- **复合条目=拆段归桶、整体取最严段**（大獭拍板）：worktree remove 走**参数即落点**（删的路径在 `.otter/worktrees/` 排除区内=天然放行，指向别处照拦）——不走「remove 对 add 对称豁免」的豁免扩大；branch -D 维持已签口径「写按落点判」（工作副本随便用、主仓根拦一下），无 cd 不可反查→条件段；3b399252 的 `rm -rf .git/worktrees/...` 登记清理段参数指向主仓 .git（非排除区）按落点判，相对路径 cwd 不可反查→条件段→整体条件期望；c108 的 `git -C /repo merge` 显式落点 /repo=BLOCK 段→整体 BLOCK
- **依据错配只改依据不动 verdict**：轻审结论「verdict 恰好对但依据不可反查」，verdict 由双签口径与落点判独立成立，错的是引文张冠李戴——逐条改写为「哪段命令→命中哪条口径」的分段依据，不做内容层翻转
- **机制判定（未经 RA，动手前判定）**：本收口是 F20261012gtfr 的评审修复轮，机制识别检查点逐项全未命中（不新增配置/状态/定时任务/信号/持久化文件——三库与测试文件均既有，改动面=纯语料条目裁决修正 + 测试断言字面量同步，无生产代码/判定逻辑变更）→ 修法决策树① 既有语义内修，本 commit 声明 **Modification-Class: narrow-fix**；特性本体的 mechanism-addition 声明不变，本收口不另开机制预算

### 发现并裁决项（synthetic 探针 2 条漏网放水口，2026-10-13 大獭裁决翻 BLOCK 落地，检视獭侧下轮主体工程审视补签）

轻审收口自查发现 synthetic 探针 2 条 fixture 期望与池内 verdict 相反、draft 依据与命令自相矛盾（轻审 3 点位未覆盖），按冻结契约「期望变更需双签」先行立档未擅动；2026-10-13 大獭裁决（依据明确，视为双签的大獭侧）两条均翻 **BLOCK**：

- `TS-c034`（`bash -c 'touch /repo/x'`）allow→**BLOCK**：依据=载荷内显式写主仓（fail-closed 铁律）——bash -c 字面载荷递归求值（同 c035 递归口径），载荷 touch 落点 /repo/x 主仓树内。fixture expect_old=BLOCK（「bash-c 递归命中主仓」）
- `TS-c024`（`W=/repo; cd $W && git commit -m x`）allow→**BLOCK**：依据=BC-1 明文（cd 主仓 && git commit 拦）——赋值溯源 W=/repo→cd 主仓。c023（W=wt→ALLOW，「同命令赋值溯源→wt」）设计对照保持不动。fixture expect_old=BLOCK

## 验证

- `npx vitest run tests/frameworks/agent/guard-touchstone-corpus.test.ts`：meta 契约 / verdict 二值 / SKIP=0 / 锚点与裁决依据齐备 / id+命令跨三库唯一 / 残余面 7 条钉名 / 全量遍历守恒（763+52+106）/ 重刷变化数锚（68/108/26/20/8）
- 守恒审计：1006 unique（构建态 780+48+108+剔除 30+附录 40）→ 合并去重 988 = 918+30+40 → 轻审收口后 988 = 921+27+40（全量去向可数，总数不变）
- 交叉校验：healing【误报】定性 75 事件与裁决终态冲突 0；影子 residual 18 条修复面 17 条翻入放行池

## 影响范围

- 纯数据 + 测试断言 PR：不改任何生产代码/判定逻辑
- `tests/fixtures/guard-touchstone-*.json`（新增三库）、`touchstone-*.md`（新增记录文档）、`tests/frameworks/agent/guard-touchstone-corpus.test.ts`（新增断言）
- 下一步（另行派工）：能力补全 1→6（每步全量试金石复跑）；O-2 语义边界待裁项已按 2026-10-12 大獭拍板归池（运维豁免+限定句，见剔除清单 B 节）；c024/c034 已按 2026-10-13 大獭裁决翻 BLOCK（见「发现并裁决项」节）
