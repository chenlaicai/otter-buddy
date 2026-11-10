---
id: F20261110clsig
title: 关单 issue 的遗留 RHI 信号日报提醒
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 日报仅调用新增确定性只读过滤；sqlite 状态不动与 gh CLOSED/OPEN/失败边界由行为测试覆盖，无需生成式能力评估"
intent:
  problem: "RHI 信号先绑定 OPEN issue、issue 后关闭时，open+triaged 信号继续挂在关单上，现有绑定前校验无法发现，日报也没有遗留提醒"
  expected_effect: "每日健康检查通过 list_rhi_signals 的 closedIssueOnly 只读过滤列出明确 CLOSED issue 下的遗留信号数量与 ID，并引导人工转绑或处置；OPEN/查询失败不冒充遗留，任何信号状态均不被自动修改"
  verify_by:
    type: behavior_check
causal_links:
  - F20261105bndst
summary: 复用现有 RHI 清单工具和每日健康检查，不新增长驻任务；按 issue 去重查询 GitHub 状态，仅对已确认关单的 open 绑定信号输出可见提醒。
---

# 关单 issue 的遗留 RHI 信号日报提醒

## 预注册

- 预期根因：#1785 只在 bind 写前检查 OPEN；关单发生后没有读取「open 且仍绑定该 issue」信号的既有日报触发面。
- 预期成立标准：修复前 `list_rhi_signals` 没有关单遗留过滤，测试场景无法只列出 CLOSED 目标下的 open 信号；修复后可列出数量/ID且数据库零写入。
- 放弃原预期的反例：若仓库已有真实关单事件或日报已完成同样对账，则复用该路径，不新增本过滤。

## 现场确认与触发入口

GitHub 关单经外部 `gh issue close` 或网页完成，系统没有同步 close 事件。既有每日健康检查在 RHI 处置段调用 `list_rhi_signals`，是已存在且稳定的消费入口；本修复在该段增加显式只读查询，不新增长驻任务或每小时 gh 轮询。

## 修复契约

- `list_rhi_signals(status=open, triageStatus=triaged, closedIssueOnly=true)` 仅返回绑定目标经 GitHub 明确确认为 CLOSED 的 open 信号，输出总数、信号 ID 与「人工转绑 OPEN issue 或 dismiss」引导。
- 同一 issue 多条信号只查询一次；不同 issue 顺序查询，避免外部调用并发放大。
- OPEN 目标不提醒；gh 失败、畸形输出或状态不可核实不计入 CLOSED，另列查询失败，避免把未知误当遗留。
- 无遗留时只返回一行 0 计数；默认清单不携带该参数时完全不调用 gh，既有输出和过滤行为不变。
- 查询路径只读：不 resolve、不 dismiss、不自动转绑，不修改 triage 字段；处置者另行判断。

## 机制边界

复用既有工具与日报，不新增配置、状态、存储、后台任务或消息类型。新增一条可选的 GitHub 读取路径；代价仅限日报显式查询时按 distinct issue 数产生顺序 gh 调用。修法为既有清单语义内补过滤，`Modification-Class: narrow-fix`。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 先绑 OPEN、后为 CLOSED | 输出关单遗留数量、信号 ID、issue 号与人工处置引导 | ✅ |
| 同 CLOSED issue 多信号 | 全部列出但只读一次外部状态 | ✅ |
| OPEN / 查询失败 | 不混入 CLOSED 清单；失败单独可见 | ✅ |
| 查询前后 sqlite | 查询前后 `findOpen()` 序列化完全一致 | ✅ |
| 无遗留 | 仅 `关单遗留 RHI 信号：0` 一行 | ✅ |
| 默认清单 | 不触发 gh，既有输出不变 | ✅ |

## 验证记录

- 红测先行：修复前两例关单遗留测试失败，旧工具把 CLOSED/OPEN/查询失败混为普通 4 条清单；默认清单控制组通过。
- 修复后目标与真实 fake-gh 边界 **2 文件 13/13**；RHI 工具/API/repository/worker 相关 **11 文件 120/120** 全绿。
- 生产默认装配只读探针：对真实库以 readonly 打开，准确发现 CLOSED #1803 下 3 条 open 信号 **#648/#649/#650**，输出数量、ID 和人工转绑引导；`PROBE_DB_UNCHANGED=true`。
- `npm run build`、`npx tsc --noEmit`、目标 ESLint、docs/intent/tests lint、prompt-size/prompt-anchors 与 diff check 全绿；intent 仅存量 warning。
- 日报 prompt 只作等义压缩以容纳新步骤，未提高字节预算；最终 prompt-size 0 超预算/0 警告。

## 独立审查

待独立检视。
