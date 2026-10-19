---
id: F20261019haof
title: healing age-out 三缺陷修复：bound 不误伤、unbound 不静默、dismiss 落 resolution（#1545）
summary: 修复 ageOutHighAndNotify 三缺陷——已 bind 的超龄 high 被 age-out 误 dismiss（打断 bind≠resolve 生命周期）、unbound high 被 dismiss 后永失 batch_bind 归口通道、dismiss 不写 resolution（审计断链）。age-out 从「处置者」收窄为「识别+提醒者」：findAgedUnboundHigh 只读识别超龄 unbound high，事件保持 open，alert-registry 提醒引导 bind_issue 归口；新增 dismiss(id, resolution) 落全终态记录；单条 dismiss 工具路径改走新方法不再丢 resolutionNotes。
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
from:
  - F20261008hcpa（healing 治本三层改造，ageOutHighAndNotify 出生文档——本次收窄其层3语义）
  - F20261008hbbd（batch_bind 机制——「只作用未归口 open」语义是缺陷②的直接成因）
tags: [healing, age-out, bind-issue, audit, bugfix]
modules:
  - src/frameworks/db/healing/sqlite-healing-event-repository.ts
  - src/usecases/healing/healing-event-repository.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/usecases/healing/healing-alert-registry.ts
  - src/interface-adapters/agent-runtime/tools/healing-tools.ts
---

# healing age-out 三缺陷修复（#1545）

## 案发现场（2026-10-19 排查，高危分析獭，issue #1545）

- **批次 1（2026-10-19T01:00）**：298 条超龄 open high 被 `ageOutHighAndNotify(2)` 单事务 `UPDATE ... RETURNING` 批量置 dismissed
  - 236/298 已 bind_issue（#1468×203 等）——bind≠resolve 的生命周期被打断，终态落 dismissed 而非随 issue 修复后 resolve
  - 62 条 unbound 被一并 dismiss——batch_bind 只作用 open 事件，dismissed 后永失归口通道
  - 298 条 resolution 字段全空——UPDATE 只写 status+resolved_at 两列
- **批次 2（2026-10-15T01:00）**：26 条 bound #1434 的 high 同样被误伤（缺陷非首现）
- **直接诱因**：消费任务（self-healing-analysis）10/16–10/18 停摆（#1546），10/19T01:00 恢复首轮 age-out 抢在消费之前一次清空

## 机制判定（动手前，修法决策树前置）

机制识别检查点七项逐项核对：新增配置字段/开关 ✗、新增状态生命周期 ✗（dismissed/resolved/open 均既有）、新增定时任务 ✗（仍是每日 9:00 同一任务）、新增信号类型/消息格式 ✗、新增持久化存储 ✗（零 schema 变更）、新增决策分支 ✗（无被记住影响后续行为的分支——提醒描述文案变化是运行时临时值）、新增跨模块调用路径 ✗（调用链不变：scheduler → healingRepo/alertRegistry）。

**命中一项（处置轮后）**：检查点①「枚举」——S2 修复为让 `autoStaleDismiss` 落 resolution，给 `HealingResolution.decidedBy` 扩了 `'system'` 字面量（`src/entities/healing/healing-event.ts`）。命中但不涉净新增机制的论证：这是数据词表扩展而非机制——'system' 仅在 autoStaleDismiss 一处写入路径出现，读取侧零分支（grep 7 处 decidedBy 使用全是写入），无配置面、无状态流转、无行为分叉；不扩该字面量则调度器自动行为只能冒用 'agent' 归属，审计语义失真。scope-reduction 分类不变。

**其余六项未命中 → 走修法决策树**：
- 主体：**②收窄管辖**（age-out 从「时间处置者」收窄为「识别+提醒者」——移除其写路径，非新增机制）→ `Modification-Class: scope-reduction`
- 附带：**①既有语义内修**（单条 dismiss 补 resolution 落库——resolve() 已有的语义补齐到 dismiss()）

## 修复设计

### 三缺陷 → 三修法

| # | 缺陷 | 修法 | 代码 |
|---|---|---|---|
| ① | bound high 被 age-out 误伤（bind≠resolve 生命周期被打断） | age-out 不再触碰任何事件状态——bound high 完全不在识别面（WHERE bound_issue IS NULL） | `findAgedUnboundHigh` |
| ② | unbound high 被 dismiss 后永失归口通道 | 超龄 unbound high **保持 open**，每日提醒引导 bind_issue 归口（与 #1361 层3「high 必须 bind_issue」硬规则、self-healing-analysis.md:12 对齐） | 同上 + 提醒文案改为「未归口，待 bind_issue」 |
| ③ | dismiss 不落 resolution（298 条全空，审计断链） | 新增 `dismiss(id, resolution)` 落 status+resolution+resolved_at 三列；工具层单条 dismiss 改走新方法（此前 `updateStatus` 丢弃 resolutionNotes——缺陷③的孪生实例，同模块顺手修复） | `dismiss()` + healing-tools.ts |

### 方法替换：ageOutHighAndNotify → findAgedUnboundHigh

