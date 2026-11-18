---
id: F20261118sprmd
title: "scheduler roster miss 自愈降级：pending 队列兜底替代 healing 账本污染（#1913）"
summary: "2026-11-16 误解散事故（F20261117dsgrd 背景）当天，大獭 session 空窗期内三个 cron 任务触发全部 no-such-role-in-roster skipped：当天任务直接丢轮（次日 cron 才补跑），且每轮白记一条 low healing event 污染账本。修复：roster miss 从「skipped + healing」改为自愈降级——cron 任务入 pending 队列（执行者就位后经 manage_scheduled_task_pending 提醒补执行，部分唯一索引保证同任务仅一条在队）；once 任务触发后即删（pending FK 悬空不能入队），改有声系统通知（原 busy 专用通道参数化复用）。healing 只在降级通道本身失败时记（fail-closed）。"
change_type: fix
capability_test: "n/a: 调度器降级路径（无独立可观测端点），以 scheduler-service.test.ts 单测（roster miss 降级 describe 3 用例：入队成功无 healing / 入队失败回退 healing / once 有声通知）+ 全量 vitest 为验证载体"
intent:
  problem: "resolveExecutorOtter 双路（名册角色解析 + talkingStone 旧实例 fallback）都落空时，triggerTask 直接 skipped + recordExecutorResolutionFailure 落 healing event。误解散事故窗口实证该路径的三个缺陷：①执行者暂时不可见≠任务该丢——当天三任务全部丢轮，次日 cron 才补跑，承诺静默迟到 24h；②暂时性 miss 记 low healing 是账本污染（daily-review 人工处置负担）；③once 任务触发后即删行，skipped + healing 之外零留痕，比 cron 更彻底的无声丢失。"
  solution: "degradeRosterMissToPending 私有方法接管 roster miss 后置处理：非 once 任务 enqueue pending（对齐 busy 分支同款兜底，id 用 crypto.randomUUID、triggeredAt 用本轮触发时刻）；once 任务走参数化后的 notifyOnceSkipUnavailable（原 notifyOnceBusySkip 泛化，reasonClause 区分「正忙」与「不在对话名册中」）。healing 记账条件收窄为降级通道失败（once 通知抛错 / pending 未注入 / enqueue 抛错或返回 false）——正常降级是已进入自愈通道的预期态，不是需要人工处置的缺陷。"
  expected_effect: "#1913 关闭标准达成：roster miss 自动重试（pending 补执行通道）或有声降级，不再产生无意义 healing event。误解散类根因已由 F20261117dsgrd（大獭不可解散）从入口防死；本修复是调度器侧纵深防御——任何未来的名册空窗（恢复窗口/误操作/真配置错误）都不再丢当天任务。真配置错误的可见性由 pending 提醒机制承载（执行者唤醒即见），不靠 healing 刷屏。"
  verify_by:
    type: behavior_check
    assertions:
      - "scheduler-service.test.ts roster miss 降级 3 用例全绿：cron miss → skipped+pending 入队+零 healing；enqueue 抛错 → fail-closed 回退 healing；once miss → createSystemEntry body 含「不在对话名册中」+零 healing"
      - "既有 F20261021sprx 用例（无 pendingItemRepo 注入）语义更新为「无 pending 通道兜底记 healing」，断言不变仍绿——最小装配环境向后兼容"
      - "busy 分支 once 通知文案经参数化后语义不变（「正忙」），相关既有用例不回归"
      - "全量 vitest 无回归；tsc --noEmit 与 eslint 对改动文件零告警"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
tags: [scheduler, roster-miss, pending-degrade, healing-hygiene, self-healing]
modules:
  - scheduler
causal_links:
  - {type: "fixes", id: "issue#1913", note: "roster miss 自愈重试/降级不产生 healing event 的关闭标准"}
  - {type: "defends", id: "F20261117dsgrd", note: "误解散根因入口已防死（大獭不可解散）；本特性是调度器侧纵深防御，覆盖任何未来名册空窗"}
  - {type: "reuses", id: "F20261021sprx", note: "roster miss 双路解析（角色名册+legacy fallback）的后置降级补齐"}
---

# scheduler roster miss 自愈降级（F20261118sprmd）

## 事故还原（#1913 真实根因）

issue 假设「dispatch 时 roster 查询早于重启完成/角色就位」——**查证不成立**：

