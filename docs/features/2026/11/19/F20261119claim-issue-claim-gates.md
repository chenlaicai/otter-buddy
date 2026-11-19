---
id: F20261119claim
title: "issue 认领协议机械执行点：commit-msg 侧闸 + CI 前闸双保险（协调约束从 skill 文本搬回系统层）"
summary: "2026-11-18 #1899 双呈爆雷实证认领协议（F20260901cimp）失效：前世执行了任务同向的开工两问（查 PR/worktree）、跳过收益外部的认领动作（session 铁证 19203）。第一性原理：约束的执行位置必须与收益层级匹配——跨对话协调是系统层约束，住在 skill 文本里靠注意力自律必然被跳过（注意力按任务相关性排序是模型固有属性）。本特性把认领存在性变成两道机械闸：commit-msg 侧闸（message 引用 #N 时核验 otter-claim，未认领拒 commit，每 issue 首次联网检查+标记缓存，网络失败 fail-open）+ CI 前闸 check-pr-claim.mjs（PR 引用 issue 须有认领且 worktree F-ID 与分支匹配，无认领/他线认领红，docs-only 与非 issue 驱动豁免）。skill 文本改为指向闸的引导。"
change_type: feature
capability_test: "n/a: 闸脚本（纯函数判定+gh 查询），以 tests/scripts/check-pr-claim.test.ts（18 用例覆盖谓词正反路径+#1899 实证形态+closes 优先/URL 形态提取回归）+ tests/scripts/commit-msg-claim-gate.test.ts（11 用例真 git 仓库集成：marker 隔离/分支绑定/R 类过闸/拒 commit 与退出码传播/提取语义）+ CI 实跑本 PR（引用 #1951 已认领，闸应绿）为验证载体"
intent:
  problem: "F20260901cimp 认领协议是纯 prompt 层约定（当时拍板零代码方案），无机械力。2026-11-18 #1899 双呈爆雷实证：前世在事故响应强语境下开工，执行了与任务同向的开工两问（查在途 PR/查 worktree，session 19203 thinking 铁证 'No worktree or PR for #1899 — free'）、唯独跳过收益在外部的认领评论动作；《严重问题》对话接力呈报时同样只查任务态不查归属。同一 skill 内步骤遵从率系统性分化：有机械闸的（commit 模板→hook）100% 遵从、有任务内产出依赖的遵从、本地查询即时有用的遵从、对外留痕但收益在系统层的被跳过——这不是态度问题，是结构性排序。"
  solution: "两道机械闸 + skill 文本降级为引导：①commit-msg 侧闸 scripts/commit-msg-claim-gate.mjs（.githooks/commit-msg F/R 分流前接线，F/R 同拦）——message 引用 #N 时核验 issue N 的 otter-claim（本 worktree F-ID 匹配才放行）；每 issue×每分支首次联网检查后写 worktree 私有 git-dir 内 otter-claim-ok-N-<分支> 标记缓存；网络/解析失败 fail-open 放行并警告，CI 闸兜底；②CI 前闸 scripts/check-pr-claim.mjs（ci.yml check job 接线，与 review-closure 闸同模式）——工作对象 issue（closes 族含 URL 形态优先，无 closes 时裸 #N 兜底）须有有效认领（otter-claim-release 可撤销）且认领 worktree 字段的 F-ID 与 PR 分支 F-ID 一致；无 issue 引用/非 OPEN/docs-only（import check-pr-evidence 豁免单一真相源）豁免。③worktree-isolation skill 步骤 2 开头标注双闸兜底，文本保留回读退场/双 PR 仲裁/接手预检/接管协议等仲裁规则。"
  expected_effect: "跳过认领从「无代价的自觉失效」变成「commit 被拒/CI 红」的物理阻断；协调约束的执行位置回到与收益层级匹配的系统层；F20260901cimp 的回读退场等仲裁规则继续有效（闸判存在性，仲裁判冲突）。"
  verify_by:
    type: behavior_check
    assertions:
      - "tests/scripts/check-pr-claim.test.ts 18/18：谓词正反路径（匹配绿/零认领红/他线认领红/release 撤销红/豁免三态）+ #1899 实证形态回归（引用 issue 零认领必须红）+ closes 优先（历史叙述 #N 不误拦）/closing issue URL 提取/裸 URL 不计/豁免集同源（AGENTS.md 不豁免、SECURITY.md 豁免）回归"
      - "tests/scripts/commit-msg-claim-gate.test.ts 11/11：真 git 仓库 + linked worktree + fake gh 集成——marker 落 worktree 私有 git-dir（他线不继承）、旧形态共享目录 marker 不被消费、切分支后缓存失效、主仓 marker 落 .git/ 不落工作树根、R 类提交过闸（F/R 分流前置）、issue 存在但零认领拒 commit、hook 中间位退出码传播（|| exit 1）、commit 侧提取语义（首行尾注+closes 族，body 裸 #N 叙述不计）"
      - "本 PR 自身吃狗粮：引用 #1951 且已按协议认领（worktree=F20261119claim 匹配分支）→ CI 认领闸应绿（修复前 #1899 历史叙述误拦实红，kimi检视獭-1954 BLOCK-1a 实盘复现）；commit message 含 #1951 → commit-msg 侧闸应放行并写标记"
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

