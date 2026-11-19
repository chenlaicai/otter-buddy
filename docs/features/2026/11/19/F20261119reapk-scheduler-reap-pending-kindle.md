---
id: F20261119reapk
title: "scheduler 机械释放补 pending 入列：「恢复后由补扫消化」的载体保证（#1893）"
summary: "定时任务执行体滞留超 2h 机械释放后，当轮工作失去全部载体——11-13 健康检查当日 daily-review 缺失实证（双触发抑制链：首触发 running 滞留，二次触发被同槽 running 抑制成不入列的账面 completed，机械释放只翻篇不管消化载体）。修法：仅轮询释放路径补 kindleReapPending（挤占触发点不 kindle——翻篇后本轮立即放行新触发，新执行即当轮载体；此时入列会赶在新行建立前完成，同槽双载体并发且消费链覆盖重查只认 completed，running 窗口拦不住补做）；仅 agent 型入列（function 无 pending 角色通道）；同槽无其他 running 且无真直发 completed（抑制型不算覆盖）则 enqueue（保原槽位，恢复后经既有提醒通道补做/弃做留痕）；once 不入列；索引去重静默；入列结果以状态枚举落 healing（kindled/covered/deduped/skipped/error 可区分，异常不再与去重同形）。KeepAlive 探针为长期项不进本 PR。"
change_type: bugfix
capability_test: "n/a: 纯代码逻辑修复非 LLM 行为采样面——入列判定矩阵 9 例 + 真实 SQLite 集成 4 例（tests/usecases/scheduler/scheduler-service.test.ts F20261119reapk 两 describe：实证场景/同槽双跑/真直发覆盖/索引去重/挤占不 kindle/function 守卫/抛错 error 态/once 守卫 + 11-13 形态真库/同槽即时重试真库/三行现场回归/直发分支零 pending）；现场维度的验证载体是后续 healing 落账 context.pendingKindleState 与 pending 项消费留痕"
intent:
  problem: "机械释放的语义缺口：reapStaleRunningExecutions 只做「账面翻篇 + healing 落账」，隐含假设「恢复后由补扫消化」——但补扫消化的载体（pending 项）在双触发抑制链下恰好不存在。11-13 实证：00:51 首触发注入后执行方冻结，消息悬空；00:56 二次触发走忙判入列路径，covered 判定同槽 running 已覆盖→不入列、execution 落 completed（message_id=NULL 账面完成）；02:54 机械释放首触发后，当轮工作无任何载体。对照组：11-14/16/18/19 每天「execution 秒完成 + 同时刻 pending 项」成对存在，唯独 11-13 断链。"
  solution: "机械释放与消化载体绑定为原子动作：reapStaleRunningExecutionsForTask（轮询扫描）与 reapPreemptingExecutions（挤占触发点）翻篇 failed 后调 kindleReapPending——守卫（pendingItemRepo 未注入/once 任务）短路；同槽覆盖判定用两个既有原语（hasExecutionInSlot(['running'], 排除自己) 防双跑重复、hasDirectCompletionInSlot 真直发 completed=已覆盖），抑制型 completed（message_id=NULL）显式不算覆盖（正是事故形态）；enqueue 由部分唯一索引去重（同任务已有 pending=已有载体，静默返回 false）；triggeredAt 用原 execution 槽位保持同 cron 槽对账语义。healing context 增 pendingKindled，suggestion 按入列结果分叉。失败仅日志不阻塞释放本体（释放是主语义，入列是增强）。"
  expected_effect: "执行方冻结恢复后，被机械释放的当轮任务经 pending 提醒通道可见可补做（消费留痕：补做或弃做均记 resolution）——「恢复后由补扫消化」从注释口号变为有载体的可执行语义；正常双触发/真完成场景零行为变化（覆盖判定短路）；次日 cron 自然覆盖仍兜底。"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [scheduler, reap, pending, kindle, stalled-execution, catch-up]
modules:
  - scheduler
causal_links:
  - {type: "fixes", id: "issue#1893", note: "running 执行体滞留超 2h 机械释放——本 PR 补消化载体；KeepAlive 外部探针（M-0fa0a734 进程停机无外部哨兵）保持 issue 关联不在此范围"}
  - {type: "complements", id: "F20261119sprmd", note: "同域先例：roster miss 降级入 pending（degradeRosterMissToPending）——本 PR 复用同一 pending 通道与索引去重语义"}
  - {type: "same-family", id: "F20260901schd", note: "调度器三连修（轮询补触发+claim 竞态+429 看门狗） lineage——本 PR 收窄到机械释放后的消化载体缺口"}
---

# scheduler 机械释放补 pending 入列（F20261119reapk）

