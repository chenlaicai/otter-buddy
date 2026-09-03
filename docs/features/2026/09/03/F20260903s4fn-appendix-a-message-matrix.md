# 信号协议 v2 消息机制全景（S4 合并设计前置分析）

> F20260903s4fn 附录 A。目的：把「人、海獭、系统」三类主体在所有对话场景下的
> 消息产生/流转/触发关系画清楚，暴露特例与缺漏。搭档补充后并入 S4 合并设计。

## 一、消息的三种发送者（数据模型事实）

| senderType | 谁在用 | 产生场景（穷举勘测） | 带 talkingStonePassedTo？ | 进 pending 判据？ |
|-----------|--------|---------------------|--------------------------|------------------|
| **user** | 人（web/飞书/微信） | 用户发言；web retry 链的 senderId=user | 是（点选目标） | ✅ |
| **otter** | 海獭 | 獭的 speak 落库；resume 续跑；scheduler（属主獭 senderId） | 是（yield 传递） | ✅ |
| **system** | 系统设施 | ① scheduler 任务触发消息（**带 tsp→属主獭**，senderId=task.senderId）② 招聘桥接批次（**带 tsp→大獭**）③ 獭进场/退场通知（无 tsp）④ 服务重启恢复通知（sendSystem，无 tsp）⑤ 深度超限警告（无 tsp） | ①②带；③④⑤不带 | ❌ 被排除 |

**关键事实（勘测实证）**：system 消息**分两类**——「带行动指令的」（scheduler 任务①、
招聘批次②：有 tsp、需要獭行动）和「纯通知的」（③④⑤：无 tsp，仅告知）。v2 判据的
`sender_type != 'system'` 把两类一起排除了——**通知类排除是正确的**（没人需要对「服务
已恢复」采取行动），**行动类排除是 S4a 的堵点**（scheduler 任务必须行动却进不了判据）。

## 二、各对话场景时序（v2 现状，✅=已换轨 ⚠️=直连绕过）

### 场景 1：用户 → 獭（web）
```
人 ──发言──▶ messages(user, tsp=[獭]) ──落库──▶ [✅S2] routePendingSignals
    ──▶ 闸门(停机?熔断?) ──▶ pending(台账反连接) ──▶ invokeTarget(记账+点火)
    ──▶ executeChain ──▶ 獭 invoke ──▶ 獭 speak(otter, tsp=[...]) ──▶ markBatchRead
    ──▶ yield 给 user? ──▶ 链结束 ; yield 给獭? ──▶ 下一 hop（同链续跑）
```
用户可见：SSE 流（K3：attempt 全终态才关流）；轨迹徽标；GateBanner。

### 场景 2：用户 → 獭（飞书/微信 IM）
```
IM 消息 ──▶ 落库(user) ──▶ [✅S2] AgentDispatchService ──▶ routePendingSignals（同上）
```

### 场景 3：用户手动 retry
```
人 ──点重试──▶ [✅S3] retrySignal ──▶ 闸门 ──▶ invokeTarget(source='retry', 记账覆盖)
    ──▶ executeChain ──▶ ...
```

### 场景 4：定时任务（scheduler）⚠️ 直连绕闸门
```
cron tick ──▶ createSystemMessage(system, tsp=[属主獭]) ──▶ 落库
    ──▶ [⚠️直连] executeChain（不经路由器/闸门/pending）──▶ 链跑 ──▶ markBatchRead
    ──▶ watchChainWithActivity 静默窗看门狗（内存 promise）
```
**缺漏**：熔断/停机期间定时任务照常点火（#766 自认绕过面）；任务消息在台账无账
（createSystemMessage 不记账）→ 消息表有「系统点名獭」的行但台账视角不存在。

### 场景 5：招聘桥接（BOSS 直聘）⚠️ 同 scheduler 直连
```
外部 webhook ──▶ system 消息(tsp=[大獭]) 落库 ──▶ [⚠️直连] triggerDispatch ──▶ executeChain
```
**注意**：招聘消息与 scheduler 同构（system + tsp + 直连点火），S4a 必须一并处理，
否则堵了 scheduler 漏了招聘。

### 场景 6：崩溃恢复（resume）
```
进程重启 ──▶ failInFlightMessages（僵尸转终态）──▶ 死亡证明（attempt in_progress→failed）
    ──▶ routeAllPending（补扫点火所有合法 pending）──▶ getPendingResumes
    ──▶ 恢复链（prepareForRetry + executeChain + buildRestartResumeMsg 注入）
    ──▶ sendSystem("服务重启导致 N 条发言中断…")（纯通知，无 tsp）
```

