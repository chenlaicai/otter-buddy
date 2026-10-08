---
id: F20261008cqsg
title: 补偿触发风暴防护：冻结唤醒 drift 检查 + catch-up 双重配额闸门
summary: 服务停机/mac 睡眠冻结恢复后，9+ 定时任务同秒注入同一对话（上下文爆炸 + 循环守卫熔断）。修复双路径：setTimeout 快路径 drift 检查（冻结唤醒放弃直发转交 tick）+ tickReal catch-up 双重配额（每轮全局≤3、同对话≤1，超额自然错峰到下轮 5min tick）。
change_type: fix
capability_test: "n/a: scheduler tick 为私有方法，配额行为经 #1272 describe 块（tests/usecases/scheduler/scheduler-service.test.ts）双断言夹逼覆盖（≥配额防饿死 + ≤配额防风暴）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
causal_links:
  - issue: "1272"
    note: 服务停机后定时任务补偿触发风暴
  - issue: "640"
    note: 轮询补触发机制引入（本次在其上配额化）
  - issue: "823"
    note: skip 吞 claim 饿死修复（本次防饿死断言的语义来源）
tags: [scheduler, catch-up, quota, freeze-thaw, polling]
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - tests/usecases/scheduler/scheduler-service.test.ts
---

# 补偿触发风暴防护：冻结唤醒 drift 检查 + catch-up 双重配额闸门

## 预注册（troubleshooting 防HARKing）

- 预期根因方向：scheduler 启动首轮 tick 对全部 overdue 任务无节流 fire-and-forget，停机恢复后同轮全量注入。
- 验证标准：代码层 overdue 循环无上限 + 现场同秒多任务注入记录。
- 最强反例方向：若注入由 reconcile 对账（只落账不触发）或 entries 时间戳分散，则原预期反转。

**实际：预期部分命中、主刀反转。** 反转点：重启场景（scheduleNext 先填未来缓存）并不风暴；真风暴源是 **mac 睡眠冻结唤醒**——进程不重启（日志 pid 88991 从 9/30 17:47Z 持续存活到 10/1 12:04），睡眠期间 setTimeout 冻结，唤醒瞬间 9 个任务的 setTimeout 同秒到期直接 fire（快路径），轮询 interval 又补一轮。issue 标题「服务停机」实为「冻结」，两者汇合在同一条无节流路径上。

## 问题现象

10/1 12:04:07（本地）「三省吾身」对话同秒收到 9 条任务注入（execution 表实证：self-healing-analysis、依赖升级自动化、每日对话健康检查、每日 issue 处理、每日补丁清单回看、regression-verify、未闭环扫描、月度剪枝审视、客户生日提醒/每日 AI 雷达，同秒 9 行 triggered_at=12:04:07，其中 6 行 failed 3 行 skipped/completed），5 秒后 12:04:12 轮询 tick 又补一轮（9 行 skipped，被 #641 running-execution claim 拒兜住）。后果：单轮需消化 6 份任务指令 + 全量数据源，触发 2 次生成超时 + 1 次工具调用超时 + 1 次循环守卫熔断（K=6/M=3，43 条存量 resolve 连续处置被熔断）。

该对话挂 8 个 active cron 任务（DB 查证：cron 01:00–11:00 分布，Asia/Shanghai），跨夜冻结后全部 overdue 同轮释放。

## 根因分析

风暴两条注入路径，汇合点都是「同轮无节流全量触发」：

1. **setTimeout 快路径**（scheduleNext, scheduler-service.ts:407-431）：mac 睡眠期间所有 timer 冻结，唤醒瞬间同批 timer 同秒到期 fire，直接 `triggerTask`（:426）——无 drift 检查、无配额。10/1 现场 12:04:07 的 9 连发即此路径。
2. **轮询 tick 补触发**（tickReal, :317-376）：唤醒后 interval 恢复，tick 扫到全部 overdue，循环内逐个 fire-and-forget（:358-368），无配额。10/1 现场 12:04:12 的第二轮即此路径（claim 拒了，但若无 #641 兜底就是重复风暴）。

为什么重启场景不风暴：`start()` 先对每个任务 `scheduleNext` → `getNextTime()`（从 now 起）填缓存 = 未来时刻 → setTimeout delay 正常 → 首轮 tick 缓存全是未来值，不 overdue。只有「进程活着但时钟跳变」（冻结唤醒、系统休眠恢复）才会让 setTimeout 快路径成批同秒到期。

## 修复设计

修法决策树①（既有语义内修）：轮询「迟到即补」语义不变，把「同轮全补」改为「配额分轮补」；setTimeout 快路径加 drift 检查。零新增持久化/配置/跨模块调用，纯运行时临时分支——机制识别检查点逐项未命中。

**修复 1：冻结唤醒 drift 检查**（scheduleNext setTimeout 回调入口）
timer fire 时 drift = nextTrigger - now < -POLL_INTERVAL_MS（落后超一个轮询周期 = 冻结补偿而非准时抖动）→ 放弃直发，缓存回填已过时刻，交给 tick 配额闸门。drift 在周期内 = 正常调度抖动，照旧直发（保持 #640 快路径低延迟）。不重排 setTimeout——重排算出的 next 仍可能是过去时刻，会形成 fire-拦-fire 空转。