## 事故现场（#1893 数据实证）

11-13 健康检查（taskId b7b6639f，cron 30 8 * * *）完整断链：

| 时刻 | 事件 | 载体状态 |
| --- | --- | --- |
| 00:51:37 | catch-up 补触发（execution 9b966a4e，running）——执行方睡眠冻结，注入消息未消费 | 消息悬空 |
| 00:56:38 | 下一 tick 二次触发（execution 4344ce66）——忙判=busy（首触发在跑）→ `covered` 判定同槽 running 已覆盖 → **不入 pending**，execution 落 completed（message_id=NULL 账面完成） | 无 pending 项 |
| 02:54:13 | 轮询扫描机械释放 9b966a4e → failed + healing（4a2fde07）——只回收账面 | 当轮工作失去全部载体 |
| 当日 | 健康检查 daily-review issue 缺失（11-13 无产出） | 目标丢失，无人补跑 |

对照组实证：11-14/16/18/19 每日「execution 秒完成 + 同时刻 pending 项」成对存在（pending_items 表），唯独 11-13 断链——机械释放后补扫消化无载体不是假设，是实据。

同型第二例：self-healing-analysis（cc1cfa4f）11-14 看门狗放弃 4h + 11-16 机械释放（31a75a64）——两天两任务证实系统性缺口（issue 范围补充已记录）。

## 根因：双触发抑制 × 机械释放无载体

`claimAndValidateTask` 的忙判路径（scheduler-service.ts）对 cron 任务：「同槽位 running/completed 已覆盖本轮，failed/skipped 不抑制（pending 兜失败重试）」——但这个「兜」只在**触发时**生效。机械释放发生在**触发之后**（2h 阈值），它翻篇的正是当时提供「覆盖」的那条 running：

1. 首触发 running 滞留（冻结）→ 它是二次触发的 covered 依据（running 算覆盖）
2. 机械释放把它翻篇 failed → covered 依据消失，但已没有人再看一眼是否需要补 pending
3. 「恢复后由补扫消化」的注释假设信号保留语义兜住——但信号保留只保证「消息还在」，不保证「有人回头消费」（冻结恢复后无重燃点）

## 修法：kindleReapPending（机械释放与消化载体绑定，仅轮询路径）

```ts
// 仅轮询释放路径（reapStaleRunningExecutionsForTask）翻篇后：
const kindleState = await this.kindleReapPending(task, exec); // kindled/covered/deduped/skipped/error
await this.recordReapHealing(task, exec.id, kindleState);
// 挤占触发点（reapPreemptingExecutions）不 kindle——翻篇后本轮立即放行新触发，
// 新执行即当轮载体；此时入列会赶在新行建立前完成，同槽双载体并发。
```

判定链（全部复用既有原语，零新表零新索引）：

1. **守卫短路**：pendingItemRepo 未注入（降级装配）/ once 任务（行触发后即删，pending FK 悬空）/ **function 型任务**（无 pending 角色通道，入列只会让獭把函数 body 当任务展开）→ skipped 不入列
2. **同槽另有 running** → covered 不入列（防双跑重复——同槽即时重试场景）
3. **同槽有真直发 completed**（hasDirectCompletionInSlot：completed 且 message_id 非空）→ covered 已覆盖不入列
4. **抑制型 completed（message_id=NULL）不算覆盖**——正是 11-13 事故形态：账面完成≠工作有人干
5. **enqueue**：triggeredAt 用原 execution 槽位（次日消费按同 cron 槽对账）；部分唯一索引去重（同任务已有 pending=已有载体，返回 false 静默 → deduped）
6. **healing context.pendingKindleState** 状态枚举落账（kindled/covered/deduped/skipped/error），suggestion 按状态分叉——入列异常与正常去重/覆盖必须可区分（error 态明示需人工核查 pending 队列），否则归因错误

**挤占路径不 kindle 的完整闭环论证（二轮修正后）**：翻篇后新触发的所有分支都有载体——直发成功 → completed 载体；新执行滞留 → 2h 轮询释放时 kindle；新触发遇忙 → 忙判 covered（修正后只认 running/真直发 completed）判无覆盖 → 入 pending；新触发 skip 后下轮 catch-up 再触发。唯一需要 kindle 的窗口是「没有新触发在途」的轮询释放，两个路径职责不重叠。

**忙判 covered 语义修正（二轮必修，治 11-13 第一因）**：原忙判 covered 认一切 completed（含抑制型 message_id=NULL）为覆盖——「A 滞留翻篇 + B 抑制型在场 + C 遇忙」现场会三行全空载体（failed + 两笔 NULL-completed，无 running 无 pending），正是 11-13 事故的完整复现链。修正为只认 running 或真直发 completed（hasDirectCompletionInSlot）；连续遇忙由部分唯一索引去重防 pending 爆炸。可选能力降级：降级装配/mock 未注入 hasDirectCompletionInSlot 时按无覆盖处理（宁多入列一条由索引去重，不炸忙判主路径）。

