---
id: F20261105btbrx
title: 批量处置工具误撞循环熔断收口（#1761）
doc_type: feature
change_type: fix
status: implemented
created: 2026-11-05
created_at: 2026-11-05
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent
  - src/usecases/health
  - src/interface-adapters/agent-runtime/tools
  - prompts/scheduled
summary: "#1761：update_artifact_status 签名补产物与目标状态，triage_signal 增加有范围约束的 batch_dismiss；不同实体与同族同一判断不再被迫逐条撞守卫，真实重复调用保护不变。"
tags: [guard, health, batch, circuit-breaker, triage]
intent:
  problem: "不同产物归档被工具名级签名误判重复；同 issue 族同一忽略判断只能逐条 triage_signal，触发连续/滑窗熔断"
  expected_effect: "不同产物或目标状态分别计数；同族忽略一次批量留痕，同产物同状态重试仍被拦截"
  verify_by:
    type: behavior_check
capability_test: "n/a: A 类工具签名与真 sqlite 状态机逻辑，由 buildToolSignature/ToolCallCircuitBreaker、SignalRepository 与 AgentTool 集成用例覆盖；日报仅一行路由指引，无新增独立 LLM 场景"
---

# 批量处置工具误撞循环熔断收口（#1761）

## 问题

11-04 日报现场：`update_artifact_status` 对不同 artifactId 连续归档仍被当成相同调用；同族信号 dismiss 逐条留痕又被连续/滑窗守卫截断。根因分别是管理工具签名漏接和批量处置只有归口、没有同族忽略通道。

## 方案

1. `update_artifact_status` 签名使用 artifactId + status；关键参数缺失仍退化工具名，不放松异常调用保护。
2. `SignalRepository.batchDismiss` 与 `triage_signal(action=batch_dismiss)`：note 必填；filterIssueNumber 或 filterSignalType 至少一个，filterSeverity 仅叠加细化。只处理 open，沿用单条 dismiss 的终态字段，不清空 triaged_at，note 覆盖为本次判断并承载 issue 历史。单事务、dryRun、单批 100、truncated/totalMatched 续批。
3. 日报指引：同 issue 族同一忽略结论走批量，异质判断才逐条。

## 设计取舍（mechanism-addition 四问）

- **机制识别**：新增工具 action 与仓库批量决策分支，但复用既有 signals 状态机、triage 工具和循环守卫，无新表/配置/任务/信号类型。仍按新增批量机制声明。
- **谁需要**：日报/健康检查处置者；同族同一判断不再拆成会被熔断的 N 次调用。
- **失败后果**：误批量终态最多 100 条 open 信号。以范围必选、severity 不可单独使用、note 必填、dryRun、100 上限、事务控制爆炸半径；已终态不覆盖。
- **后续机制**：异质逐条 triage_signal 的 signalId+action 签名暂不扩，待新实证再议；#1760 的 issue 终态校验不在本条范围。
- **退役条件**：若同族处置由可靠自动生命周期完全接管，且日报不再需要判断性 dismiss，可随 triage 工具一起退役。

## 被否决路径与翻案依据

- 不改守卫阈值、不按 callId 放行：真实循环仍需被抓；问题在工具签名和批量能力错配。
- 不做全量 dismiss：没有范围与判断说明的批量终态不可接受。
- F20260929tbbd 曾不做 batch_dismiss，理由是逐条 note 可能不同；#1761 新实证证明同 issue 族存在一条判断适用全族的场景。动手前异体方案门（工作区 review-1761-pre-design.md）确认治本，并补充 filterIssueNumber 族边界。

## 验证

- [x] 修复前红测：7 个不同产物在第 6 次被 steer；batchDismiss 缺失；batch_dismiss 工具返回未知 action。命令与输出保存于 `/tmp/1761-red-tests.log`（临时证据）。
- [x] 修复后相关 6 文件 107 用例通过：不同产物归档放行，同产物同状态重试第 6 次仍 steer；单条 dismiss/batch_bind 回归通过。
- [x] 真 sqlite 覆盖：issue 族精确边界、dryRun 零写入、note/范围校验、100 上限与续批、不同 note 分批、终态字段、他族/已终态不受影响。
- [x] `npx tsc --noEmit`、`npm run lint:prompt-size`、`git diff --check` 通过。
- [x] `npm run lint`、431 文件 5677 用例全量测试、`npm run build`、docs/capability/tests/intent/tool-manifest/prompt-size 专项闸通过；新增 1 边界用例后最终全量与 CI 见 PR。
- [ ] 异体 PR 对抗审视：待 PR 后执行。

## 影响与回滚

产物归档签名变化只影响循环判重粒度；信号批量忽略会真实写终态，调用方应先 dryRun 并核对 totalMatched。同键信号再次触发仍按既有逻辑 re-open。回滚用 `git revert <merge-commit>`，无 schema/数据迁移；已写入的 dismissed 状态不会被自动反向恢复。