- `scripts/check-pr-claim.mjs`（新）：CI 前闸——工作对象 issue 须有有效 otter-claim（release 可撤销）且认领 worktree 的 F-ID 与分支 F-ID 一致；无 issue 引用/非 OPEN/docs-only（import check-pr-evidence 的 isDocOnlyPath 单一真相源）放行。工作对象提取两级语义：closes 族（close/fix/resolve 变体 + `#N` 或 issue URL）优先——叙述性裸 #N（历史事故复盘）不计；无 closes 族时裸 #N 全部兜底（「修复 #N」惯用形态）。判定核心 `checkClaim` 纯函数导出供测试。
- `scripts/commit-msg-claim-gate.mjs`（新）：commit-msg 侧闸——message 引用 #N 时核验认领（worktree/分支 F-ID 匹配）；每 issue×每分支首次联网检查后写 worktree 私有 git-dir（`git rev-parse --absolute-git-dir`）内 `otter-claim-ok-<N>-<分支>` 标记缓存（后续 commit 零开销；绑分支：切分支后缓存失效重核）；网络/解析失败 fail-open（本地开发不被 GitHub 故障卡死）+ CI 闸兜底。issue 提取与 CI 闸同源（import extractIssueNumbers）。
- `.githooks/commit-msg`：F/R 分流前接线侧闸（认领协议不区分 F/R，R 类引用 #N 同样核验）。
- `.github/workflows/ci.yml`：check job 接线前闸（与 review-closure/anchor-discipline 闸同位置）。
- `.pi/skills/worktree-isolation/SKILL.md`：步骤 2 开头标注双闸兜底与「文本不再单独担约束」；回读退场/双 PR 仲裁/接手预检/接管协议保留为仲裁规则。
- `tests/scripts/check-pr-claim.test.ts`：18 用例（谓词正反路径 + #1899 实证形态回归 + 提取语义回归 + 豁免集同源）。
- `tests/scripts/commit-msg-claim-gate.test.ts`：11 用例真 git 集成 + fake gh（marker 隔离/分支绑定/旧形态不消费/主仓形态/R 类过闸/零认领拒 commit/hook 退出码传播/commit 侧提取语义 3 例）。

## 设计取舍

- **闸判存在性，仲裁判冲突**：认领评论存在且 F-ID 匹配 = 过闸；「两条线并发认领靠 GitHub 时间戳裁决」「双 PR 仲裁」「接管协议」等冲突场景仍走 skill 文本的仲裁规则（原协议条款 2/3/6 语义不变）
- **fail-open 边界**：commit 侧闸网络失败放行（本地开发连续性优先），CI 侧闸查询失败拒判 exit 2（fail-closed 同态，与 review-closure 闸一致）——两闸互补
- **F-ID 后缀正则**：`F\d{8}[a-z][a-z0-9]{4}`（首位字母+后 4 位字母数字）——实证后缀含数字（qs2ce/claim），原「5 位小写字母」描述与存量不符
- **接力呈报形态的已知边界**：双闸拦「未认领开工」（9-01 撞车形态与 #1899 开工侧），「接力在途 PR 的重复呈报」不在本闸覆盖（呈报是 speak 动作无机械位）——伤害上界为打扰而非双合入（风险已被限制：merge 权唯一在搭档，双合入物理不可能）；skill 接管协议的「PR 页声明+stand down 回执」继续覆盖协作场景

## 对抗检视修复轮（kimi检视獭-1954，2026-11-19）

首轮对抗检视 BLOCK（报告：PR-1954-adversarial-review.md），处置：

- **BLOCK-1（提取语义）**：旧实现无条件扫全部裸 #N——本 PR 自身概述段的 #1899 历史事故叙述被误当工作对象（CI 闸实盘 exit 1）；反向 `Closes <issue URL>` 形态提取不到（双闸同盲）。修复：两级提取语义（closes 族含 URL 优先/裸 #N 兜底），双闸同源。修复后本 PR 实跑绿。
- **BLOCK-2（marker 共享）**：`dirname(git rev-parse --git-dir)` 在 linked worktree 落 `.git/worktrees/` 共享父目录——检视獭实盘复现他线 worktree 因共享 marker 零核验静默放行。修复：`--absolute-git-dir` + marker 绑分支；集成测试锁死。
- **MINOR-1（缓存永久有效）**：marker 绑分支后同 worktree 切分支即失效重核；release/他线接管后同分支仍命中——风险已被转移：本地漏拦由 CI 闸每次真查兜底（拦截不缺席，只是位置后移）。
- **MINOR-2（R 类绕闸）**：认领闸从 hook 尾部移至 F/R 分流前，R 类引用 #N 同样核验。
- **MINOR-3（豁免集漂移）**：认领闸不再自维护豁免列表，import check-pr-evidence 的 isDocOnlyPath 单一真相源（AGENTS.md 移出豁免——agent 行为契约非纯叙述文档；SECURITY.md 等变体补齐）。
- **无 closes 裸引用不可区分的已知边界**：无 closes 族时叙述性 #N 与工作对象无法机械区分（如 body 写「复盘 #1899」且未用 closes 声明工作对象）——语义判断超出机械闸结构判定能力（原理上界）；风险已被规避：工作对象用 closes 族显式声明即永不触发。
- **修复轮新坦 ①hook 退出码传播**：MINOR-2 把认领闸移到 hook 中间位后发现 sh 无 set -e，闸 exit 1 会被后续命令覆盖——曾实证拒 commit 失效、commit 照常落地（闸打印 ❌ 但 hook 整体 exit 0）。修复：`|| exit 1` 显式传播；集成测试锁死（fake gh 空评论 → 闸拒 → hook 必 exit 1）。
- **修复轮新坦 ②commit 侧提取语义**：修复 commit 自身 message body 写「叙述 #1899 被误当工作对象」触发兜底全提误拦（CI 侧的两级语义不适用 commit——message 无 body 叙述与工作对象的结构区分，但首行尾注 `(#N)` 是强工作对象信号）。commit 侧独立语义：首行 #N + 全文 closes 族计入，body 裸 #N 不计（extractCommitIssueNumbers 单一真相源）。
