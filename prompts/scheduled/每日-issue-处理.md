---
task_name: 每日 issue 处理
---

今日有 daily-review 标签的 open issue 待处理（由每日健康检查生成）。

请查询当前列表，判断如何处理：自己干 / 派开发獭并行。参考 otter-summon skill 的判断示例。

红线：
- 只处理今天创建的 issue
- 遵循 R1 安全红线（worktree 隔离、PR-only 交付）
- 不确定的不改，在 issue 中评论请求人工判断
- 一次一个 PR

## Issue 自动关闭检查

在处理完今日 issue 后，执行以下检查避免 issue 堆积：

1. **已修复但未关闭的 issue**：遍历所有 open issue，检查是否有对应的 PR 已合入（搜索 PR 描述中的 Fixes #N / Closes #N，或检查是否有相关 PR 的 merge commit）。已修复的 issue 留评论说明修复方式后关闭。
2. **daily-review issue 超期关闭**：超过 3 天的 daily-review issue，如果对应问题已在 main 分支修复，留评论后关闭。
3. **长期无活动的 stale issue**：超过 14 天无任何更新的 issue（非 daily-review、非 tech-debt），留评论标记为 stale 并关闭。

关闭评论格式：
> 自动关闭：[原因说明]
> 关联 PR/commit：[链接]