### 场景 7：獭 → 獭（链内交棒）
```
獭 A invoke ──▶ A speak(yield 獭 B) ──▶ aggregatedTargets=[B] ──▶ 同链下一 hop
    ──▶ B invoke（hop-1 记账触发消息 = A 的产出消息）
```
B 的 speak 再 yield —— 链继续；yield user —— 链结束。

### 场景 8：獭 → 獭（跨链，B 正忙）
```
A speak(yield B) 而 B 正在别的链 invoke ──▶ routeTarget → queued_busy
    ──▶ busyQueue（内存，内容快照）──▶ B 链完成 → debounce → drain → B invoke 快照内容
```

## 三、信号/pending/记账 的关系总表

| 概念 | 真相源 | 生命周期 | 产生场景 | 消费场景 |
|------|--------|---------|---------|---------|
| **信号（信号消息）** | messages 行（tsp 非空） | 消息落库即存在 | 人/獭/system(①②) 发言点名 | 被判据扫描 |
| **pending** | dispatch_attempts 反连接（推导，非存储） | 无 attempt 行期间 | 消息落库+点名时隐式产生 | 路由器扫描→点火 |
| **attempt（派发尝试）** | dispatch_attempts 行 | 点火起跑(in_progress)→settle(终态) | invokeTarget 预写（router/retry）+ 链 hop 记账（chain） | 阻尼/幂等/排查 |
| **闸门状态** | userHalted（内存）+ healing 事件（持久推导） | 置位→解除/窗口过期 | 用户中断/429 事件 | routeTarget 前置拦截 |

## 四、暴露的设计缺漏（搭档补充前我的清单）

**D1【system 双分类未建模】**：系统消息的「行动类」（scheduler/招聘）与「通知类」
（进场/恢复/警告）在数据模型上无区分字段——判据只能一刀切排除。方案乙
（signalLevel IS NOT NULL 判据放宽）实际上是用 signalLevel 当「行动类」的标记位——
但招聘消息目前不写 signalLevel！需要补：S4a 落地时 scheduler/招聘的触发消息统一写
signalLevel（默认 NORMAL），或加显式 `actionable` 标记。

**D2【直连链点火不记账的存量面】**：scheduler/招聘直连链跑链时**有记账**
（executeChain triggerMessageId 已插桩，S1 起生效）——但闸门绕过仍在。换轨后此面消失。

**D3【resume 恢复链的双记账窗口】**：resume 的恢复链 executeChain 带
triggerMessageId=item.messageId（被恢复的半截消息）——被恢复消息本身的 attempt 若在
崩溃前已 in_progress（死亡证明标 failed），恢复 retry 记账覆盖为 in_progress——语义
正确（恢复=新尝试）。但「恢复触发消息」与「原始信号消息」是两条消息，原始信号的
pending 在死亡证明后已清——**无循环风险**，此为正确行为，需测试锁定。

**D4【纯通知消息无一致性约束】**：sendSystem（无 tsp）可以带 tsp 而不改任何行为——
数据模型允许「system 带 tsp 但谁也不处理」的行存在（目前仅 scheduler/招聘在用，
但无约束防止第三种用法）。

**D5【busyQueue 无账的跨重启窗口】**：排队信号不写账（对撞裁决），进程重启后
busyQueue 丢 + 信号回 pending → 补扫会重新点火——语义自洽（排队即未派发），
但用户视角「我发的插话在重启后獭『重新处理一遍』」，需在 K 系列告知面覆盖。

## 五、S4 合并设计的主张（待搭档补充后定稿）

1. **行动类 system 消息统一标记**：scheduler/招聘触发消息写 `signalLevel='NORMAL'`
  （显式 actionable 标记），pending 判据的 system 排除改为
  `sender_type != 'system' OR signal_level IS NOT NULL`——通知类仍排除，行动类进闸门
2. **S4a 换轨面 = scheduler + 招聘**（同构处理，一次堵完）
3. **看门狗迁台账**（S4b）：判活 = 任务锚点的 attempt 全终态 ∧ 锚点后无新消息
4. **游标 seq 化 + turn 退役合并**（S4c/d/e 一次设计，分段实施）：
   turn 职责处置表逐一给去向，无去向的职责不允许退役
