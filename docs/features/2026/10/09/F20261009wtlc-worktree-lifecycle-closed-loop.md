---
id: F20261009wtlc
title: worktree 生命周期闭环：出生登记 + 每日收敛 + 清理硬验证 + 检视只读纪律
summary: 22 个 worktree 残留（9 个对应已终结 PR）的根因治理——worktree 在系统里非一等公民（无登记、无收敛、无验证、无防护），四层闭环一次落地
change_type: prompt
capability_test: "n/a: 纯 skill/prompt 文本改动，无代码路径；验收靠 lint-prompt-size（体积闸）+ 后续 daily 执行面观察"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
causal_links:
  - F20261009arlz（产物生命周期对账，同为「资源一等公民化」脉络）
  - F20261005clup（孤儿实例生命周期——实例维度先行的同型治理）
  - F20260917cltc（清理触发观察——被动触发的边界实测）
  - F20260917pbgg（prompt 体积预算闸——本 PR 的 daily 模板增量受其约束）
tags: [worktree, lifecycle, skill, cleanup]
modules: [.pi/skills, prompts/scheduled]
---

# worktree 生命周期闭环

## 1. 问题

2026-10-09 现场盘点：`git worktree list` 22 个非主目录 worktree，其中 **9 个对应已终结 PR**（MERGED 7 + CLOSED 1 + rebase 临时件 1），跨越 09-25 ~ 10-09 半个月无人清理。搭档质问「每次合入收尾都应该清理掉呀」——事实上 8/24 已建 post-merge-cleanup skill 专门治这个病（当时 42 个堆积），46 天后又积出 9 个。

更硬的实锤：当天早上 06:23 前世汇报「#1389 worktree + 本地分支已清理」，但 `guard-ledger-adjudicate` worktree（#1389 的）在 19:42 仍在磁盘上，且处于 dirty 状态（`tests/fixtures/guard-write-eval-corpus.json` 被改 + detached HEAD）。**汇报 ✅ 与磁盘真实状态脱钩 = 虚报。**

### 根因（四个执行层缺口的分型，非四个独立问题）

统一根因：**worktree 在本系统里不是一等公民**——PR 状态在 GitHub、待办在 matters 表、问题在 healing 台账、产物在 linked_resources，唯独 worktree 只是磁盘目录，其唯一状态源 `git worktree list` 没有生命周期语义。四个缺口是同一缺失的四个投影：

| # | 缺口 | 实证锚点 |
|---|---|---|
| ① 合入事件无人监听，收尾靠搭档人肉广播 | 9 个残留跨 15 天；8/24 特性文档 mimo 建议「定期自动扫描」躺 46 天无人接 |
| ② 清理动作无强制验证，失败可静默通过 | #1389 dirty 使 remove 拒绝，未查退出码照样汇报 ✅ |
| ③ 检视獭在共享 worktree 留副作用 | #1389 detached HEAD + 语料文件被改；10/05 #1210 同型（检视獭切 detached HEAD 未归位） |
| ④ worktree 零台账，跨对话即孤儿 | worktree 类型产物登记 0 条 vs 磁盘 22 个；unread-reform 真 WIP（9 文件改动）无任何 issue/matter 挂靠 |

## 2. 方案（四层闭环，一次落地）

```
出生登记 ──→ 使用（检视只读） ──→ 终结（每日收敛） ──→ 验证（硬验证闸）
 worktree-     review-protocol      daily-health-check    post-merge-cleanup
 isolation     检视獭禁 checkout/    自动清「已终结+干净」   每动作回查存在性
 创建即登记     禁改文件/自检归位    dirty 只报告不删       失败必进 ERROR
```

### 2.1 出生登记（worktree-isolation）

创建成功后**当场** `create_linked_resource(type: "worktree", groupId: "<特性ID>")`——登记是创建的第 4 个动作（fetch → add → 登记），不是可选步骤。零登记的 worktree 跨对话即孤儿。清理侧以 `git worktree list` 为准核对登记，登记缺失不阻塞清理但记入日报（渐进收敛存量）。

### 2.2 每日收敛（daily-health-check）

新增「worktree/分支收敛段」：全量扫描 + 按判定矩阵处置。判定矩阵真相源在 post-merge-cleanup skill，daily prompt 只放精简行动版（体积闸约束，见 2.5）。

