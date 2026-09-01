---
id: F20260901cimp
title: 跨对话 Issue 认领协议：签名认领评论防撞车六件套
summary: 跨对话 issue 认领协议：签名认领评论 + 开工三问 + 零commit≠废弃 + 审视撞车检查 + 48h 认领回收，零代码防撞车六件套
change_type: prompt
created_in_conversation: 97bd5216-d64a-48f3-9bd8-17699bff9f9f
capability_test: "n/a: prompt 层协议变更无运行时行为；合入后观察期~1周用下一个真实开发流程 issue 验证认领+回读步骤执行率，每日任务跑认领回收扫描"
---

# 跨对话 Issue 认领协议（防撞车六件套）

## 背景与需求

2026-09-01 发生跨对话 issue 撞车：PR #665（10:30 任务线，F20260901rhpu）与 PR #679（手动五期线，F20260901hpui）同 Closes #647+#652。手动线 15:00 检查对方 worktree 见零 commit 误判废弃，2 分钟后对方 commit 落地（TOCTOU）。双 PR 各自独立通过对抗审视（互不知情），#679 先合入，#665 由 chen 人工逐 diff 对比后关闭。

根因（双分析獭 + 大獭交叉验证，详见工作区报告 `issue-collision-analysis-20260901.md`）：issue 入口有 12 条路径（早报线/定时任务线/手动对话/wave 派工/重启恢复/清理线等），6 种协调信号（assignee/label/流转评论/worktree/open PR/评论），但**每条路径读写的信号子集互不相同——不是缺信号，是信号没有公共协议**。全场 issue assignee 全空；零 commit worktree 三义（废弃/在途/被限流卡住）不可区分。

## 方案设计

### 方案选型（搭档决策 2026-09-01 20:17）

三候选：①GitHub assignee 认领（否：共享 token 无法区分认领身份）②DB 共享 claim 表 + 心跳租约（否：搭档判断「加表有点重」，且只治 issue 一种资源）③**签名认领评论协议（采纳）**——搭档提出：认领走 issue 评论、带对话 ID + 海獭名签名（与 PR/检视评论同模式），可泛化到 GitHub issue 之外的资源。

### 认领评论格式（双层结构：人可读 + 机器可 grep）

```
🦦 认领 #<N>
<!-- otter-claim: conversation=<对话短ID>; otter=<名号>; worktree=<worktree名>; at=<ISO时间> -->
开工：<一句话任务>
```

放弃认领：`<!-- otter-claim-release: conversation=<对话短ID> -->` + 原因。评论永不删除（审计轨迹）。

### 核心协议条款

1. **开工三问**（认领前按序检查）：① issue 是否已有他人 otter-claim 认领且无 release；② 是否有 open PR 引用该 issue；③ worktree 现场是否相关目录且零 commit（零 commit ≠ 废弃，唯一合法结论是「可能正在开工」）
2. **回读退场**（原子性替身）：发认领评论后立即回读全部评论——存在更早的他人 otter-claim 且无 release → 自己输，退场换目标。并发认领靠 GitHub 服务端时间戳（不可伪造）确定性裁决
3. **双 PR 仲裁**（最坏情况）：时间序优先（PR createdAt）；质量明显更优可升级搭档裁决；被弃方 close 并留判定依据（#665 先例）
4. **48h 认领回收**（防锁孤儿）：10:30 任务每日扫认领超 48h 无 PR/无评论/对话无活动的 issue → 问询；再 24h 无响应 → release。阈值基准：429 限流冻结案例 5h × 10 倍余量
5. **审视撞车检查（B5）**：对抗审视基础维度新增——`gh pr list --state open` 比对同 issue 引用/重叠文件域，命中 = 严重发现 + 通知大獭仲裁
6. **清理防线**：批量扫尾删 worktree 前必核两证（mtime >48h + 无活跃 otter-claim），任一不成立保留并标注「疑似在途」

### 明确不做

- 不收口单入口（官僚化搭档「随时开手动对话」的使用方式；429 限流 5h 证明多入口是韧性来源）
- 不建 DB claim 表（Phase 1 备选，观察期后再评估——搭档判断加表过重）
- 不用 GitHub assignee（共享 token 无法区分身份）

## 变更文件

| 文件 | 变更 |
|---|---|
| `.pi/skills/worktree-isolation/SKILL.md` | 新增步骤 2「认领协议」（三问+认领+回读退场+仲裁），原步骤 2-4 顺延为 3-5 |
| `.pi/skills/post-merge-cleanup/SKILL.md` | 批量扫尾分类新增「零 commit ≠ 废弃」两证规则 |
| `.pi/skills/adversarial-review/SKILL.md` | 基础维度表新增 B5 撞车检查；三处产出模板表同步加 B5 行；B1/B4 标号升级为 B1-B5 |
| `prompts/scheduled/每日-issue-处理.md` | Step 0 红线补认领三问；自动关闭检查新增 1b「认领回收」 |

## 验证

- ID 查重（#524）：`grep -rl "F20260901cimp" docs/` 无占用；认领/撞车/claim 主题命中均为其他主题文档，无同语义文档，自编 ID 合规
- **开工三问自查**（协议首次实践）：13 个 open PR 逐一 `gh pr view --json files` 比对 `.pi/skills` 与 `prompts/scheduled` 路径——零重叠，无在途冲突
- **最简实现检查**：本方案纯 prompt/skill 文本变更（零代码、零新表、零新依赖），已过阶梯——协议核心只引入 1 个机器标记（`otter-claim`/`otter-claim-release` 注释）复用 GitHub 现有能力（评论、时间戳、grep），无更简实现空间
- lint:skills：`npm run lint:skills` 通过（见 PR CI）

## 能力测试建议

合入后按本协议真实跑一轮：下一个走开发流程的 issue 观察认领评论格式是否被正确执行、回读步骤是否被跳过（跳过 = 协议失效信号，需回修）。观察期 ~1 周，若出现残余竞态（回读窗口内仍撞车）再评估 Phase 1（DB claim 表）。
