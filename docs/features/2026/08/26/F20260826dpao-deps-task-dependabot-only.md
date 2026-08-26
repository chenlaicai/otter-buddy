---
id: F20260826dpao
title: 依赖升级自动化模板对齐「仅 Dependabot 驱动」决策
summary: |
  搭档 2026-08-25 在 PR #419 的决策（定时任务只处理 Dependabot PR、不再主动 npm update）未被写入 PR #428 迁移的 git 模板——#428 迁移的是旧 DB body 逐字节副本（#419 关闭 01:08 早于 #428 创建 01:14，决策与迁移擦肩而过）。本 PR 修正 prompts/scheduled/依赖升级自动化.md：无 Dependabot PR 直接收工、升级范围 = 关闭的 Dependabot PR 覆盖的包、明令禁止主动 npm update，并同步 DB 运行时副本。
change_type: feature
status: active
capability_test: "n/a: 定时任务模板文案变更，无代码改动"
created_in_conversation: a3758263-dfac-4396-93ee-37d89efb5b0e
---

# 依赖升级自动化模板对齐「仅 Dependabot 驱动」决策

## 背景与需求

### 问题描述

2026-08-26 定时任务「依赖升级自动化」触发，大獭例行检查发现无 Dependabot PR，按搭档在 PR #419 的关闭决策（01:08）收工。随后搭档指出 PR #428（定时任务 prompt git 化，#416）应该已把任务文本迁入仓库——核查确认迁移确实存在，但内容是**旧流程**。

时间线还原：

| 时间（8/25） | 事件 |
|---|---|
| 01:08 | 搭档关闭 PR #419，评论：「依搭档决策关闭：本 PR 升级无 Dependabot 信号支撑，定时任务改为只处理 Dependabot PR。依赖升级后续由 Dependabot 触发再统一处理。」 |
| 01:14 | PR #428 创建，模板内容 = 原 DB body 逐字节（旧 npm update 流程） |
| 01:29 | PR #428 合入 |

决策与迁移间隔 6 分钟擦肩而过：git 模板与 DB 运行时副本至今仍是旧流程，下次任务触发会再次诱导主动 `npm update`（8/26 已实际发生一次，幸被记忆拦截）。

### 需求

模板内容对齐搭档决策，消除「定时任务文本」与「决策」的双源不一致。

## 方案设计

### 改动内容

`prompts/scheduled/依赖升级自动化.md` 全文重写：

1. **目标收窄**：任务名标注「仅 Dependabot 驱动」，开头引用决策来源（PR #419 关闭评论）可追溯
2. **新增步骤 2「无 Dependabot PR → 直接收工」**：明令禁止主动 `npm update` 或基于 `npm outdated` 创建升级 PR
3. **升级范围收窄**：统一 PR 只覆盖关闭的 Dependabot PR 中给出的包（`npm install <pkg>@<version>`），不是全量 `npm update`
4. 其余步骤（关闭 Dependabot PR、删分支、worktree、提交格式、主版本单独 PR、不自动合并）保持不变

### 明确不做

- 不改 `scripts/update-scheduled-task-body.mjs`（同步机制本身无问题）
- 不动其他两个模板（daily-health-check、每日-issue-处理、self-healing-analysis）

## 验证

- [x] 模板 frontmatter（task_name）保持同步脚本识别格式
- [x] `node scripts/update-scheduled-task-body.mjs --name "依赖升级自动化" --dry-run` diff 符合预期
- [x] 实写同步 DB 后，任务触发时拿到的 body 即新文案
