---
id: F20261125onclb
title: "once 任务重试两阶段化：快速重试耗尽后指数长退避跨睡眠冻结窗口（#1975）"
summary: "once 任务触发失败的重试窗口只有 3×65s（叠加看门狗 15min 无产出放弃 ≈ 每轮 31min，总窗口 ≈2h）——整夜睡眠冻结场景下 4 连败全部落在冻结窗口内，任务被标 error 永久停跑，「环境整夜做不了」被当「任务失败」处理（#1975 现场：夜审首夜观察核对 04:00 触发，冻结到 08:00，4 连败停跑）。修法：重试链两阶段化——①快速 65s×3（治瞬时故障）②耗尽后进入指数长退避 30m→1h→2h→4h×3（总追窗 ≈15.5h），跨越冻结窗口；两阶段全耗尽才标 error。递归实现改迭代 + 单轮尝试函数。"
change_type: fix
intent:
  problem: "once 任务（scheduleType=once，触发成功即删）触发失败后的重试窗口设计未考虑系统睡眠冻结：3 次 65s 快速重试叠看门狗放弃链路后总窗口仅 ≈2h，凌晨触发的任务重试整夜落在冻结窗口内 → 4 连败 → updateStatus('error') 永久停跑 + 当日工作无声丢失。#1975 实证：taskId 5948b9d4（夜审首夜观察核对）triggerAt=04:00 本地，4 条 execution（20:00/20:31/21:02/21:34Z）全部 skipped（看门狗放弃），healing d6689b36「once task exhausted all retries」。"
  expected_effect: "once 任务触发失败后：瞬时故障在快速阶段（65s×3）内恢复；冻结类故障在长退避阶段（30m→1h→2h→4h×3 ≈15.5h）跨越冻结窗口后恢复补做，任务不再因整夜冻结而永久 error 停跑；两阶段全耗尽（真故障）仍标 error + notify（防无限空转；error 到达上限 = 退避延迟 15.5h + 10×单轮执行等待——典型冻结 ≈18h，W2 形态随 timeoutMinutes 配置放大：默认 ≈35.5h、timeoutMinutes=1440 上限 ≈495.5h）。"
  verify_by:
    type: behavior_check
    assertions:
      - "tests/usecases/scheduler/scheduler-service.test.ts（131 绿）：新增「#1975 快速重试耗尽后长退避轮成功 → 任务删除，不标 error」——旧代码此用例必红（3×65s 耗尽即 error，第 5 次 invoke 不发生）"
      - "改造用例「重试全部失败 → error」推进 65s×3 + 15.5h 全序列后才 error——error 终态保留，真故障不无限空转"
      - "新增「长退避期间任务被禁用 → 重试链终止，不标 error」——用户主动禁用不是任务失败"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [scheduler, once-task, retry-strategy, sleep-freeze, exponential-backoff, bugfix]
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - tests/usecases/scheduler/scheduler-service.test.ts
---

## 背景（#1975 现场）

「夜审首夜观察核对」once 任务（F20261119nrorc，taskId 5948b9d4）triggerAt=2026-11-20 04:00（Asia/Shanghai）：

| 时刻（UTC） | 事件 |
| --- | --- |
| 19:59（=本地 04:00 前后） | 首次触发——执行体无产出（系统睡眠冻结中） |
| 20:00 / 20:31 / 21:02 / 21:34 | 首发 + 3 次重试，4 条 execution 全部 skipped：「看门狗放弃：锚点后 15 分钟无新产出」 |
| 22:04 | healing d6689b36（high/performance）：`once task exhausted all retries`，任务标 error 永久停跑 |

同时段佐证：每日补丁清单（08:00 cron）同夜错过触发窗口（healing 0d65750a），系统 04:00-08:00 整体静默——判定为系统睡眠冻结时段，环境外因。该任务的目的（夜审首夜观察核对）最终由人工四点核验收尾。

## 根因

旧 `triggerOnceWithRetry(task, retriesLeft=3)`：失败 → 65s 后重试 → 再失败递归 → 耗尽 → `updateStatus('error')`。

