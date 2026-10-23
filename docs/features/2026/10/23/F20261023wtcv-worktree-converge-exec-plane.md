---
id: F20261023wtcv
title: worktree 收敛执行面加固：独立收敛任务（周一/五 14:00）+ 扫描面全形态覆盖
summary: "F20261014wtlc 四层闭环失效根因治理——收敛执行面单点在 daily-health-check 且该任务 9 天零成功执行（1355/1441 两个干净残留活 9 天实证），叠加分支扫描 glob 白名单漏 pr-*/tmp-* 形态。新增独立时段收敛任务（避开早间掐跑簇）+ 扫描改全形态枚举。机制预算四问已答，修法决策树④，重对抗门与 PR 对抗审视合并轮。"
change_type: prompt
capability_test: "n/a: 纯 prompt/调度配置改动，无代码路径；验收=2026-10-26 14:00 首跑收敛报告行正确（格式/跳过/待裁决桶）+ lint-prompt-size/lint:docs 通过"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-23
causal_links:
  - F20261014wtlc
tags: [worktree, convergence, scheduler, cleanup, mechanism-addition]
modules: [scheduler, prompt]
intent:
  problem: "worktree/分支清理闭环（F20261014wtlc 四层）执行面单点在 daily-health-check，该任务被调度器反复掐跑（inflight skip/重启掐头/once 静默删除），9 天零成功执行导致残留回积（10-23 实测 13 worktree + 24 分支）；且收敛段分支扫描 glob 白名单不覆盖 pr-*/tmp-* 等形态，垃圾主力 9 条 pr-* 探针分支天生不可见。"
  solution: "新增独立时段收敛定时任务（周一/五 14:00，与早间掐跑簇失败域不相交），与 daily 收敛段互为冗余；扫描面 glob 白名单改全形态枚举（两处同步）。"
  expected_effect: "调度面双执行面冗余 + 全形态扫描覆盖，30 天窗口残留稳定 <3；首跑 2026-10-26 14:00 报告行格式正确、OPEN 正确跳过、待裁决桶正确列出"
  verify_by: { type: human_judge }
---

# F20261023wtcv worktree 收敛执行面加固

## 背景：根因（2026-10-23 扫尾排查，搭档点名「到底为什么还有獭干完活不清理的」）

F20261014wtlc（10-14 落地）四层闭环设计正确，但四层全踩在「有人按时跑」前提上：

1. **主因：执行面单点且长期缺勤**——每日收敛段挂 daily-health-check（prompts/scheduled/daily-health-check.md:36），该任务 10-14 来反复被掐：10-21 08:30/09:30 同款 inflight 报错 skip（记忆 8e279d8c）、今晨 08:31 重启掐头。同族调度可靠性缺陷 #1475（once 任务静默删除）为理论边界（issue 原文明示），在案不陪绑，**不计入实证清单**。铁证：PR 1355（10-08 关）/PR 1441（10-13 关）两个「已终结+干净」项活过 9 天——机制验收条款「首跑自动清约 7 个」零兑现，收敛段一次都没成功跑完。
2. **扫描面漏形态**——收敛段分支 glob 白名单（daily-health-check.md:38 原 `feat*/fix*/chore*/refactor*/hotfix*`）不覆盖 pr-*/tmp-*/杂散名；2026-10-23 扫尾的垃圾主力恰是 9 条 pr-* 探针分支（对应 PR 全部 MERGED），天生不在扫描面内。
3. （非本 PR 管辖，记录在案）合入事件无人监听（post-merge-cleanup 人肉触发，F20261014wtlc 已拍板不做 webhook）；待裁决桶报告无消费端（unread-reform 9 文件 WIP 挂 14 天无认领）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 执行面拓扑 | 独立定时任务（cron `0 14 * * 1,5`） | 双挂进其他既有早间任务 | 早间任务共享 8:00-9:30 掐跑簇失败域；14:00 与该失败域不相交；双面互为冗余，需两面同日齐缺才停摆 |
| 矩阵真相源 | 沿用 post-merge-cleanup skill，prompt 只放行动版+引用 | prompt 内复制矩阵细则 | 防双真相源漂移（F20261014wtlc 同款决策） |
| 扫描形态 | 全形态枚举（`git branch --format`，排除 main） | glob 补 `pr-*`/`tmp-*` | 白名单补丁是打地鼠——下一个新形态继续漏；全形态一劳永逸；daily 与新任务同改 |
| 收敛频率 | 周一/五 14:00（一周两跑） | 每日跑 | 残留按周堆积即可管住；预算克制；daily 收敛段保留，冗余不替代 |

## 机制预算四问（修法决策树④必答，作者当场作答）

