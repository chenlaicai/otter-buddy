---
id: F20261125hcoll
title: 交接采集四态可信度（H3）——失败不伪装成「无」
summary: 状态盘点六类逐项改为 {state,value,error,collectedAt} 四态包装——collector 抛错落 unavailable（渲染「不可用」）而非空值或静默；matters 关键采集失败与盘点项失败统一汇入 handoffCompleteness=incomplete 标注行，随档案与合成原料进新世；保留可降级裸重启语义（不阻塞，只可见）。
change_type: feature
doc_type: feature
created_at: 2026-11-25
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯采集/渲染契约，由真实依赖替身单测验证；不新增 LLM 自由行为"
tags: [handoff, state-inventory, matters, restart, synthesis]
modules:
  - src/frameworks/agent/state-inventory.ts
  - src/frameworks/agent/synthesis-prompt-builder.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
intent:
  problem: "交接采集失败被吞成空值：collectStateInventory 内层 try/catch 把查询失败降级为 []/null，渲染层把空值写成「无」——新世把「读不到」当「真的没有」（未闭环 matters、active 调度任务、发言石去向全部可能静默失传），且无任何 incomplete 迹象可供复核。"
  expected_effect: "采集失败输出 unavailable + 原因（渲染「不可用（采集失败：…）」，绝不写「无」）；真空 empty；主源失败走降级源 stale（值可用标降级）；matters 关键失败与盘点项失败统一汇成「⚠ 交接采集不完整」标注行随档案/合成原料进新世；换世照常完成（降级语义保留）。"
  verify_by:
    type: behavior_check
    rollback: "纯代码 revert：无 schema/数据迁移；revert 后采集回到旧口径（失败吞空），无数据损失。"
    risk_note: "engine mock（旧装配/测试）返回无四态库存时 collectUnavailabilityReasons 宽容返回空——旧形状不误报 incomplete；matterRepo 未装配（旧装配形态）现在会标 incomplete（诚实口径，生产装配已注入 matterRepo）。"
---

## 背景与问题

整改方案 §PR-09（H3）：交接采集是机械查询聚合，但失败路径与真空路径不可区分——

1. **collector 抛错被吞成空**：`collectStateInventory` 各 collector 内层 try/catch 或 `catch { return [] }` 把 DB 失败降级为空数组/空值，渲染层逐项打印「无」——「读不到」伪装成「真的没有」。新世接档案后无从怀疑。
2. **matters 关键失败静默**：`collectOpenMatters` 失败/依赖未注入返回空串，档案里没有任何「未读到待办清单」的痕迹——未闭环事项（承诺台账）可能失传且不可见。
3. **无 incomplete 汇总**：交接档案没有采集完整度概念，新世无从知道哪些「无」需要复核。

## 方案

- **四态包装**：`StateInventory` 每项从裸值改为 `CollectedItem<T> {state: ok|empty|unavailable|stale, value?, error?, collectedAt}`。
  - collector 改为抛错上抛，`collectStateInventory` 用 `Promise.allSettled` 统一捕获 → `unavailable`（带截断错误串）；
  - 真空 → `empty`；`activity` 主源（conversationRepo）失败走 entries 降级 → `stale`（值可用，渲染标「降级源」）；
  - 依赖未装配（scheduledTaskRepo/healingRepo/workspacePath 缺）→ `unavailable`（不能确认「无任务」，不伪装真空）。
- **handoffCompleteness**：库存内任一 unavailable → inventory 层 `incomplete`；agent-invoker 再并入 matters 关键失败，合成一条标注行：
  `> ⚠ 交接采集不完整（<原因清单>）——盘点中的「不可用」项非真空，接世后优先复核未闭环事项`
  随 inventoryText 进档案（`assembleHandoffArchive` 的 stateInventory）与合成原料（`stateInventoryText`），并落 warn 日志。
- **渲染契约**：unavailable 项打印「不可用（采集失败：<原因>）」，绝不打「无」；empty 照旧打「无」；stale 值照常打印 + 标降级源。
- **降级语义保留**：采集整体失败仍不阻塞换世（沿用「增强不是交接硬依赖」），只是从静默改为可见。
- **宽容旧形状**：`collectUnavailabilityReasons` 对无四态字段的对象（engine mock/旧装配）返回空清单，不误报。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| collector 抛错 | scheduledTaskRepo/healingRepo reject | 对应项 state=unavailable 带 error；handoffCompleteness=incomplete；渲染「不可用（采集失败：…）」非「无」 |
| 真空 | 全部依赖返回空 | 各项 state=empty；complete；渲染照旧「无」 |
| 主源失败降级 | conversationRepo reject + entries 有 yieldTargets | activity state=stale 值可用；渲染标「降级源」；stale 不算关键失败 |
| matters 关键失败 | matterRepo.findByConversation reject | 换世照常完成；合成 prompt 与档案均含「⚠ 交接采集不完整…matters 读取失败」标注 |
| matterRepo 未装配 | 构造不注入 | 同样标 incomplete（reason: matterRepo 未装配），非静默「无待办」 |
| 成功采集 | 正常数据 | 渲染行与旧口径一致（发言石/调度任务/产物行文本不变） |

## Verification

### 失败用例证据（bugfix）

- 基线红测：`evidence/hcol-inventory-red.log`——四态判别 5 用例在旧代码 4 失败（unavailable/empty 判别、collectedAt、渲染行均不存在）。
- 基线红测：`evidence/hcol-matters-red.log`——matters 失败/未装配/正常三态用例在旧代码 2 失败（无 incomplete 标注）。
- 修复后绿：`evidence/hcol-green.log`（45 用例，两文件全绿）。

### 回归证据

- `evidence/hcol-agent-domain.log`：frameworks/agent + interface-adapters/agent-runtime 定向 103 文件 / 1025 通过 + 1 skipped。
- 两个基线既有失败（与本改动无关，stash src 后基线复现同败）：
  - `durable-model-visible.test.ts`：缺 dist 编译产物（embedding worker），环境前置未满足；
  - `durable-runtime.test.ts` SIGKILL 重放用例：基线同败（本机真子进程重放），已知非本链问题。
- `state-inventory-entries.test.ts` 3 处行为钉按新契约更新（`inv.activity.status` → `inv.activity.value?.status` + stale 断言）；`synthesis-prompt-builder.test.ts` fixture 换 CollectedItem 包装——形状契约的显式测试化。

## 未做项

- 不改 restart 语义/锁/时序（方案「不做清单」）；合成与档案结构不动，只加标注行。
- Healing/scheduler 依赖未装配在生产装配中不存在（platforms 全量注入），unavailable 路径主要服务旧装配诚实化与失败真实暴露。