**修复 2：tickReal catch-up 双重配额**
- 全局 `CATCHUP_GLOBAL_QUOTA = 3`：每轮 tick 最多触发 3 个 catch-up（issue #1272 建议 ≤3 重任务）
- 同对话 `CATCHUP_CONV_QUOTA = 1`：每轮每对话最多 1 个（风暴危害主因是同对话上下文堆积，每条任务指令都是完整负担）
- 超额任务缓存保持 overdue，下轮 tick（5min 节拍）重新扫描——迟到≠立即，错峰是免费的。

实现坑（已修）：同对话配额初始值 `?? 0` 会把首任务误判耗尽（0≤0），必须 `?? CATCHUP_CONV_QUOTA`。首轮实现即踩此坑，靠旧 #640 测试回归抓住。

## 验证

- 失败用例（修复前）：`#1272` describe 两测试——9 任务同轮全触发（510 executions，mock 恒过去时刻导致循环连发）、同对话 5 任务 5 连发，断言夹逼失败。
- 修复后：断言改为**双向夹逼**（全局场景恰 =3、同对话场景恰 =1）——防「全部触发=风暴」也防「零触发=配额闸门空转饿死」（#823 语义：静默饿死比风暴更隐蔽）。
- 回归：scheduler 套件 131/131 绿（含 #640 补触发、#641 claim 拒、#823 饿死根修、#913 前置炸点）；全仓 5005/5005 绿；tsc/eslint 绿。

## 设计取舍（配额值与 drift 阈值四问，检视发现 1 补录）

检视指出：配额常量 + drift 分支实质是 2 个新运行时决策分支，narrow-fix 标签要求这些决策点显式对账，不能只在代码注释里。

**为什么全局是 3 不是 5？** issue #1272 建议同轮重任务≤3（大任务=日报/汇总/巡检类，单次消耗约 30-50K token；同轮 3 个≈一次满血上下文消化能力上限）。5 会把风暴从「同轮爆炸」降格为「同轮重压」，但 10/1 现场是 9 任务，5 仍然单轮过半。选 3 错峰更平滑，代价是 9 任务需 3 轮 ≈15min 排空——停机补偿慢 15 分钟可接受（这些任务全是日频，迟到不丢）。

**为什么同对话是 1 不是 2？** 风暴危害主因是同对话上下文堆积（每条任务指令都是完整负担）。1 = 严格串行，每轮间隔 5min。若 2，两份任务指令同轮注入同一对话，上下文压力叠加——这正是要防的。代价是同对话 N 任务需 N 轮排空（10/1 现场 8 任务 = 8 轮 = 40min），但这正是「错峰」的本意。

**配额值的失败后果？** 配额过低→补触发延迟拉长（饿死已由双向夹逼断言+刷新语义排除）；配额过高→风暴回归。3/1 是两者间的保守偏安全点，且有 issue 建议背书。

**为什么 drift 阈值绑定 POLL_INTERVAL_MS？** 「落后超一个轮询周期」的语义 = 「下一轮 tick 本应接住它」：drift < 5min 属正常调度抖动（setTimeout 精度/tick 边界），照旧直发保持 #640 低延迟；drift ≥ 5min 说明 tick 都没等到它准时 fire（冻结/挂起），才值得降级到配额管控。绑同一个常量避免两个独立阈值漂移。

**同对话多任务补触发时序（检视发现 3 声明）**：同对话第 2 个及以后的排队任务，补触发顺序由 `getAllActive` 的 `created_at DESC` 隐式决定（新任务先补）。无显式策略需求（都是迟到任务，先后无语义差别），不另建排序机制。

## 影响范围

- 改动文件：`src/usecases/scheduler/scheduler-service.ts`（scheduleNext drift 检查 + tickReal 配额 + 2 常量）、`tests/usecases/scheduler/scheduler-service.test.ts`（#1272 describe）。
- 行为变化：仅影响 catch-up（迟到补触发）路径的**节律**——准时触发的 setTimeout 快路径（drift < 5min）完全不变；手动触发（trigger）不走此路径。
- 不修的（issue 建议动作 2/3 明确不做）：
  - 负载感知（检查目标对话活跃任务数再排队）：跨模块新调用路径，错峰配额已间接覆盖核心风险，过重。
  - 熔断豁免（批量处置白名单豁免循环守卫）：guard 域外豁免安全机制风险大；错峰后批量处置自然分批，43 条存量连发场景不再出现。

## 验证断言对账（issue 关闭标准）

- 断言：下次停机恢复后同一对话同轮 ≤3 重任务注入、不触发循环守卫熔断。
- 检查方式：人工观察下次冻结/停机恢复 + healing 台账。
- 到期：2026-10-31。
- 机制上：同对话配额 1 保证单对话单轮最多 1 条任务注入；全局 3 保证跨对话资源压力有界；setTimeout 快路径冻结唤醒被 drift 检查拦截不再直发。等待真实停机/冻结事件自然验证。

Modification-Class: narrow-fix
