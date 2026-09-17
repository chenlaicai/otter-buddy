---
id: F20260917rscr
title: 删除信号补扫机制：恢复只认中断队列（9/17 重启风暴根解）
doc_type: feature

summary: |
  删除 SignalRouter.rescanPending 与 ResumeInterruptedService 的补扫调用——
  9/17 重启风暴（生产实证：单次重启 682 条 invoke 爆发 / 656 failed，36 会话、
  单会话同獭被点 49 次）根因即补扫：「无 consumed 标记 = 未处理」的判据在
  invoked 路径（主流）不成立，全部历史消息被误判重放。搭档裁决（修法排序③
  deletion）：「一直在反对加兜底机制，从没要求过补扫」——防的幽灵场景
  （entry 落库后点火前进程死亡）概率极低且用户可重发，机制维护成本倒挂。
  同批三点机制修正（搭档 9/17 逐条裁决）：① 定时任务中断同样入队恢复
  （中断本质相同，「防重复」由③统一覆盖）；② 同会话多 running 并行恢复
  （串行是 messages 时代防 seq 竞态的遗留）；③ 跳过判据从「3 秒新 user
  消息」换成「獭已恢复」（中断后该獭已有新 invoke 即跳过——聚焦本质）。

causal_links:
  from:
    - F20260916b1ea   # 重启自动恢复重建（引入补扫回归，本档删除之）
    - F20260901sgpv   # 信号协议 P1（补扫的原始出处，「崩溃窗口兜底」论证）
  supersedes: []

tags: [conversation, signal-router, resume, deletion, incident]
modules: [src/usecases/conversation/signal-router.ts, src/usecases/conversation/resume-interrupted-service.ts, src/app.ts]
created_in_conversation: 2964fa59-1b25-45c4-9b0c-23afdb952969
---

# F20260917rscr 删除信号补扫机制

## 问题现象（生产实证，2026-09-17 08:37 CST 重启）

- 重启后 36 个会话的海獭被同时唤醒，单会话同獭被连续点燃 49 次
- 生产库只读实证：682 条 invoke 在就绪后 3 秒（RESUME_DELAY_MS）起爆发，656 条 failed，大量 Lock acquire timeout
- 日志铁证：每条假任务的消息体 =「当前时间 08:19 + 当前任务 [user] 已合入」——9/13 以来的历史 user 消息被重新包装重放

## 根因：补扫机制本身（不是实现缺陷）

`SignalRouter.rescanPending`（F20260901sgpv 引入，F20260916b1ea 移植回归）的点火判据：
「yieldTargets 非空 + metadata 无 signalMeta.consumed + createdAt 早于启动时刻」。

**「无 consumed = 未处理」不成立**：routeTriggerMessage 只对 followed_up/steered
打 consumed 销账，invoked 路径（目标空闲时的新 invoke 点火——历史消息的绝大多数）
从不销账。于是几乎全部历史 user 消息被判为「未处理」，每次重启全量重放。

### 为什么删除而不是修

搭档裁决原话：「我一直在反对你各种加兜底机制！那为什么要补扫呢？我从没要求过
补扫啊，这才是根因」。

修法排序四问：

1. **在既有机制语义内修（补 invoked 销账 / invoke 存在性判据）**——PR #1011 走过
   这条路（已 close）：能止血，但保留了「每次重启扫描历史消息」这个动作本身，
   判据完备性依赖销账纪律的长期正确——这正是 9/9 三回复、9/17 风暴两次事故的
   共同温床。
2. **收窄管辖（窗口 2 分钟）**——同样保留扫描动作，窗口内仍有点火判据风险。
3. **删除机制，接受原始问题回归**——原始问题：「entry 落库后、点火前进程死亡 →
   该消息永远无人理」。发生概率：落库到点火是同进程内连续动作，窗口毫秒级；
   后果：一条消息没回复，用户看到没人理自然重发，成本一条消息。**防幽灵场景
   换来每次重启的系统性放火风险——维护成本完全倒挂**。
4. 新增机制——无需论证，①②③ 中 ③ 成立。

走 ③。机制识别检查点：纯删除，无净新增（无新配置/状态/表/分支/调用路径）。

## 删除清单

