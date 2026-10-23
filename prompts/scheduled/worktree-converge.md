---
task_name: worktree-converge
---

# worktree/分支收敛（周一/五 14:00 独立执行面）

定位：worktree 生命周期闭环（2026-10-14 落地）四层的第二执行面——daily-health-check 收敛段的冗余面。单点缺勤=清理停摆的根因修复（2026-10-23 排查）。只做收敛，不做体检。时段 14:00 避开早间 8:00-9:30 重启/串行掐跑簇失败域。

## 流程（判定矩阵唯一真相源：post-merge-cleanup skill「判定矩阵」节——本文件只留行动速记，不复制细则）

1. **全量盘点**：`git worktree list --porcelain` + `git branch --format='%(refname:short)'` 全形态（保护分支除外，见 skill；禁 glob 白名单——白名单漏形态实证 2026-10-23）
2. **逐分支查 PR 终态**：`gh pr list --head <b> --state all --json number,state --limit 1`
3. **按 skill 判定矩阵处置**（速记：已终结+干净→自动清理+产物 archived，硬验证闸；dirty 一律不自动删→待裁决；OPEN→跳过；无 PR→两证核验；detached→待裁决注 sha）
4. **产物对账**：active worktree/branch 产物 url 不在盘→archived；盘上有未登记→计 L
5. **报告行（固定）**：`worktree 收敛: 自动清 N ｜ OPEN M ｜ 待裁决 K ｜ 登记缺失 L`，K 桶逐项列（名｜形态｜PR 态｜建议处置）

约束：只清理「已终结+干净」，其余只报告；清理动作之外零副作用。