- 旧实现：事务内 `UPDATE ... SET status='dismissed', resolved_at=? WHERE status='open' AND severity='high' AND created_at<? RETURNING *`（审视 D 修复的「先到者独占推送权」语义随处置语义一并移除）
- 新实现：只读 `SELECT * WHERE status='open' AND severity='high' AND created_at<? AND bound_issue IS NULL ORDER BY created_at ASC`——不改任何状态，无并发窗口
- 防重推：跨进程同任务并发由 scheduler `claimAndValidateTask`（running execution 检查）承担；每日重复提醒同一批未归口事件属预期（提醒引导归口，非重复处置）

### 设计意图对齐（为什么「保持 open」是唯一自洽语义）

F20261008hcpa 层3 的设计意图是「high 不被时间静默」——但旧实现「推提醒 + dismiss」本身仍是时间处置，与其自身的设计意图相悖。#1361 层3 硬规则（self-healing-analysis.md:12）：severity 为 high 的 open 事件**必须** bind_issue 归口，**不得直接 dismiss/resolve**——age-out 自动 dismiss unbound high 正是违反了这条。修后语义链：超龄识别 → alert-registry 提醒 → 獭 bind_issue 归口（batch_bind 只作用 open，事件保持 open 才有归口通道）→ issue 修复 → batch_resolve + filterBoundIssue 收尾。

### 次要发现顺手修复：聚合提醒 ids 段可见性

`renderHealingAlerts` 对 description 整体截断 120 字符——超限聚合条目（298 条 ids 全量）仅首条可见。改为「摘要段截断 + ids 段完整」两段拼接（regex 提取 `ids：...。` 段不参与截断）。

## 设计取舍

- **保持 open 的积压风险**：若消费任务长期停摆（如 #1546 场景重演），超龄 unbound high 会持续累积 open——但每日 alert-registry 聚合提醒（enqueueBatchAggregated 超限聚合为单条摘要）会把积压推给大獭，这正是「升级信号必须有出路」的设计意图；停摆治理是 #1546 的职责，不在本 PR 范围
- **resolved_at 语义**：`dismiss(id, resolution)` 只作用 open 状态（WHERE 带 status='open'），dismiss 已终态事件 fail-closed 抛错（对齐 assertUpdated 口径）——防重复处置静默吞
- **旧方法不保留别名**：ageOutHighAndNotify 直接删除而非 deprecated 保留——项目内部接口无外部消费者，留别名只会延长混淆期（全仓 6 处引用一次性迁移，含测试 mock）
- **失败用例先固化后修复**：新增 5 个失败用例（方法不存在 TypeError）→ 实现后全绿——bugfix Verification 证据链

## 验证

### 失败证据（修复前）

```
npx vitest run tests/frameworks/db/healing/sqlite-healing-event-repository-stale-severity.test.ts
→ 5 failed | 6 passed：repo.findAgedUnboundHigh is not a function / repo.dismiss is not a function
```

### 修复后

```
本文件 10 passed（含三缺陷核心用例：bound 不动 / unbound 保持 open 且可再 bind / dismiss 落 resolution 三列 / 非法状态 dismiss 抛错 / 只读跨实例重复取回）
受影响面全绿：scheduler-service 126 passed、healing 全族 112 passed、tsc --noEmit 0 error
全量：6180 passed | 2 failed（guard-intercept-classify / cursor-zero-guard timeout）——基线对照：git stash -u 后单跑 38 passed、含改动单跑 38 passed，全量跑失败系并发负载 flaky，与本改动无关
```

### #1545「验证断言」对照（issue 规格）

- 断言「构造 bound+open 超 48h 的 high，跑 age-out，状态应保持 open（或按新语义流转）且 resolution 非空」→ 用例「超龄 bound high：状态与归口列均不动」：open + bound_issue 保持 + resolved_at null（resolution 非空断言不适用于「不动」语义——bound 事件无任何写入，这正是修复目标）
- 检查方式「回归测试覆盖上述场景」→ ✅ 三场景全覆盖
- 存量 298/26 两批收尾路径 → PR 描述附收尾命令（batch_resolve 跨状态查询）

### 测试改动声明

方向：收紧。旧 describe 块（ageOutHighAndNotify 的 dismiss 行为断言）随行为故意变更重写为只读语义断言——不是删除覆盖，是把「验证旧缺陷行为」的断言替换为「验证修复后行为」的断言，净新增用例 5 个。

## 最简实现检查

已过最简检查：零 schema 变更、零新依赖、零新文件（改动全部落在既有 5 文件 + 3 测试文件）；修法是删除写路径 + 复用既有 resolution 结构（HealingResolution），无更简形态达成同等语义。

## 负面向验收条目

本次变更破坏了什么旧契约：①`ageOutHighAndNotify` API 消失（全仓 6 处引用已同步迁移，无绕过）——依赖「age-out 后事件变 dismissed」的任何外部假设不再成立，这正是修复目的；②`updateStatus(id, 'dismissed')` 仍存在但不再被工具层 dismiss 路径使用（其余调用面 grep 确认为零）——保留它是 updateStatus 签名的完整性，不是绕过。
