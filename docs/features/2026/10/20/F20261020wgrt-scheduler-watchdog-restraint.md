---
id: F20261020wgrt
title: "定时任务看门狗克制化：换轨补静默窗判死 + 放弃窗口收口 + 放弃≠失败"
summary: "watchExecutionByLedger 无静默窗，invoke 不 settle 时空转 24h 硬上限才判死（#1048 根因签名）；判死落 failed 计熔断会把误杀放大成静默停跑（#516 教训）。按 2026-10-20 搭档定调的克制原则重框：看门狗从判死仲裁降级为清坑保洁——换轨路径补静默窗判死，双看门狗硬上限 24h 收口为 max(2h,2×静默窗)，放弃等待落 skipped 不计熔断。"
change_type: fix
capability_tags: [scheduler, watchdog, reliability]
created: 2026-10-20
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [scheduler, watchdog, abandon, skipped, restraint]
modules: [src/usecases/scheduler/scheduler-service.ts]
causal_links:
  - F20261013rstk  # 2h 孤儿扫描/挤占 skip（本特性补其未覆盖的「执行方在场但 invoke 不 settle」路径）
  - F20261014rsgd  # 重启在途互斥守卫（同族克制化：宁跳过一轮，不冒掐断风险）
issue: 1048
---

# 定时任务看门狗克制化（#1048）

## 背景与案发现场

issue #1048（2026-09-20 立案，9/25 以「未再现」关闭，2026-10-20 回查判 ❌ 重开）：服务重启中断 invoke 后终态不 settle，看门狗等满 24h 硬上限才判死，定时任务失败延迟一天。

2026-10-20 regression-verify 回查实证（scheduled_task_executions 直查）：

- **修复从未落地**：issue 建议的两条修复（恢复补 settle / watchLedgerOnly 快速出口）均无对应提交（`git log -S watchLedgerOnly` 9/1 起零改动）
- **24h 签名持续复现**：error='Agent invocation timeout (ledger watch exceeded hard limit 24h)' 共 21 条、17 条在关闭后；最近 10-12 三条 execution 各恰好 24h+12s 才落账
- **反例**：085685ab 挂死 48.6h 至 10-19 重启对账才落账——「执行方在场但 invoke 不 settle」无任何 <2h 出口（#1449 孤儿扫描只管「无存活执行方」）

**2026-10-20 搭档定调（设计原则，本特性的出发点）**：定时任务可允许某一次没触发（如系统停止期间），系统不应强制追求每次定时一定执行；兜底/看门狗必须克制，先分析业务场景再决定要不要机制（先例：小獭首哑——分析确认需要重试才提供自动重试一次）。据此重审：真正要治的不是「判死不够快」而是「僵尸 running 占坑 + 记账污染」；若任务允许漏一次，24h 精确判死链本身就是过度设计。

**任务容忍度盘点**（14 条 active + 3 条 disabled 全量）：全部为分析/汇总/巡检类（daily-review 系、健康检查、观察日报、依赖升级等；paper-trading 两条已 disabled），**无一「不能漏执行」**——全部按可容忍处理。一次性任务（trigger_at 型）漏触发由 matter/未闭环扫描兜底，不加新机制（克制原则）。

## 设计取舍

**机制识别检查点判定（动手前完成）**：逐项未命中——不新增配置字段/枚举/状态生命周期/定时任务/信号类型/持久化存储；WatchdogAbandonedError 是运行时错误分类非持久化枚举；「静默超窗放弃」是纯运行时判定不写状态；skipped 终态与「不计熔断」分账复用 #1084/#1094/#1648 既有语义。修法决策树走 **② 收窄管辖（scope-reduction）**：把「看门狗等满 24h 追精确终态」的管辖边界收窄为「静默窗即放弃」，非新增机制，豁免机制预算四问。

**放弃 ≠ 失败（核心取舍）**：看门狗主动停止等待（静默判死/超放弃窗口）落 `skipped`、不计 consecutiveFailures、不触发 3 连败熔断——「放弃」=不知道跑没跑成、不等了（任务可能仍在后台跑完、可能由补扫消化）；「失败」=链 settle 后报错 / 429 配额耗尽判死（check429Retry 保持 failed 不变，配额耗尽是确认性失败且 #1068 已有 fallback 重试）。Why：#516 教训——判死落 failed 时，误杀被 3 连败熔断放大成静默停跑（8-24/25/26 日报三连误杀）；24h 收口到 2h 会放大误杀频率，必须同步解除熔断耦合，否则重蹈覆辙。

**放弃窗口 = max(2h, 2×静默窗)**：基线 2h 取「正常任务时长上限 ~1h（日报级）留一倍余量」（与 #1449 孤儿扫描阈值同源判断）；2×静默窗给 timeoutMinutes 配大静默窗的任务留余量（防静默窗 > 硬上限的倒挂）。

