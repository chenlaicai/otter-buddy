---
id: F2026090211v4
title: "信号轨迹 UI 判据切台账（sgp2 S1b）：三态扩四态，FAILED 首次可见"
doc_type: feature
summary: >
  sgp2 迁移路径 S1b（F20260902sgp2 §4.7）：QuerySignalTrail 投递状态真相源从「游标 +
  streaming 5min 墙钟窗」切换为 dispatch_attempts 台账，状态盒三态扩四态（新增 FAILED）。
  三条验收：多獭会话「永远排队」徽标痊愈 / 5min 墙钟窗状态倒退消除 / 失败首次可见（❌+note，
  手动 retry 的 UI 面闭合）。四态全部是持久层纯函数，Date.now() 从判定路径消失。
status: implemented
change_type: feature
tags: [signal-protocol, dispatch-ledger, signal-trail-ui, sgp2-s1b]
modules: [src/usecases/conversation/, src/frameworks/db/conversation/, web/src/lib/, web/src/pages/conversation/]
capability_test: tests/usecases/conversation/query-signal-trail.test.ts
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
causal_links:
  from:
    - F20260902sgp2   # 母设计（§4.7 判据映射表 + S1b 段定义）
    - F20260902u5tr   # 轨迹 UI v1（被本设计切换判据的前身，实现框架复用）
    - F20260902rbsg   # 回滚根因（「未读≠待行动」——本设计把 UI 判据也搬回台账）
---

# F2026090211v4: 信号轨迹 UI 判据切台账（sgp2 S1b）

## 目标

轨迹 UI 的投递状态从 v1 判据（游标越过 + streaming 5min 窗）切到 dispatch_attempts 台账
（F20260902sgp2 §4.7 映射表），状态盒扩四态。**UI 显示的账 = 路由器 S2 将要消费的账**
（同一张表、同一个 repo），轨迹与调度不再可能各说各话。

### 验收对照（§4.7 三条，全部落测试）

| # | v1 缺陷 | v2 表现 | 测试 |
|---|--------|---------|------|
| 1 | 多獭会话游标滞后 → 「⏳排队」永挂（僵尸徽标） | 排队=无 attempt 记录，滞后≠排队 | PENDING 用例：游标=99 仍 PENDING→记账后翻篇 |
| 2 | 长链 invoke 超 5min → ⚡倒退回 ⏳（ACTIVE_WINDOW_MS 墙钟混入判定） | in_progress 是持久行，无窗无倒退 | CONSUMING 用例：无时间窗条件 |
| 3 | failed 消息显示「✓已处理」= 撒谎，R3 用户可见面断头 | ❌ FAILED + note（含 retry 前情），用户据此决定手动 retry | FAILED 用例：failed/aborted + note 透出 |

## 方案设计

### 判据切换（query-signal-trail.ts 重写）

v1：`resolveState(turnNumber, cursor)`——游标比较 + `Date.now()` 墙钟窗，逐参与者拉游标
（loadCursors 的 streaming 判定）。
v2：`resolveTrailState(attemptStatus)`——单函数四值映射，无时间参数：

| attempt status | UI 态 | 说明 |
|---|---|---|
| 无记录 | ⏳ PENDING | 排队=还没派发；含 repo 未注入降级（保守不撒谎） |
| in_progress | ⚡ CONSUMING | 持久行，重启后依然正确 |
| completed | ✓ CONSUMED | |
| failed / aborted | ❌ FAILED | title 显 attempt.note（§8.2 retry 前情压缩随之可见） |

- DTO 扩展：`state` 加 `"FAILED"`，新增 `note?: string | null`（仅 FAILED 态携带）
- repo 层新增 `listAttemptsForConversation(conversationId)`（无 limit——(message,target)
  UNIQUE 键防膨胀），与 pendingClause 同文件同真相源；usecase 批量拉取构 Map 直查，
  **无逐信号 N+1**（v1 的 turnNumber 逐个反查一并消失）
- **Date.now() 从判定路径消失**——「UI 状态 = f(持久层)」从 v1 近似（墙钟混入）变严格成立
- 装配：usecases.ts 注入 `dispatchAttemptRepo`；不注入（可选）时全部信号降级 PENDING
  ——没读到账不能假装有账

### 前端（web/）

- `TrailItem.state` 扩四态 + `note` 字段；`trailStateMeta(state, level, note?)` 加 FAILED
  分支：`❌ 处理失败`（rose 色，title = `派发失败（level）：note`）
- SignalTrailChip 汇总态优先级改 `FAILED > CONSUMING > PENDING > CONSUMED`——失败不可被
  其它目标的正常态掩盖（v1 汇总逻辑是「任一 CONSUMING→PENDING→CONSUMED」，FAILED 无处安放）
- 措辞约束不变：PENDING 只说「排队待消化」，不说「正在忙」/「第几位」

## 影响范围

- 后端：query-signal-trail.ts（重写）、dispatch-attempt.ts（接口 +1 方法）、
  sqlite-dispatch-attempt-repo.ts（+1 方法）、bootstrap/usecases.ts（注入）
- 前端：api contract DTO、signal-trail.ts、SignalTrailChip.tsx、双侧测试
- **只动读路径**：链引擎记账写路径（S1 已合）零改动；路由器仍摘除（S2 范围）
- 回滚面：revert 本 PR 即回游标判据（台账表留存无害）

## 取舍表

| # | 决策 | 取 | 舍 | 理由 |
|---|------|----|----|------|
| 1 | 判据真相源 | 台账 dispatch_attempts | 保留游标判据做降级混合 | 混合=两个真相源拼接，重启边界上仍会不一致；一刀切台账，S1 backfill 墓碑保证存量有账，切换即自洽 |
| 2 | note 传输 | 仅 FAILED 态带 | 全态带 note | 非 FAILED 的 note（如墓碑 legacy 标记）对用户是噪音；失败原因才是行动线索 |
| 3 | repo 缺省行为 | 降级全 PENDING | 抛错/降级全 CONSUMED | 装配不完整时保守显示「待消化」；显示「已处理」是说谎（v1 教训：不假证已读） |
| 4 | 汇总态优先级 | FAILED 最高 | 沿用 v1 顺序（无 FAILED） | 汇总徽标一处可见性——失败被「处理中」掩盖 = 验收 3 落空 |

## 验证

- 后端 2818 tests 全绿（query-signal-trail 9 用例重写：四态各一 + aborted 归并 + 多目标
  精确 + 非信号过滤 + 降级 + 时序；记账走 recordStart/recordFinish 生产写入口，非手写 INSERT）
- 前端 387 tests 全绿（trailStateMeta 四态 + FAILED note 边界：无 note 不显示 undefined）
- tsc/eslint 双侧 0 error