| PR 终态 | worktree | 处置 |
|---|---|---|
| MERGED/CLOSED | 干净 | 自动清理 + 产物 archived |
| MERGED/CLOSED | dirty | 日报列待搭档裁决 |
| OPEN | 任意 | 跳过（活跃工作） |
| 无 PR | 干净 | mtime >7 天 + 无 otter-claim 认领 → 废弃候选（两证缺一即保留标「疑似在途」） |
| 无 PR | dirty | WIP 待认领/裁决 |

安全边界：dirty 一律不自动删；自动清理仅限「PR 已终结 + 干净」——误删风险为零。无 PR 判定沿用批量扫尾的「零 commit ≠ 废弃」防撞车纪律（两证核验），镜像于认领协议的开工三问。

### 2.3 清理硬验证闸（post-merge-cleanup）

每步清理动作后强制回查存在性，退出码 + 磁盘状态双重确认：

| 项 | ✅ 判据 |
|---|---|
| worktree | `git worktree list` 零命中 + `<path>/.git` 不存在 + 元数据目录不存在 |
| 本地分支 | `git branch --list` 零命中 |
| 远程分支 | `git ls-remote --heads origin` 零命中 |
| 源头 issue | state 为 CLOSED |

「命令执行了」≠「清理成功」；零命中检查本身失败同样 ❌。新增「清理状态对账」产出节固定口径。

### 2.4 检视只读纪律（review-protocol）

A/B 两协议的召唤要求均加：检视獭在 worktree 内禁 checkout/switch（含 detached HEAD）、禁改文件、禁副作用命令；临时材料落盘 /tmp；结束前 `git status --porcelain` 自检零输出，非零当场归位并声明。写进大獭派工模板 = 每次召唤自动注入，不依赖检视獭自觉。

### 2.5 约束与取舍

- **budget override 9600 → 10500**：daily-health-check 加收敛段的必要代价（增量 ~900B；lint-prompt-size CI 硬闸，override 须特性文档记理由——即本节）。取舍：判定矩阵全文放 skill（真相源），daily prompt 只放压缩行动版——prompt 是给每天执行的 LLM 看的操作指令，不是文档。
- **纯文本改动，零新代码**：daily-health-check 本是 LLM 执行的体检 prompt，扫描命令序列写进去即生效，无新依赖、无 schema 变更。
- **不做自动 webhook/事件监听**：远程侧 GitHub 事件驱动（delete_branch_on_merge）已存在；本地侧每日收敛 + 机会性触发双通道已覆盖，webhook 引入的架构复杂度与收益不成比例（L1 拍板）。

## 3. 影响范围

| 文件 | 变更 |
|---|---|
| .pi/skills/worktree-isolation/SKILL.md | +出生登记段（+1 行锚点） |
| .pi/skills/post-merge-cleanup/SKILL.md | +硬验证闸（+10）+ 清理状态对账产出节（+11） |
| prompts/scheduled/daily-health-check.md | +收敛段（+16 压缩后）+ 检查清单第 12 项 + budget 9600→10500 |
| .pi/skills/review-protocol/SKILL.md | A 协议 +只读纪律、B 协议 +引用（+4） |

存量 22 个 worktree 不由本 PR 处置（治本 PR 不夹带治标动作）——9 个残留的清理交由落地后第一次每日收敛自动完成（全部符合「已终结 + 干净」或「dirty 待裁决」路径，unread-reform 等 WIP 走裁决线）。

## 4. 验证

- `node scripts/lint-prompt-size.mjs`：0 超预算 / 0 警告（daily-health-check.md 10499B ≤ 10500 override）
- 四文件 diff 纯插入（36 insertions / 1 行 budget 值修改），无既有内容删改——三次编辑误删（#1210 实证段、PR diff 附送行）均在当轮发现并恢复，git diff 逐行复核确认
- 判定矩阵与批量扫尾既有「零 commit ≠ 废弃」纪律对齐，无语义冲突

### 后续观察面（非本 PR 验收项）

- 落地后第一次 daily-health-check 执行：应自动清掉 9 个残留中的干净项（~7 个），dirty 项进日报
- 30 天窗口：worktree 残留数应稳定 <3（活跃 PR 数水平波动）

## 5. 决策记录

- **L1 拍板**：纯 skill/prompt 落地，不建自动 webhook——理由见 2.5。搭档已确认方向（「你要有全局眼光来看待」——方案一体化，不再拆分呈选）。
- **治标/治本分离**：本 PR 只治本；9 个存量残留由新机制首跑自动消化（它们恰好是矩阵各路径的活样本）。
- budget override 理由：见 2.5 第一条。