**闸门冻结场景的让步**：#775 原设计「无产出保守等下一轮」是怕误杀被闸门冻结、保留待恢复的信号。按克制原则让位于放弃：信号保留语义不变（恢复后补扫点燃照跑），看门狗只是不再硬等——记账出现「skipped 但实际后来跑完」的误差，按可漏原则接受（记账诚实度 < 不卡执行位）。

**范围边界（刻意不扩面）**：非链降级路径 SINGLE_INVOKE_TIMEOUT_MS 5 分钟一刀切保留旧语义（旧装配兼容，无链可观测）；429 配额耗尽判死保持 failed；孤儿扫描/挤占 skip/启动死亡证明（#1449/#1459）不动。

## 变更内容

- `scheduler-service.ts`：
  - 新增 `WatchdogAbandonedError`（看门狗主动放弃的错误分类）+ `WATCH_ABANDON_BASELINE_MS`（2h）+ `resolveAbandonWindowMs()`；退役 `LEDGER_WATCH_HARD_LIMIT_MS`/`MAX_CHAIN_TIMEOUT_MS` 两个 24h 常量
  - `watchExecutionByLedger`：补静默窗判死——锚点后静默窗内零产出（含探测失败，判不出活按死处理）→ 放弃；新增 `hasFreshOutputAfter()` 进展探测（与 isChainStillActive「任一状态都算活跃」同语义，查询失败按无进展）；活跃假死超 `resolveAbandonWindowMs` 同样放弃
  - `watchChainWithActivity`：硬上限 24h → `resolveAbandonWindowMs`；静默判死/无锚防御/硬上限三处抛错改 `WatchdogAbandonedError`
  - `triggerTask` catch：`WatchdogAbandonedError` → `handleExecutionSkipped`（记 skipped 不计熔断）+ rethrow，与 DirectChainGatedError 分流同族
- 测试（tests/usecases/scheduler/scheduler-service.test.ts）：新增 W1/W2/W3（静默判死即放弃 / 放弃窗口收口 / 放弃落 skipped 不计熔断）；W1-W3 为 bugfix 硬规则的固化失败用例，独立 commit 落史（红 → 绿）
- 既有用例 2115 断言调整（独立 commit）：`expect(err.message).toBe('Agent invocation timeout')` → `toBeInstanceOf(WatchdogAbandonedError)` + `toContain('看门狗放弃')`。**调整理由**：该断言锁的是「静默判死 = 任务失败」旧语义，本特性有意把判死重分类为「放弃」（上述核心取舍），断言必须随语义走——行为变化是修复本体不是测试让步，红绿证据链见下

## 对旧特性做了什么

- **#775（换轨 watchExecutionByLedger）**：推翻其「无产出 → 保守等下一轮，硬上限兜底」设计决定（当时的顾虑是误杀闸门冻结的保留信号），改为静默窗即放弃——保留信号由补扫点燃兜住，不再靠看门狗硬等（搭档克制原则取代）
- **#516（链活跃看门狗）**：判死落账语义从 failed（计熔断）改为 skipped（不计熔断）——判死=放弃≠失败，解除误杀与 3 连败熔断的耦合；静默窗/活跃续期机制本身不动
- **硬上限语义**：恒 24h → max(2h, 2×静默窗)，注释与常量同步更新

## 验证

- 固化失败用例证据（bugfix Verification 硬规则）：W1/W2/W3 修复前实跑输出 `AssertionError: expected 'still-waiting' not to be 'still-waiting'`（旧语义下 65s/2h10m 时点看门狗仍在空转，无任何终态）——commit dbfc5ad9 红；实现 commit 7834edd7 后 W1/W2/W3 全绿
- `npx tsc --noEmit` 干净；`tests/usecases/scheduler/` 全量 **151 passed（6 文件，含新增 3 例与 2115 新断言）**
- 最简实现检查：已过——放弃落账复用 `handleExecutionSkipped` 既有通道（#1084 先例），进展探测复用 `entryRepo.getEntriesAfter` 既有接口，零新依赖、零新配置、零 schema 变更

## 影响范围

- 行为变化面：所有定时任务的看门狗超时行为——原「等 24h 落 failed 计熔断」变为「静默窗/放弃窗口到即落 skipped 不计熔断」；假失败→熔断停跑的二阶伤害消失，代价是「放弃了但实际后来跑完」的记账误差（可接受，可漏原则）
- 连续放弃的任务不会自动停跑（不计熔断）——静默 no-op 的可见性由 skipped execution 行 + skipped-24h-ratio 指标（#1208）+ self-healing 日报承接，不再加新告警（克制原则）
- 不触及：非链降级路径、429 判死、孤儿扫描/挤占 skip/启动死亡证明、任务调度与 claim 锁
