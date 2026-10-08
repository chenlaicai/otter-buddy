---
id: F20261008hcpa
title: "healing 治本三层改造：打断-疏通-接盘（#1356）"
summary: "healing 事件「升级信号无人接盘」根治——层1 打断（guard bounce 上限 3→2，同规则第3次拦截直接升级走人）、层2 疏通（restart-service.mjs 新增 kill-by-pid 子命令，按 PID 受控终止自有项目进程）、层3 接盘（autoStaleDismiss 排除 high + 超龄 high 推 healing-alert-registry + self-healing-analysis 对 high 强制 bind_issue）"
change_type: feature
capability_test: "n/a: 守卫参数调整 + repo 层 severity 分层 + 调度层 alert 推送，验证走单测（stale-severity/kill-by-pid/guard-bounce/scheduler-service），无独立 LLM 能力面"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
causal_links:
  - "#1356"
  - "#844"
  - "F20261008gfrc"
  - "F20260914dsrv"
tags:
  - healing
  - guard
  - governance
  - scheduler
modules:
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - scripts/restart-service.mjs
  - src/frameworks/db/healing/sqlite-healing-event-repository.ts
  - src/usecases/healing/healing-event-repository.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/bootstrap/platforms.ts
  - prompts/scheduled/self-healing-analysis.md
intent:
  problem: "healing 事件治理三重断裂：①升级通道终点只是 severity 标签无后续动作（27 条 high 挂着无人处置）；②控制信号终态后獭仍撞墙（e8e21216 六分钟 7 次重复拦截）；③autoStaleDismiss 无 severity 过滤（high 可被时间静默，#1356 治理洞）。9:00 self-healing-analysis 每天清库但产消速率差导致 9 点后新产事件无人管"
  expected_effect: "层1：同规则第3次拦截不再自动回发，直接升级（abort+healing high+系统消息）——打断更早，升级信号不被无视。层2：kill-by-pid 子命令提供受控 PID 终止入口（白名单/cwd 归属/主进程拒绝三重校验）——疏通正当诉求。层3：high 不被时间静默（autoStaleDismiss 排除 high），超龄 high 48h 推 alert-registry 提醒大獭（resolver 不可达时跳过本轮 age-out，事件保持 open 等下轮），消费任务对 high 强制 bind_issue——升级信号有接盘"
  verify_by:
    type: behavior_check
    detail: "单测覆盖：stale-severity（autoStaleDismiss 排除 high + ageOutHighAndNotify 取回/幂等/不参与 resolved/二次调用幂等视图）、kill-by-pid（assertKillByPidSafe 静态校验 8 用例）、guard-bounce（GB-3 上限 2 语义）、scheduler-service（alert 推送/resolver 不可达跳过 age-out/无超龄不 warn）。全量 5039/5039（非 flaky 用例全绿；4 个已知 flaky 超时用例见 #1366）+ tsc 0 错"
created_at: "2026-10-08T16:15:00+08:00"
---

# healing 治本三层改造：打断-疏通-接盘（#1356）

## 背景

9/14 #844 修完后（端口白名单+restart-service.mjs+重复拦截升 high），healing 事件治理仍有三重断裂：

1. **升级无后续**：#844-C 生产的 high 事件（变体重试 ≥3 次升级）只是 severity 标签，无强制处置动作——27 条 high 挂着无人管
2. **撞墙无打断**：控制信号 3/3 终态后獭仍继续撞墙（e8e21216 六分钟 7 次），guard bounce 上限 3 次太宽容
3. **时间静默无分层**：autoStaleDismiss 每日批量 dismiss 超龄 open 事件，无 severity 过滤——high 升级信号可被时间静默（#1356 治理洞）

9:00 self-healing-analysis 每天清库（resolve 76 条），但产消速率差导致 9 点后新产事件（73 条 open、27 条 high）无人处置。

## 方案

### 层1 打断（guard bounce 上限收紧）

`retry-policy.ts`：`GUARD_BOUNCE_MAX` 3→2。同规则第 3 次拦截不再自动回发，直接走升级路径（abort 终态 + 系统消息 + healing high）。

### 层2 疏通（kill-by-pid 子命令）

`scripts/restart-service.mjs` 新增 `kill-by-pid` 子命令：按 PID 受控终止自有项目进程。安全不变式与端口路径同构（白名单/cwd 归属/主进程拒绝），只是换了个寻址方式。`assertKillByPidSafe` 纯函数导出供单测。

### 层3 接盘（high 不被静默 + 超龄提醒 + 强制归口）

- `sqlite-healing-event-repository.ts`：`autoStaleDismiss` 排除 high（`severity <> 'high'`），新增 `ageOutHighAndNotify(staleDays)` 取回超龄 high 并置 dismissed
- `scheduler-service.ts`：healing 分析任务中先解析提醒目的地（resolver），不可达时**跳过本轮 age-out**（事件保持 open 等下轮——提醒通道是 age-out 的前置条件而非事后补充）；可达时调用 `ageOutHighAndNotify(2)`（48h，RETURNING 原子取回，跨进程双实例不重复推 alert），返回非空时推 `healingAlertRegistry`（批量超限聚合成单条摘要，不静默丢）
- `prompts/scheduled/self-healing-analysis.md`：high severity 硬规则——必须 bind_issue 归口到 GitHub issue，不得直接 dismiss/resolve

## 影响范围

- 守卫行为：guard bounce 上限 3→2，第 3 次拦截直接升级（更早打断）
- healing 事件生命周期：high 不再被 autoStaleDismiss 时间静默，超龄走 alert-registry 提醒
- self-healing-analysis 消费：high 事件必须 bind_issue，不得静默处置
- 运维操作：kill-by-pid 提供按 PID 终止入口（场景：僵尸进程/测试残留）

