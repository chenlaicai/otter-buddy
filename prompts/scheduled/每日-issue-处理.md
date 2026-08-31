---
task_name: 每日 issue 处理
---

## Step 0：Intake Triage（每日开工先做，F20260831whfw）

输入域（两部分，缺一不可）：
- 今天新建的 daily-review issue（由每日健康检查生成）
- 昨天新建的**非** daily-review issue（海獭运行中产出：tech-debt / enhancement / 无标签）

对每条输入做分类分流：

| 分类 | 判定标准 | 动作 |
|------|---------|------|
| **actionable** | 明确系统问题/漏洞的 bugfix，或 ≤2 文件独立可修的 tech-debt 小件 | 当天走开发流程（自行处理，**无需请示**——搭档授权：系统问题必修，加强系统的事不抛给搭档） |
| **enhancement** | 可有可无的功能增强 | 跳过，留给周一 backlog digest 呈搭档决策 |
| **rhi-linked** | RHI 总纲/子 issue（特性链，如 #393 下的 phase-3 系列） | 跳过——特性对话自己一步步走，日常任务不抢方向盘（只做下方「链看护」） |
| **unclear** | 拿不准是 bug 还是增强 | issue 评论请求人工判断，不猜 |

红线补充：
- actionable 每天上限 **3 条**（防爆量，剩余顺延次日）
- 分流结论（每条归属哪类）写进当日产出，供搭档抽查

## 处理今日 issue

对 actionable 的 issue，请查询当前列表，判断如何处理：自己干 / 派开发獭并行。参考 otter-summon skill 的判断示例。

红线：
- 遵循 R1 安全红线（worktree 隔离、PR-only 交付）
- 不确定的不改，在 issue 中评论请求人工判断
- 一次一个 PR

## Issue 自动关闭检查（处理完今日 issue 后）

1. **已修复但未关闭的 issue（语义级，F20260831whfw）**：扫描**近 7 天合入的 PR**，对其标题/正文与 open issue 做语义匹配——PR 描述用「issue #N」「修复了 #N」等非关键词行文的也要抓到（#566 案例：PR #586 合入 2 天 issue 未关，关键词检查漏网）。命中即留评论说明后关闭。范围限定近 7 天 PR，不全量扫。
2. **daily-review issue 超期关闭**：超过 3 天的 daily-review issue，如果对应问题已在 main 分支修复，留评论后关闭。
3. **长期无活动的 stale issue**：超过 14 天无任何更新的 issue（非 daily-review、非 tech-debt——tech-debt 阈值放宽到 30 天，它们常等排期），留评论标记为 stale 并关闭。

## RHI 链看护（只提醒不接管，F20260831whfw）

扫描 RHI 特性链 issue（总纲 + 子 issue，如 #393 系列）：无任何更新超过 **7 天**且非终态的，在 issue 评论提醒（@ 该特性对话相关记忆锚点）——「该链已 N 天无进展，若对话已挂请重启或由搭档决定去留」。不代为处理、不关闭。

关闭评论格式：
> 自动关闭：[原因说明]
> 关联 PR/commit：[链接]