失败仅日志不阻塞释放本体——释放是主语义（回收执行位），入列是消化增强。

## 边界（已知与不修）

- **执行方恢复后仍不主动消费**：pending 项的可见性依赖既有提醒通道（manage_scheduled_task_pending 工具+獭就位提醒）；若执行方长期不活跃，次日 cron 触发时消费判定「过期即弃」或「补做」由消费獭裁量留痕——本 PR 保证载体存在与可见，不强制补做语义（定时任务允许漏一次执行是 #1048 搭档定调，克制优先）
- **KeepAlive 外部探针不在本 PR**：进程停机无外部哨兵（issue 长期方案，关联 M-0fa0a734）是独立工程（外部 watchdog 进程），保持 issue 关联
- **冻结根因不治**：睡眠冻结/限流是系统外因，机械释放+载体兜底是可做的全部

## 验证

- 单测 9 例（tests/usecases/scheduler/scheduler-service.test.ts，F20261119reapk describe）：
  1. 11-13 实证场景：轮询翻篇 + 同槽仅抑制型 completed → 入列（槽位/任务/角色/对话四字段断言 + pendingKindleState=kindled）
  2. 同槽另有 running → 不重复入列
  3. 同槽真直发 completed → 已覆盖不入列
  4. 索引去重（enqueue 返回 false）→ 静默、pendingKindleState=deduped
  5. 挤占触发点不 kindle：翻篇即放行新触发（新执行即载体），同槽无双载体窗口，healing 不带 kindle 态
  6. function executor 不入列（pendingKindleState=skipped）
  7. enqueue/槽位查询抛异常 → error 态落账（suggestion 明示需人工核查），释放本体不受阻
  8. once 守卫不入列
  9. 真实 SQLite 集成四例：11-13 形态（抑制型 completed 真库判定放行+真库入列）、同槽即时重试（真库 running 判 covered 不入列）、三行现场回归（A 带锚点判死翻篇 + B 抑制型在场 + C 挤占后遇忙 → 忙判 covered 不认抑制型、恰好一条 pending）、挤占后直发成功分支（真库零 pending）——判定链在真实槽位 SQL 下端到端验证，mock 翻篇与真库双写同步忠实模拟生产同库行为
- 全量 scheduler-service 129 例绿；tsc/eslint 绿
- 现场观察项（后续 healing 落账）：机械释放事件的 context.pendingKindleState 分布与 pending 项消费 resolution 留痕

## 对抗检视处置（首轮 BLOCK 两条必修+两条建议全采纳）

- 🔴 挤占路径 kindle 断双跑链（kimi 发现：挤占点先 kindle 后建新 running，pending 会在新直发 invoke 中被提醒，消费重查只认 completed，运行中窗口仍可展开补做）→ 采纳修法：挤占路径不 kindle（新执行即当轮载体，完整闭环论证见修法节）
- 🔴 function executor 误入 agent pending 通道（无消费者，獭会把函数 body 当任务展开）→ 采纳：kindle 守卫加 executorType!=='agent' 短路
- 🟡 pendingKindled=false 三态混一（异常/去重/覆盖同形，归因错误）→ 采纳：状态枚举 pendingKindleState（kindled/covered/deduped/skipped/error）+ suggestion 分叉，error 态明示需人工核查
- 🟡 判定矩阵未触达真实 SQL 语义 → 采纳：补两条真实 SQLite 集成测试（11-13 形态 + 同槽即时重试）+ enqueue 抛错与 function 守卫用例

## 对抗检视处置（二轮 BLOCK 一条必修+一条建议全采纳）

- 🔴 挤占撤 kindle 后忙判分支闭环缺口（kimi 发现：A 滞留翻篇 + B 抑制型在场 + C 遇忙 → 忙判 covered 认 B 为覆盖 → 不入列 → 三行全空载体，11-13 形态复发）→ 采纳修法：修正忙判 covered 语义——只认 running 或真直发 completed（治第一因：原忙判语义正是 11-13 事故首环）；补三行现场真库回归（恰好一条 pending）与直发成功分支真库断言（零 pending）；可选能力降级防降级装配炸主路径
- 🟡 对外说明旧口径（PR body/frontmatter 仍写两释放点 kindle、pendingKindled、6 例）→ 采纳：frontmatter capability_test 与 PR body 全量同步至现状（仅轮询路径/五态枚举/9+4 例）
