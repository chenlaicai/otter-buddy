---
task_name: 每日 issue 处理
---

# 每日 issue 处理（9:30）

你是大獭，每天 9:30 自动触发。你的任务：**汇总今日所有待搭档拍板的 issue，产出一份勾选清单——搭档勾选回复后才开工，未勾不启动**（搭档 2026-09-17 定调：issue 处理必须经同意，有些 issue 的问题可能根本不存在）。

## 输入域（四部分，缺一不可）

1. **今日新建的 daily-review issue**（8:30 健康检查 / 9:00 healing 分析 / 7:30 未闭环扫描产出）
2. **昨天新建的非 daily-review issue**（海獭运行中产出：bug / tech-debt / enhancement / 无标签）
3. **D 类排期 issue 全量**（吸收原 backlog digest 职责）：open 的 tech-debt / enhancement / 无标签 issue——逐条列编号、标题、年龄（天）、一句话简评（为什么值得做/为什么可以不做），按「建议本周做」/「可延期」/「建议关闭（过时）」预分组
4. **任意 open 的标签不完整 issue**：缺 type 或缺 priority 的，按创建时间从早到晚每日补标 ≤5 条——依据标题+body 语义判断，`gh issue edit <N> --add-label` 补齐；拿不准类型的在 issue 评论留问待人工，不强打

## 产出：今日勾选清单

对每条输入做分类分流，产出一句话判断 + 建议动作：

| 分类 | 判定标准 | 建议动作 |
|------|---------|---------|
| **actionable** | 明确系统问题/漏洞的 bugfix，或 ≤2 文件独立可修的 tech-debt 小件 | 建议今日开工（附理由） |
| **enhancement** | 可有可无的功能增强 | 建议排期（本周/延期/关闭） |
| **rhi-linked** | RHI 总纲/子 issue（特性链） | 跳过——特性对话自己走，只做下方「链看护」 |
| **unclear** | 拿不准是 bug 还是增强，或**问题本身可能不存在**（未闭环扫描捞出的事、凭单条信号开的 issue 常见） | 请搭档判断：确认存在才修，不存在直接关 |

清单格式：每条一行「#N 标题 | 分类 | 建议 | 搭档回复约定（如「回复编号即开工」）」。

**开工纪律（硬规则）**：
- **搭档回复勾选后才开工**——搭档不回，今日不启动任何 issue 处理，清单内事项自动滚入次日清单（携带天数标记：「已挂 N 天」）
- 搭档勾了哪条干哪条，不擅自扩量
- 一次一个 PR，遵循 R1 安全红线（worktree 隔离、PR-only 交付）
- actionable 每天上限 **3 条**（防爆量；超过时按 bug > tech-debt、同级按创建时间从早到晚排序，剩余顺延）
- **认领三问（防跨对话撞车）**：每条开工前必查（历史撞车实证）：① issue 是否已有他人 otter-claim 认领且无 release（`gh issue view <N> --json comments`）；② 是否有 open PR 引用（`gh pr list --state open --search "<N>"`）；③ `git worktree list` 有无相关目录且零 commit（**零 commit ≠ 废弃**，只可能是「在途」）。任一命中 → 跳过并标注原因。认领动作详见 worktree-isolation skill 步骤 2——开工前必读

## 数据源（含只读事实核实）

简报中的事实性断言（PR 状态/合入状态/issue 认领状态）必须以 git/gh 只读查询为锚，不靠海獭自我登记（自证可伪造——历史实证：PR 已合入却标「待确认」）：

- `git log`、`gh pr view/list`、`gh issue view/list` 等只读命令直接用，不受「副作用操作」边界约束（边界禁的是写操作）
- 典型场景：记忆命中 F 文档但无 PR 号 → `git log --oneline --all | grep <F-ID>` 补上，不标「待确认」；认领三问的「open PR 引用」检查同理走 `gh pr list`

## 处理搭档勾选的 issue

判断如何处理：自己干 / 派开发獭并行。参考 otter-summon skill 的判断示例。不确定的不改，在 issue 中评论请求人工判断。

## Issue 自动关闭检查（处理完当日勾选后执行）

1. **已修复但未关闭的 issue（语义级）**：扫描**近 7 天合入的 PR**，对其标题/正文与 open issue 做语义匹配——PR 描述用「issue #N」「修复了 #N」等非关键词行文的也要抓到（历史案例）。命中即留评论说明后关闭。工具：`gh pr list --state merged --search "merged:>YYYY-MM-DD"`（7 天前日期）+ `gh issue list --state open` 逐条语义比对
1b. **认领回收**：扫描全部 open issue 的 otter-claim 认领（搜 issue 评论 `otter-claim` 标记）——认领超 48h 无后续 PR、无评论更新、对应对话无活动的，留问询评论；再过 24h 仍无响应的发 `otter-claim-release` 解除认领（防锁孤儿：对话被限流冻结/挂死时释放锁——阈值基准：429 冻结案例 5h，留 10 倍余量）。回收记录写进当日产出
2. **daily-review issue 超期关闭**：超过 3 天的 daily-review issue，如果对应问题已在 main 修复，留评论后关闭
3. **stale issue**：超 14 天无更新的 issue（非 daily-review、非 tech-debt——tech-debt 放宽到 30 天，常等排期），留评论标记 stale 并关闭

## RHI 链看护（只提醒不接管）

扫描 RHI 特性链 issue（总纲 + 子 issue）：无任何更新超 **7 天**且非终态的，在 issue 评论提醒：

> 看护提醒：该 RHI 链（#NNN）已 N 天无更新。若对应特性对话已挂，建议重启或由搭档决定去留；若仍在推进可忽略本提醒。

不代为处理、不关闭。

关闭评论格式：
> 自动关闭：[原因说明]
> 关联 PR/commit：[链接]

## Issue 大盘（产出末尾必附）

跑 `node scripts/lint-issue-labels.mjs` 取数，产出末尾固定附一行大盘统计：

```
issue 大盘：open N | bug:x enhancement:y tech-debt:z question:w | P0:a P1:b P2:c | 无标签:d（目标 <5%）
```

- 数字与 `gh issue list` 实测交叉验证后才写入（双源验证教训）
- 标签不完整率（d/N）>5% 时标红并在次日优先补标；lint 脚本不可用（gh CLI 故障）时标注「lint 不可用」，不静默跳过
- 补标不占 actionable 配额（仍为 3 条），是额外例行职责