1. **重试窗口与冻结时长不匹配**：单轮 = 65s 延迟 + claim 链路 + 执行尝试 + 看门狗 15min 无产出放弃 ≈ 31min；3 次重试总窗口 ≈ 2h。凌晨冻结可达 4h+，4 次尝试全部落在冻结窗口内。
2. **「环境做不了」被当「任务失败」**：冻结期间任务本身没有任何问题，唤醒后即可正常执行；但旧语义把耗尽重试等同于任务失败，直接 error 终态。once 任务语义是「未来某刻做一次」，做不了的正确语义是「尽快补做」而不是「放弃」。

## 方案设计

重试链两阶段化（`triggerOnceWithRetry` 重构为迭代 + 单轮尝试函数 `tryTriggerOnce`）：

```
首发失败
  └─ 快速阶段：65s × 3（治瞬时故障：网络抖动 / claim 冲突）
       └─ 耗尽 → warn 日志，进入长退避
            └─ 长退避阶段：30m → 1h → 2h → 4h → 4h → 4h（总追窗 ≈15.5h）
                 └─ 全耗尽 → error + notifyTaskErrored(总尝试数 10)
```

- **单轮语义不变**：延迟 → 二次检查 active（被禁用/删除则终止链，不 error）→ `triggerTask({skipConsecutiveFailureTracking: true})` → 成功即删除任务。
- **notify 次数**：`ONCE_MAX_RETRIES + ONCE_LONG_RETRY_DELAYS_MS.length + 1`（=10，含首发），仅最终 error 时落一次，消灭静默死亡保留。
- **进入长退避时落 warn 日志**（任务未死、在长退避中——可观测但不刷屏，不加 healing 类型）。
- **链级取消 = 代际令牌**：链启动读取并登记当前代际；clearTaskTimer（onChange updated/deleted）与 stop() 推现代际——等待中的 timer 同步清理（clearTimeout + resolve），**执行中**的链在轮边界（入口/等待返回）代际失配而终止。只清等待中的 timer 不够：执行中 stop/改期后，本轮失败旧链还会继续注册后续轮（delta 复核探针实证）。新链启动读新代际，永远只认自己代的令牌，无「新链被旧取消误杀」竞态。

## 设计取舍

**候选方向对比**：

| 方向 | 淘汰理由 |
| --- | --- |
| A. 指数长退避（选定） | 不引入环境假设、机械可测、指数序列天然覆盖「先快后慢跨冻结」 |
| B. 按日历时间跳过冻结窗口 | 冻结窗口不可知（环境相关，随机器/设置变化），硬编码夜间窗口是错误的环境假设 |
| C. 耗尽后转 pending 等人工/唤醒触发 | once 任务是无人值守场景，引入人工依赖倒退；且 pending 载体语义是「补做队列」，长退避本身就在做补做 |
| D. 无限重试 | 真故障（任务本身坏）会无限空转（每轮一次看门狗等待 + 少量 token），必须有总上限 |

**代价（本方案引入的债）**：
- 真故障任务的 error 通知推迟。15.5h 只是六段长退避**延迟之和**；error 到达上限 = 15.5h + Σ（10 轮 × 单轮执行等待），单轮执行等待按失败形态与任务配置：锚点后无新产出类 ≈15min（#1975 现场形态，典型冻结场景 ≈18h）；W2 持续活跃但不 settle 类 = max(2h, 2×timeoutMinutes)——timeoutMinutes 是任务级配置（默认 15，合法区间 1–1440），**上限随配置线性放大**：默认配置 ≈35.5h；timeoutMinutes=1440 时单轮 48h、上限 ≈495.5h（约 20.6 天）。失败变晚知道，上限封顶由配置决定；
- 真故障任务多花 6 轮触发尝试（每轮一次看门狗等待 + 少量 LLM token）；
- 长退避期间 setTimeout 句柄在内存挂最长 4h（进程重启即丢——**与旧行为一致**：旧 65s 重试同样是内存态，重启后 scheduleOnce 见 triggerAt 已过直接删任务，本单不扩大范围处理重启丢失）。