1. `restartBeforeInvoke` 在 resolver **之后**执行（triggerTask 内 1283 行 vs 1232 行），且 restart 只动 otter_sessions（archive+新建），不改 conversation_participants / otters 表——重启窗口 resolver 照常解析。
2. DB 实证：三任务挂在对话 3241317b，执行者 87f172c6 的 session 轨迹显示 2026-11-16T06:23Z 该獭被 **dissolve**（archive_reason=dissolve），到 11-17T02:05Z 才有新 session——**20 小时 session 空窗**。三任务触发时刻（11-16T23:30Z / 11-17T00:29Z / 00:59Z）全落窗内：findRoleCandidates 名册空 + resolveLegacy 旧实例 status 非 active，双路 miss。
3. 误解散事故即 F20261117dsgrd 的背景（dissolve-otter.ts 注释直书：2026-11-16 端云改造按不属本对话的 ID 误解散了「三省吾身」大獭），搭档 11-17 定调「大獭永远不可解散」已合入防入口。

「每天 3 条」表述也不实：11-18 三任务全 completed，事件只发生在误解散窗口当日。但调度器暴露的三个真缺陷（丢轮/账本污染/once 无声）值得独立修复。

## 修复设计

### roster miss 后置处理：recordExecutorResolutionFailure → degradeRosterMissToPending

```
roster miss（双路解析落空）
├─ once 任务：notifyOnceSkipUnavailable（有声系统通知；触发后任务行即删，通知是唯一留痕）
│   └─ 通知抛错 → recordExecutorResolutionFailure（healing 兜底）
└─ cron/interval 任务：pendingItemRepo.enqueue（部分唯一索引：同任务仅一条 pending 在队）
    └─ 未注入 repo / enqueue 抛错 → recordExecutorResolutionFailure（healing 兜底）；
        返回 false = 去重命中（同任务已有 pending 在队）——正常态不记账
```

- 执行者就位后由 `manage_scheduled_task_pending` 工具的 list/detail/ack 通道补执行销账（pending 机制既有语义，busy 分支同款）。
- **healing 记账收窄为 fail-closed**：正常降级是预期态不记账；降级通道本身故障才需要人看。
- 真配置错误（executorRole 永远无主）的可见性由 pending 提醒承载（不累积：部分唯一索引）。

### notifyOnceBusySkip → notifyOnceSkipUnavailable（参数化）

busy 与 roster miss 共用 once 有声通知通道，reasonClause 区分根因：「正忙」（等一等就好）vs「不在对话名册中（暂无法解析执行实例）」（该查名册）。文案前缀 `[定时任务未执行]` 与「任务将按 once 语义删除，承诺未执行」语义保留。

## 边界与取舍

- **不加 hasExecutionInSlot 前置检查**（busy 分支有）：roster-miss 分支的同槽位 running/completed 覆盖场景要求执行者曾在场，与 miss 事实矛盾；部分唯一索引已防同任务重复在队，detail 时 hasDirectCompletionInSlot 会判 covered 引导 ack。最小改动原则。
- **skipped execution 记账保留**：触发事实留痕（#1208 口径），只改后置处理。
- **logger.warn 保留**：日志面不降可见性，只去 healing 账本污染。

## 设计取舍（mechanism-addition 机制四问）

1. **谁需要这个机制**：scheduler triggerTask 的 roster-miss 路径（双路解析落空的所有时刻）；直接受益人是对话执行者（大獭）与 daily-review 人工处置者——前者不再丢当天轮次，后者不再看到同名 low event 刷屏。
2. **失败后果**：降级通道故障（未注入 repo/enqueue 抛错/once 通知抛错）时回退 healing 记账，行为等同修复前（skipped + healing），不会更坏；若 healing 落账也失败，仅 logger.warn 留痕——与仓库其他 healing 写入的降级链一致。
3. **后续机制及其失误面**：pending 项由执行者就位后经 manage_scheduled_task_pending（list/detail/ack）消费；失误面在「执行者长期不唤醒」——pending 项静默在队。发现通道：执行者任意后续唤醒即见提醒；真正永久无主的任务（executorRole 配错）会留一条 pending 不累积（部分唯一索引），由名册巡检/人工发现。此外去重命中（enqueue 返 false）不记账是正常态，若未来 pending 消费链路度章改变此语义，需同步重审本分支记账条件。
4. **退役条件**：当「名册空窗不可能发生」（如名册持久化保证 + 解析永不过窗）或 pending 机制被更高阶重试机制取代时，本降级分支可整体移除（git revert 即可，无状态迁移）；监控信号：healing_events 中 reason=no-such-role-in-roster 的新增应归零于降级通道故障，若常态出现说明通道本身需要人看。

## 验证

- `tests/usecases/scheduler/scheduler-service.test.ts`：roster miss 降级 describe 3 用例（入队成功零 healing / enqueue 失败回退 healing / once 有声通知）+ 既有 F20261021sprx 用例语义更新（无 pending 通道的最小装配走 healing 兜底，断言不变）。
- 全量 vitest、tsc --noEmit、eslint 改动文件零告警。

## Rollback

单文件逻辑改动（scheduler-service.ts），`git revert <merge-commit>` 即可；无 schema/数据迁移。
