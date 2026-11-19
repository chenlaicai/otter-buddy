---
id: F20261119claim
title: "issue 认领协议机械执行点：commit-msg 侧闸 + CI 前闸双保险（协调约束从 skill 文本搬回系统层）"
summary: "2026-11-18 #1899 双呈爆雷实证认领协议（F20260901cimp）失效：前世执行了任务同向的开工两问（查 PR/worktree）、跳过收益外部的认领动作（session 铁证 19203）。第一性原理：约束的执行位置必须与收益层级匹配——跨对话协调是系统层约束，住在 skill 文本里靠注意力自律必然被跳过（注意力按任务相关性排序是模型固有属性）。本特性把认领存在性变成两道机械闸：commit-msg 侧闸（message 引用 #N 时核验 otter-claim，未认领拒 commit，每 issue 首次联网检查+标记缓存，网络失败 fail-open）+ CI 前闸 check-pr-claim.mjs（PR 引用 issue 须有认领且 worktree F-ID 与分支匹配，无认领/他线认领红，docs-only 与非 issue 驱动豁免）。skill 文本改为指向闸的引导。"
change_type: feature
capability_test: "n/a: 闸脚本（纯函数判定+gh 查询），以 tests/scripts/check-pr-claim.test.ts（11 用例覆盖谓词正反路径+#1899 实证形态回归）+ CI 实跑本 PR（引用 #1951 已认领，闸应绿）为验证载体"
intent:
  problem: "F20260901cimp 认领协议是纯 prompt 层约定（当时拍板零代码方案），无机械力。2026-11-18 #1899 双呈爆雷实证：前世在事故响应强语境下开工，执行了与任务同向的开工两问（查在途 PR/查 worktree，session 19203 thinking 铁证 'No worktree or PR for #1899 — free'）、唯独跳过收益在外部的认领评论动作；《严重问题》对话接力呈报时同样只查任务态不查归属。同一 skill 内步骤遵从率系统性分化：有机械闸的（commit 模板→hook）100% 遵从、有任务内产出依赖的遵从、本地查询即时有用的遵从、对外留痕但收益在系统层的被跳过——这不是态度问题，是结构性排序。"
  solution: "两道机械闸 + skill 文本降级为引导：①commit-msg 侧闸 scripts/commit-msg-claim-gate.mjs（.githooks/commit-msg 尾部接线）——message 引用 #N 时核验 issue N 的 otter-claim（本 worktree F-ID 匹配才放行；每 issue 首次联网检查后写 $GIT_DIR/otter-claim-ok-N 标记缓存；网络/解析失败 fail-open 放行并警告，CI 闸兜底）；②CI 前闸 scripts/check-pr-claim.mjs（ci.yml check job 接线，与 review-closure 闸同模式）——PR 引用的 issue 须有有效认领（otter-claim-release 可撤销）且认领 worktree 字段的 F-ID 与 PR 分支 F-ID 一致；无 issue 引用/非 OPEN/docs-only 豁免。③worktree-isolation skill 步骤 2 开头标注双闸兜底，文本保留回读退场/双 PR 仲裁/接手预检/接管协议等仲裁规则。"
  expected_effect: "跳过认领从「无代价的自觉失效」变成「commit 被拒/CI 红」的物理阻断；协调约束的执行位置回到与收益层级匹配的系统层；F20260901cimp 的回读退场等仲裁规则继续有效（闸判存在性，仲裁判冲突）。"
  verify_by:
    type: behavior_check
    assertions:
      - "tests/scripts/check-pr-claim.test.ts 11/11：谓词正反路径（匹配绿/零认领红/他线认领红/release 撤销红/豁免三态）+ #1899 实证形态回归（引用 issue 零认领必须红）"
      - "本 PR 自身吃狗粮：引用 #1951 且已按协议认领（worktree=F20261119claim 匹配分支）→ CI 认领闸应绿；commit message 含 #1951 → commit-msg 侧闸应放行并写标记"
      - "skill 文本步骤 2 含双闸指引且不再单独担约束声明"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [issue-discipline, claim-protocol, ci-gate, git-hook, coordination, first-principles]
modules:
  - ci
causal_links:
  - {type: "fixes", id: "issue#1951", note: "认领协议无机械执行点的根因修复"}
  - {type: "extends", id: "F20260901cimp", note: "原纯 prompt 认领协议的机械执行层——文本协议降级为引导+仲裁，存在性核验上收双闸"}
  - {type: "references", id: "F20261118kills", note: "#1899 双呈爆雷为直接实证（PR #1928 双对话呈报）"}