**机制识别检查点判定（动手前完成）**：七项逐一核对——无新增配置面/枚举值、无新状态生命周期（error 终态仍存在，只是到达时点变晚；任务状态机 active→(error|删除) 不变）、无新定时任务种类（只是既有 once 重试链的延迟序列变化）、无新信号类型、无新持久化数据、决策分支不持久化、无跨模块路径——**判定：narrow-fix（既有语义内修，重试策略参数化收窄）**，不触发机制预算四问。

**Modification-Class 声明**：`narrow-fix`。

## 负面向验收

- 本次变更**推迟**了真故障任务失败暴露的时点（~2h → 典型冻结场景 ≈18h；W2 形态随 timeoutMinutes 放大，默认 ≈35.5h、上限配置 ≈495.5h，公式见「代价」段）：接受，once 任务无人值守场景「冻结误杀」的代价（整夜丢工作）大于「晚知道真故障」的代价。
- 未绕过任何既有保护：`skipConsecutiveFailureTracking` 语义保留、二次检查 active 保留、notify 防静默死亡保留、看门狗与 claim 链路不动。

## 验证

**失败用例证据（bugfix）**：新用例「#1975 快速重试耗尽后长退避轮成功 → 任务删除，不标 error」在旧实现上必失败——旧代码 3×65s 耗尽即 `updateStatus('error')`，第 5 次 invoke 不会发生（invokeCount 停在 4、任务留存 error 态）。验证输出见 PR Verification 节（stash 源码改动跑新测试 → 红；恢复后 → 绿）。

**测试结果**：`npx vitest run tests/usecases/scheduler/scheduler-service.test.ts` → **135/135 绿**（含新增 6 用例：长退避轮成功 / 禁用终止 / stop 等待中与执行中终止 / 改期等待中与执行中终止 + 改造 1 用例含总尝试数与耗尽通知断言）。

**验收断言（可机械复验）**：

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 冻结恢复补做 | 新用例 A：invoke 前 4 次失败第 5 次成功，推进 60min+65s×3+30m | invokeCount=5、任务已删、无 error |
| 真故障上限 | 改造用例：全败，推进 65s×3+15.5h 全序列 | error 落账、invokeCount=10（总尝试数进断言面）、无 disabled |
| 用户禁用终止 | 新用例 B：快速耗尽后手动 disabled，推进长退避全序列 | 无 error、任务保留 disabled |
| stop 终止（等待中） | 新用例 C：快速全败后 stop()，推进 30m | invokeCount 停在 4，长退避不触发 |
| stop 终止（执行中） | 新用例 E：长退避首轮 invoke 挂起中 stop()，放行失败后推进 1h | 旧链本轮失败后终止，invokeCount 停在 5 |
| 改期终止（等待中） | 新用例 D：快速全败后改期 +2h 并 updated，推进 30m 后再推进到新时点 | 旧链不提前执行；新 triggerAt 到点执行成功、任务删除 |
| 改期终止（执行中） | 新用例 F：长退避首轮 invoke 挂起中改期 + updated，放行失败后推进 1h+到新时点 | 旧链终止不进第 6 次；新时点第 6 次成功、任务删除、无 error |

**已知边界（留痕不挂账）**：长退避挂内存态，进程重启丢失重试链且 scheduleOnce 将过期 once 任务直接删除（「重启 = once 任务静默消失」是既有独立行为，非本单引入，未处理）。

## 停跑任务处置（#1975 待决策 2）

taskId 5948b9d4（夜审首夜观察核对）status=error 残留 DB——目的已由人工核验收尾，issue 倾向废弃。按「主仓 data/ 清理只由搭档人工执行」纪律，删除动作留给搭档（一条 SQL：`DELETE FROM scheduled_tasks WHERE id='5948b9d4-f419-4d6f-a447-431cad262a0d';` 或界面操作），issue 关闭评论附指引。

## 关联

- issue #1975（本单来源；healing 事件 d6689b36 / 0d65750a）
- #1893（同族前置：running 滞留机械释放 + pending 补做载体，PR #1967）——本单补的是「once 触发失败重试」这一正交缺口
