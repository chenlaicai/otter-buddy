---
id: F20260904dscl
title: "#792 P2：dissolve 出站信号清算（aborted/dissolve 墓碑）——僵尸 pending 收口"
summary: 被解散獭已完成的产出消息若 tsp 指向 active 目标且无派发行，pendingClause（sender 不 dissolved 过滤）会将其永久计为 pending——发言人已不存在，信号永不派发，是 9/4 自链事故的弹药库残余（#792 P2）。修复：dissolve usecase 事务内为该獭名下「completed 消息 × active 目标 × 无行」槽位补 status='aborted', source='dissolve' 墓碑；dispatch_attempts.source 枚举扩 'dissolve'（存量库表重建迁移）；与 dmpe 阻尼#4（in_progress 入站销账）互为入站/出站两面。
change_type: fix
capability_test: "tests/frameworks/db/dispatch-attempt-repo.test.ts（P2 组 3 用例：核心清算+幂等 / 已记账不篡改 / 边界不误伤）+ tests/usecases/otter/dissolve-otter.test.ts（接线 3 用例）+ tests/frameworks/db/migration.test.ts（CHECK 迁移 3 用例）"
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
tags: [signal-protocol, dispatch-ledger, dissolve-cleanup, zombie-pending, schema-migration]
modules: [src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts, src/usecases/otter/dissolve-otter.ts, src/frameworks/db/migration.ts]
from: [F20260904schf]
---

## 背景

#792 三段修复的 P2（P0+P1 已随 #794 合入，mergeCommit 05eaca9）。

9/4 晨自链事故的完整链路里，dissolve 是触发器：检视獭解散后，它的历史产出消息成为信号弹药库。P0/P1 断掉了出处失真与自链点火，但**出站侧的裸槽位**仍在：被解散獭的 completed 产出消息，tsp 指向 active 目标且从未被链引擎/路由器记账的，会命中 pendingClause 全部条件（消息 completed ∧ 目标 active ∧ 无 attempt 行）——而 `pendingClause` 只过滤「目标 dissolved」，不过滤「sender dissolved」。发言人已不存在，这些信号永不派发，却在每次补扫/收件箱预告中被计为 pending：僵尸信号。

glm 对撞轮收敛的最小方案（记录于 #792 评论区与交接摘要）：dissolve 时点清算，不删消息，只补终态账。

## 方案

**dissolve usecase 第 4.6 步**（紧邻既有 4.5 入站销账）：调用 repo 新方法 `abortUnattemptedOutgoingForOtter(otterId)`，一条 INSERT…SELECT 补墓碑：

```sql
INSERT OR IGNORE INTO dispatch_attempts (...)
SELECT ..., 'aborted', 'dissolve', ...
FROM messages m, json_each(m.talking_stone_passed_to) t
WHERE m.status = 'completed'
  AND m.sender_type = 'otter' AND m.sender_id = ?   -- 只清该獭自己的产出
  AND t.value != 'user' AND t.value != m.sender_id
  AND EXISTS (SELECT 1 FROM otters o WHERE o.id = t.value AND o.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM dispatch_attempts da
                  WHERE da.message_id = m.id AND da.target_otter_id = t.value)  -- 只补裸槽位
```

设计取舍（与既有机制的关系）：

- **与 dmpe 阻尼#4 的分工**：4.5 `failAllInProgressForOtter` 清【入站】（指向被解散獭的 in_progress 孤儿账）；4.6 清【出站】（被解散獭发出、从未记账的裸槽位）。两面合起来 dissolve 后无僵尸。
- **不删消息**（glm 方案硬约束）：消息是历史事实；清算只补账，不改写任何已有行。
- **已有记账的槽位不动**（任意状态）：链引擎/路由器的记账是事实，NOT EXISTS 守住。幂等由「无行才补」天然保证。
- **墓碑宁多勿少**（同 `backfillLegacyAttempted` 安全偏置）：不加 `c.status='active'` 过滤，归档会话的历史裸槽位也翻篇——防「归档→复活」窗口内陈年信号变 pending（rbsg 教训）。
- **source='dissolve' 独立枚举值**：清算与真实派发尝试语义不同，混用 chain/retry 会污染轨迹审计。
- **失败仅日志不阻断**（硬约束 1 同款）：与 4.5 一致，账面清理不是 dissolve 主流程的前置。

**schema 变更**：`dispatch_attempts.source` CHECK 扩 `'dissolve'`。交接摘要曾记「TEXT 无 CHECK」，实现时核实为**有 CHECK**（schema.ts:785）——修正记录。因此需要存量库迁移：SQLite 无法 ALTER CHECK，走 #608/#654 表重建先例（sqlite_master 旧约束文本检测幂等 + 事务内 DROP+RENAME + foreign_keys 事务外开关）。

## 变更清单

- `src/entities/conversation/dispatch-attempt.ts`：source 类型扩 `'dissolve'`；DispatchAttemptRepo 接口新增 `abortUnattemptedOutgoingForOtter`
- `src/frameworks/db/schema.ts`：新库 CHECK 扩宽（含 dissolve）
- `src/frameworks/db/migration.ts`：`rebuildDispatchAttemptsSourceCheck`（存量库表重建，#608/#654 同模式）
- `src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts`：实现清算 SQL
- `src/usecases/otter/dissolve-otter.ts`：deps 新增可选 `abortUnattemptedOutgoing`，execute 4.6 步接线（失败仅日志）
- `src/bootstrap/usecases.ts`：装配点注入 repo 方法

## 为什么不做更多

- **system 消息残留**：sender_type='system' 且 sender_id 恰为解散獭 id 的历史消息（若存在）不在清算范围——那是 scheduler 历史语义的残留问题，与 dissolve 无关，不扩权顺手改。测试中显式断言此边界。
- **pendingClause 加 sender dissolved 过滤**：能兜底但治标——账面永远脏着，依赖查询侧过滤每处都得记得。清算让账在 dissolve 时点归实，查询侧不用改。

## 验证

- 全量 239 文件 / 3002 用例绿（worktree 本地全量复跑）；tsc --noEmit 0；eslint 0
- 新增 9 用例：repo 集成 3（核心清算+幂等 / 已记账不篡改 / 六类边界不误伤——全走真库真投影，rbsg 教训：判据路径禁 mock）+ usecase 接线 3（调用与日志 / 失败不阻断 / 未注入兼容）+ 迁移 3（窄约束拒收→宽约束放行+数据 FK 索引保留 / 二次幂等 / 新库直通）
- **最简实现检查**：已过。候选更简路径：①pendingClause 加 sender dissolved 过滤（已否——治标，账面永脏，见上节）；②复用 failAllInProgressForOtter 改造（已否——UPDATE 语义，无法补「无行」槽位，两者暴露面不同）。当前实现 = 一条 INSERT…SELECT + 一处 usecase 接线 + 一个必要迁移，无更少代码可达语义的路径。
- 迁移幂等性由 sqlite_master 约束文本检测保证（老库跑一次，新库/已迁移库直接 return）
- 不涉及 prompt/skill/协议层（纯代码+schema），golden gate 不适用

## 关联

- Issue: #792（母 issue，本 PR 后 P0+P1+P2 齐备，可闭环）
- 前序: F20260904schf（P0+P1，#794 已合入）
- 挂账: #798（截尾/降级结构修复）、#795（OR REPLACE 审计）——本 PR 不触及