---

# issue 认领协议机械执行点（F20261119claim）

## 实证与第一性原理

2026-11-18 PR #1928 双对话呈报爆雷后排查（session 铁证）：

- 前世开工 #1899 时的 thinking（entry 19203）：`No worktree or PR for #1899 (kill-safety) — free … Now let me create a worktree`——**执行了开工三问中的两问**（查在途 PR、查 worktree），**跳过第一问（认领评论检查）与认领动作**（issue #1899 全程零 otter-claim）
- 《严重问题》对话（11:08 派工 P0 队列）同样读 skill（96 处记录）零认领；晚间接力 #1928 时查任务态（PR/CI）不查归属（对话），完成第二次呈报

**步骤遵从率的系统性分化**（同一 skill 内）：

| 步骤特征 | 遵从结果 |
|---|---|
| 机械闸（commit 模板 → hook 拦截） | 100% |
| 任务内产出依赖（worktree 隔离、PR 流程） | 遵从 |
| 本地查询且信息即时有用（三问之查 PR/worktree） | 遵从（铁证） |
| 对外留痕但收益在系统层（认领评论） | 跳过 |

**原理**：skill 是静态文本注入，无执行引擎——步骤遵从取决于注意力权重，注意力按「与当前任务的相关性」排序是模型固有运作方式。事故响应语境下「搭档指着凶器派工」是最高权重信号，收益在外部的仪式在它面前权重趋零；且跳过无即时代价（从开工到合入 11 小时无任何环节消费认领状态），行为得不到反馈修正。**结论：约束的执行位置必须与约束的收益层级匹配——系统层（跨对话协调）约束住在任务层载体（skill 文本）里，被跳过是概率问题不是会不会。**

## 变更

- `scripts/check-pr-claim.mjs`（新）：CI 前闸——PR 引用 issue 须有有效 otter-claim（release 可撤销）且认领 worktree 的 F-ID 与分支 F-ID 一致；无 issue 引用/非 OPEN/docs-only（与 review-closure 闸同源豁免集）放行。判定核心 `checkClaim` 纯函数导出供测试。
- `scripts/commit-msg-claim-gate.mjs`（新）：commit-msg 侧闸——message 引用 #N 时核验认领（worktree/分支 F-ID 匹配）；每 issue 首次联网检查后写 `$GIT_DIR/otter-claim-ok-<N>` 标记缓存（后续 commit 零开销）；网络/解析失败 fail-open（本地开发不被 GitHub 故障卡死）+ CI 闸兜底。
- `.githooks/commit-msg`：尾部接线侧闸。
- `.github/workflows/ci.yml`：check job 接线前闸（与 review-closure/anchor-discipline 闸同位置）。
- `.pi/skills/worktree-isolation/SKILL.md`：步骤 2 开头标注双闸兜底与「文本不再单独担约束」；回读退场/双 PR 仲裁/接手预检/接管协议保留为仲裁规则。
- `tests/scripts/check-pr-claim.test.ts`：11 用例（谓词正反路径 + #1899 实证形态回归）。

## 设计取舍

- **闸判存在性，仲裁判冲突**：认领评论存在且 F-ID 匹配 = 过闸；「两条线并发认领靠 GitHub 时间戳裁决」「双 PR 仲裁」「接管协议」等冲突场景仍走 skill 文本的仲裁规则（原协议条款 2/3/6 语义不变）
- **fail-open 边界**：commit 侧闸网络失败放行（本地开发连续性优先），CI 侧闸查询失败拒判 exit 2（fail-closed 同态，与 review-closure 闸一致）——两闸互补
- **F-ID 后缀正则**：`F\d{8}[a-z][a-z0-9]{4}`（首位字母+后 4 位字母数字）——实证后缀含数字（qs2ce/claim），原「5 位小写字母」描述与存量不符
- **接力呈报形态的残余**：双闸拦「未认领开工」（9-01 撞车形态与 #1899 开工侧），「接力在途 PR 的重复呈报」不在本闸覆盖（呈报是 speak 动作无机械位）——伤害形态为打扰而非双合入（merge 权唯一在搭档），接受残余；skill 接管协议的「PR 页声明+stand down 回执」继续覆盖协作场景
