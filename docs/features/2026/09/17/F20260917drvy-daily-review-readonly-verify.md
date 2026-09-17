---
id: F20260917drvy
title: daily-review 数据源补只读事实核实白名单：PR 状态以 git/gh 为锚而非海獭自登记
summary: 简报任务把「记忆无 PR 记录」误报为「待确认」——根因是数据源清单漏了只读核实档。补一条白名单条款：git log/gh pr 等只读命令核实 PR 状态直接用；F 文档入库即合入信号；事实性断言以 git/gh 为锚，不靠海獭自我登记（可伪造）。
doc_type: feature
change_type: prompt
capability_test: "n/a: 纯 prompt 文本改动，条款由复盘任务执行时自然生效"
created_in_conversation: 4ef4e922-e6ab-43e6-ab9c-75d082125b1e
tags: [prompt, daily-review, readonly-verify, evidence-anchor, git-truth-source]
modules: [prompts/scheduled/daily-review.md]
created_at: 2026-09-17T00:46:00Z
---

# daily-review 数据源补只读事实核实白名单

## 背景与需求

问题现场（2026-09-17 晨简报，对话 4ef4e922）：

1. 简报检索到 F20260916b1ea（重启自动恢复机制重建）的特性文档 chunk，但记忆库无对应 PR 记录 → 简报写「PR 状态待确认」
2. 搭档质疑「你不知道 PR 是啥？」→ 大獭才去 `git log` 核实：PR #994 当晚已合入 main
3. 大獭第一次归因错了方向：提议「PR 创建后登记 linked_resource 固化进流程」
4. 搭档两次指正点破本质：
   - 「登记」是自证，可伪造——真相源是 git，查 `git log` 即可
   - F 文档随 PR 合入主仓后才被 sync 扫进记忆库——文档入库本身就是合入信号，正确推断是「已合入，PR 号查 git log 补上」

根因：daily-review 数据源清单只有「记忆检索 + 对话浏览」两档，缺「只读事实核实」档。执行獭把「记忆没登记」当成不可知，又把边界条款的「不做副作用操作」扩大解读成「不查 git」。

## 方案

`prompts/scheduled/daily-review.md` 数据源节补第 3 条（只读核实白名单）：

- `git log`、`gh pr view/list` 等只读命令核实 PR 状态直接用，不受「副作用操作」边界约束
- 典型场景写进条款：F 文档入库即合入信号 → `git log --oneline --all | grep <F-ID>` 补 PR 号，不标「待确认」
- 原则落进条款：事实性断言以 git/gh 为锚，不靠海獭自我登记（可伪造）——与 SYSTEM.md A1 证据锚点规则同源

不新增任何机制（无新配置/状态/任务/信号/存储/分支），纯既有任务 prompt 文本补一条数据源说明。

## 机制识别检查点

- [x] 新增配置字段/枚举/开关 —— 无
- [x] 新增状态生命周期 —— 无
- [x] 新增定时任务/后台进程 —— 无
- [x] 新增信号类型/消息格式 —— 无
- [x] 新增持久化存储 —— 无
- [x] 新增决策分支 —— 无（条款是指导文本，不是代码分支）
- [x] 新增跨模块调用 —— 无

修法排序①：既有机制语义内修（数据源清单补档），narrow-fix。

## 验证

- 条款落位：数据源节第 3 条，与「不查 healing/RHI/signals」边界条款语义互补（只读 ≠ 副作用）
- 对照现场：若条款在，今早简报第 2 条未闭环事项会直接写「PR #994 已合入」而非「待确认」