| 删除物 | 位置 | 说明 |
|---|---|---|
| `SignalRouter.rescanPending` | signal-router.ts | 补扫入口（公开方法，唯一消费方 = 恢复服务） |
| `ResumeInterruptedService.rescanSignals` + resume() 中的调用 | resume-interrupted-service.ts | 补扫编排（中断队列会话 ∪ 活动会话逐会话扫） |
| deps.signalRouter / deps.serviceStartedAt | resume-interrupted-service.ts / app.ts | 补扫专用依赖与启动时刻界定参数 |
| `ResumePendingRepository.listRecentConversationIds` + sqlite 实现 | resume-pending-repository.ts / sqlite-resume-pending-repository.ts | 补扫会话范围数据源（唯一消费方已删） |
| 测试：补扫 stub + 「信号补扫」用例 | resume-interrupted-service.test.ts | 随机制删除 |

**保留不动**：restart_pending_resumes 队列表、原子 claim、attempts 上限、
429 退避、终态守卫、healing 落账——恢复「被系统停止打断的 invoke」的主路径
今天实证正确（08:37 重启时 1 条真中断 invoke 被正确恢复）。

## 同批三点机制修正（搭档 9/17 逐条裁决）

风暴复盘时搭档逐条审问了恢复机制现状，三条裁决同批落地：

### ① 定时任务中断同样入队恢复

旧逻辑：`reconcileRunningInvokes` 排除 trigger_entry_id 为 NULL 或指向 system entry
的 invoke（怕 scheduler 任务重复产出）。搭档指出：定时任务中断和用户消息中断本质
相同——都是意外中断的工作该被续上；「防重复」由判据③统一覆盖（cron 重触发后
该獭已有新 invoke，恢复自然跳过）。改为：所有 running invoke 被标 failed 后一律
入队，不再按来源排除。

### ② 同会话多 running 并行恢复

旧逻辑：跨会话并行、同会话串行（messages 时代防 seq 竞态的遗留）。生产实证同会话
同秒不同獭并发 running 真实存在（中断前就是并发）；createEntryAtomic 原子序号后
并发写不撞号，串行理由失效。串行的实际代价：一只 429 退避堵住同会话其余恢复。
改为：全部队列项并行恢复。

### ③ 跳过判据：「3 秒新 user 消息」→「獭已恢复」

旧逻辑：恢复前查该会话 3 秒内有无新 user entry（猜测用户是否已接上）。搭档指出
本质：恢复的目的是让意外中断的 running invoke 重新跑起来——**中断时刻之后该獭
已有新 invoke（无论来源）即说明已被接上，系统不该再碰**。与用户是否发消息无关。
实现：`getLatestInvokeByOtter(conversationId, otterId, interruptedAt)` 查中断时刻
（队列行 created_at）后的最新 invoke，存在即 exhausted 静默跳过（不发「请手动
重试」——獭已在跑，恢复目的已达成）。

## 影响范围

- 恢复机制语义收敛为单一判据：队列表里有 pending 就恢复，没有就不动。
  「扫描历史」动作不再存在。
- 接受回归：entry 落库后点火前进程死亡的极端场景（毫秒级窗口），该条消息
  无人理——用户重发即可。
- signal-router 的事件驱动路由（routeSignals/routeTriggerMessage/routeDirectSignal）
  不受影响——销账逻辑（followed_up/steered 打 consumed）保留，防重燃仍有效。
- 定时任务中断恢复：cron 周期内被杀死的任务会被续跑一次；若 cron 到点已重触发，
  判据③ 跳过（不重复产出）。

## 验证

- `npx tsc --noEmit`：0 错
- `npx vitest run`：全绿（263 文件 / 3187 用例；补扫用例删除，新增三点裁决用例：
  ① scheduler 来源 NULL/system trigger 同样入队 ×2 ③ 獭已恢复跳过静默 + 未恢复
  正常触发 ×2）
- `npm run build`（含 eslint）：0 error；`npm run lint:intent` 通过
- 下次重启预期：就绪后 3 秒只有队列恢复动作（0~n 条中断 invoke），不再有
  点火爆发；定时任务中断也会被续跑

## 教训（入记忆）

「崩溃窗口兜底」类机制的共同陷阱：防的场景概率极低且用户可自愈，机制本身的
判定逻辑（什么是"未处理"）却要在每次重启时对全量历史做正确性断言——判定
依据（销账标记）的写入纪律一旦在某条路径缺失，兜底就变成放火。搭档 9/17
裁决确立原则：**不为幽灵场景加兜底；真有漏的，人会发现，人会重发**。