① **谁需要它**：所有走 worktree-isolation 开工的獭（工作流的收尾出口）+ 搭档（磁盘卫生是搭档直接感知面——2026-10-23 原话「居然残留这么多垃圾」）。daily 缺勤日（实测 9 天量级）仍有兜底执行面。
② **失败后果**：用户可感知，非纯内部指标。worktree/分支堆积直接可见——F20261014wtlc 立项现场 22 个残留、假清理事故（#1389 汇报已清理但目录仍在）都是搭档可见的系统失序。
③ **后续机制**：新增状态=「收敛任务的执行记录与清理动作」。可能出错：a) 调度 skip（#1475 同族——双面互为冗余，需两面同日齐缺才停摆）；b) 矩阵误判（真相源单点在 post-merge-cleanup skill，变更走该 skill 即全局生效）；c) 重复清理（幂等设计：已清项零命中跳过硬验证闸）。修复路径：a→修 #1475 或降频观察；b→改 skill 真相源；c→无需修。
④ **退役条件**（判据可观测，挂既有面不新建机制）：退役评估走 monthly-prune-review 既有月度面，判据=近 4 次周跑报告行（收敛任务自身报告即数据消费端）连续「自动清 0 + 待裁决桶 0 新增」→ 降频至每周一次或退役。反向触发不变：连续两次「自动清 ≥1」→ 禁退役并升格调度问题。调度可靠性以实测 skip 率判定，**不以 #1475 关单为闸**（理论边界不绑架退役节奏）。报告行无聚合点的观测缺口并入「待裁决桶无消费端」既有缺口一并治理（熔断期不新立 issue，挂月度剪枝）。

## 修法决策树判定：④ 新增机制（为何跳过①②③）

机制识别检查点命中「新增定时任务/后台进程」。逐项排除：
- **① 既有语义内修**：实质选项是修 daily 的掐跑根因——那是 #1475 的 scheduler 代码层修复（影响面大、独立排期在案），收敛不应陪绑停摆；「双挂其他既有任务」共享早间失败域且各 prompt 预算已近上限（daily 10500）
- **② 收窄管辖**：不适用——收敛机制管辖面本就只有 worktree/分支
- **③ 删除机制**：不适用——收敛是刚需（不收敛 9 天积 13 worktree/24 分支，2026-10-23 实测）

故走④：净新增一个独立时段轻量执行面。

## 重对抗门留痕

检视獭-wtcv（glm，合并轮，异模型对抗位成立）门控结论：**确认治本**（方案拓扑层面，附实现前提——注册断链修复前第二执行面物理不存在）。理由摘要：执行面单点被真实消除（14:00 时段经 DB scheduled_tasks 全量实测无其他调度，失败域不相交）、glob 打地鼠被全形态根治、#1475 独立排期不陪绑、四问④含反向触发有自省。处置状态：发现 4 严重 3 建议已全部处置（注册证据 d6da12a2 回填、task_name 补齐、intent.expected_effect 补齐、Golden Gate 豁免落 PR、矩阵收敛进 skill 真相源、证据分层订正、退役判据可观测化）。

合并轮依据：requirement-analysis「重对抗审查与步骤 7 对抗审视可合并为同一只检视獭的同一轮审视」条款。

## 变更清单

1. 新增 `prompts/scheduled/worktree-converge.md`（独立收敛任务行动版，含 task_name frontmatter 对账锚点；矩阵只留速记+引用）
2. `prompts/scheduled/daily-health-check.md` 收敛段：扫描 glob 白名单 → 全形态枚举（保护分支除外）；矩阵细则收敛为速记+真相源引用
3. `.pi/skills/post-merge-cleanup/SKILL.md`：判定矩阵唯一真相源落地（含 zero-loss 清盘细则、保护分支口径）；meta 清理 `rm -rf` → `git worktree prune`（守卫兼容等效路径）
4. 运行时注册定时任务「worktree-converge」（cron `0 14 * * 1,5`）——**已执行**，任务 ID `d6da12a2-5259-49a6-8a0e-b8c3aa55a63a`，task_name 与模板 frontmatter 逐字节一致（#784 漂移对账可匹配），首跑 2026-10-26 14:00

## 验证

- 定时任务注册证据：create_scheduled_task 返回 `d6da12a2-5259-49a6-8a0e-b8c3aa55a63a`（worktree-converge，cron `0 14 * * 1,5`，Asia/Shanghai）
- Golden Gate: n/a（verify_by=human_judge，验收=2026-10-26 首跑，见下）
- 模型多样性：实现 mimo-pro / 审查 glm——异模型对抗位成立
- 本地 gate 实跑：lint:docs 890 OK、lint:intent（expected_effect 补齐后）、lint:prompt-size 0 超预算；check 链以 CI run 为最终判据（首轮 CI run 39924569284 红即 lint:intent 缺字段，本轮补齐）
- 首跑验收（2026-10-26 14:00）：报告行格式正确；OPEN-PR worktree 正确跳过；待裁决桶正确列出 detached/无 PR 项；自动清预期 0（存量已由 10-23 手工扫尾清毕）——若自动清 ≥1 说明新残留被正确捕获，亦为通过
- 预期 vs 实际：预期 30 天窗口残留稳定 <3（F20261014wtlc 原验收条款，此前未兑现）；实际待首跑后回填
