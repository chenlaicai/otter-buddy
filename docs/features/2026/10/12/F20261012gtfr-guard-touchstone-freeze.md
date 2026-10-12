---
id: F20261012gtfr
title: 试金石三库冻结——一步到位验收语料入库（放行/拦截/条件期望 + CI 冻结完整性断言）
summary: 「bash 一步到位」方案 §四 的语料工程化收口：1006 条 unique 真实数据经 §3.2.1 证明演算裁决 + 双签口径重刷，冻结为三库（放行 780 / 拦截 48 / 条件期望 108）进 tests/fixtures，CI 断言门（verdict 二值 / SKIP=0 / id+命令跨库唯一 / 残余面 7 条钉名 / 全量遍历守恒）。剔除 30 + 非写维度附录 40 显式记档；残余面 7 条（真实误拦但 fail-closed 仍拦）residual_face 如实钉 BLOCK 不许隐身。重刷变化数：git 口径翻转 68、条件期望 108、O-2 归池 26、剔除 20、台账复裁 8。
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
| `guard-touchstone-allow.json` | **780 条**放行池——必须 100% 终局正面 ALLOW |
| `guard-touchstone-block.json` | **48 条**拦截池——synthetic_probe 21 / real_command 18 / residual_face 7 / signed_dispo 2 |
| `guard-touchstone-conditional.json` | **108 条**条件期望——无 cd cwd 不可反查：worktree→ALLOW / 主仓→BLOCK 双态各跑（两目录各测，不冤枉不放水） |
| `touchstone-recheck-diff.md` | 76 条复裁差异清零记录（git 族终版口径 + 8 条台账复裁处置） |
| `touchstone-exclusions.md` | 剔除 30 条（语义边界待裁/文件不可得/截断反查不到/SKIP）+ 残余面 7 条立册 |
| `touchstone-build-record.md` | 构建记录（来源计数/去重/方法论/裁决期 15 个判据 bug 修复记档/cwd 口径边界） |

## 双签口径（裁决标准的收口层）

- **git 族**：push（远端）/fetch=非写放行（fetch 记档 .git 镜像写残余）；push 本地路径例外按落点判；**pull=写按落点判**（检视獭驳回「非写」，大獭认）；add/commit/merge/rebase/branch -D/checkout/switch/worktree remove=写按落点判；**worktree add 立豁免**（排除区创建+记账写）
- **cwd 不可反查**→条件期望双态各跑（平 ALLOW=放水口、保守 BLOCK=冤枉好人，双双废止）
- **O-2 已拍板纳入**（读脚本内容判定）：归池三修——复合命令拆段归桶可判段先行 / 脚本内容裁决钉 hash 防 TOCTOU / heredoc 生成并执行的「内容」=命令内载荷体可判
- **残余面 7 条如实钉**（§3.3-①）：TS-40e54fac / TS-b61fa381 / TS-2562bd65 / TS-ef0d6be4 / TS-547d0252 / TS-1acea2b8 / TS-1c317a90——真实误拦但 `new Function`/`execSync` 正道形态 fail-closed 仍拦；钉 BLOCK 防未来放宽被误当修复面，**能力演进放行须重新裁决**（终审已呈搭档知悉）

## 验证

- `npx vitest run tests/frameworks/agent/guard-touchstone-corpus.test.ts`：meta 契约 / verdict 二值 / SKIP=0 / 锚点与裁决依据齐备 / id+命令跨三库唯一 / 残余面 7 条钉名 / 全量遍历守恒（780+48+108）/ 重刷变化数锚（68/108/26/20/8）
- 守恒审计：1006 unique = 780+48+108+剔除 30+附录 40（全量去向可数）
- 交叉校验：healing【误报】定性 75 事件与裁决终态冲突 0；影子 residual 18 条修复面 17 条翻入放行池

## 影响范围

- 纯数据 + 测试断言 PR：不改任何生产代码/判定逻辑
- `tests/fixtures/guard-touchstone-*.json`（新增三库）、`touchstone-*.md`（新增记录文档）、`tests/frameworks/agent/guard-touchstone-corpus.test.ts`（新增断言）
- 下一步（另行派工）：能力补全 1→6（每步全量试金石复跑）；O-2 语义边界待裁项（otter-buddy.sh 主仓根记账写）呈拍板后归池