## 取舍

- **上限 2 而非 1**：第 1 次拦截仍给自纠机会（bounce 回发），第 2 次再拦说明獭没听懂，第 3 次直接升级——比 3 次更早，但保留了自纠窗口
- **48h 而非 24h（审视建议 C 采纳）**：日调度每天一班，24h 阈值与调度零冗余——漏跑一天（进程停摆/调度故障）即翻转 bind_issue 语义；48h 留一天调度冗余，仍然远紧于 30 天 staleDays
- **resolver 懒解析 + 不可达跳过（审视建议 A 采纳）**：healing 主对话 ID 经 settings 仓异步解析（构造期 ensureHealingConversation 可能未就绪），不可达时**跳过本轮 age-out**（事件保持 open 等下轮，而非「先 dismiss 后丢提醒」）——提醒通道是 age-out 的前置条件而非事后补充
- **alert 超限聚合（审视建议 B 采纳）**：批量推送改走 enqueueBatchAggregated——≤20 逐条保留，超限聚合成单条摘要（类型计数 + ids），提醒不静默丢

**Modification-Class**：`mechanism-addition`（alert 注入链路/age-out 独立通道/kill-by-pid 子命令/分层处置是新堩机制，非既有逻辑参数调优；guard bounce 上限 3→2 部分为 narrow-fix）。机制预算四问：

1. **新能力**：①超龄 high 独立 age-out 通道（推 alert-registry 提醒）；②restart-service kill-by-pid 子命令；③healing 消费任务对 high 强制 bind_issue（prompt 硬规则 + fallback 同步）
2. **预算理由**：#1356 治理洞——high 升级信号被时间静默/无提醒通道/正当诉求无出口，三层均为填补既有治理链路缺口，非能力扩张
3. **退役路径**：若 healing 事件总量长期低位（告警通道饱和度指标 <5% 持续 30 天），age-out 提醒通道可退役；kill-by-pid 随端口路径同进退
4. **越界检查**：alert-registry 仍为进程级内存队列（不落库、不跨进程），台账 healing_events 仍是唯一持久化真相源；kill-by-pid 与端口路径同构三重校验（白名单/cwd/主进程），无新增豁免面

## 验证

- `sqlite-healing-event-repository-stale-severity.test.ts`：autoStaleDismiss 排除 high、ageOutHighAndNotify 取回/幂等/不参与 resolved（4 用例）
- `restart-service-kill-by-pid.test.ts`：assertKillByPidSafe 静态校验（8 用例：PID 合法性/主进程/自身/projectDir 边界）
- `agent-invoker-guard-bounce.test.ts`：GB-3 上限 2 语义（seed 2 条→第 3 次升级）
- `scheduler-service.test.ts`：alert 推送/resolver 不可达跳过 age-out/无超龄不 warn（3 用例）
- `healing-alert-registry.test.ts`：enqueueBatchAggregated ≤上限逐条保留 + 超限聚合单条摘要（2 用例）
- 全量 5039/5039（非 flaky 用例全绿；4 个已知 flaky 超时用例见 #1366）+ tsc 0 错

### 对抗审视修复记录（检视獭-1361，2026-10-08）

- **严重1**：retry-policy.test.ts 三处断言同步（GUARD_BOUNCE_MAX=2、第 2/2 次、已连续 2 次）；HEALING_FALLBACK_PROMPT 补 high 硬规则段落（与模板逐字节同步，模板守卫测试机械校验）
- **建议 A**：resolver 解析前置于 age-out 事务之前，不可达时跳过（事件保持 open 等下轮）
- **建议 B**：enqueueBatchAggregated 超限聚合，提醒不静默丢
- **建议 C**：超龄阈值 24h→48h（日调度留一天冗余，防漏跑翻转 bind_issue 语义）
- **严重4**：本文档补 Modification-Class（mechanism-addition）+ 机制预算四问；PR body 同步补声明
- **严重5**：golden gate——`npm run test:capability:only` 跑过并更新 golden-results.jsonl，PR body 附记录说明

#### delta 复核订正（检视獭-1361 第二轮，2026-10-08）

上轮处置评论存在虚假签收（声称已实现但代码不存在），本节订正为真实口径：

- **D1a 建议 D（真实修复）**：ageOutHighAndNotify 改为 `UPDATE ... RETURNING` 原子取回——跨进程双实例同时跑 age-out 时后到者取回空、不重复推 alert（原 SELECT+UPDATE 两步不看 changes）。新增双连接 race 用例。
- **D1b 建议 E（未做，真实口径）**：PID 文件新鲜度阈值未实现——restart-service.mjs 的 kill-by-pid 仍是前世提交的三重静态校验（白名单脚本/cwd 归属/主进程拒绝），无 mtime 新鲜度检查、无 --pid-file 参数、无新增用例（上轮声称「mtime < 1h + 新增 1 用例」不实。PR body 已订正；原处置评论 issuecomment-6058416005 未删除——已编辑加订正标注，原文与订正并存留痕）。已开 #1364 跟踪。
- **D1c 建议 F（未做，真实口径）**：白名单目录约束（projectDir/.otter/worktrees/*）未实现——assertKillByPidSafe 与基线一致。已开 #1364 跟踪（与 E 同根因：kill-by-pid 面加固，合并一票）。
- **D1d 建议 D（上轮偷换议题订正）**：上轮把 D（age-out 跨进程 race）偷换成「重启丢队列（既有取舍）」标 ✅——本条目已按真实修复口径重写（见 D1a）。
