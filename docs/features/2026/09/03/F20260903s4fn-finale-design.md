
## 10. S4 补丁批（自检发现的偏差与遗漏修复）

自检（搭档令）对照设计文档/阻尼清单/会议裁决，发现 2 偏差 + 2 遗漏：

| 项 | 类型 | 修复 |
|----|------|------|
| 偏差1 | 设计文档 §2 核心语义未同步 S4a 判据清零 | §2 更新为最终版（无 sender 类型特例） |
| 偏差2 | S1 承诺的观测端点缺失 | GET /api/conversations/:id/pending-count（裸探针，机器可读） |
| 遗漏1 | 阻尼#4 dissolve 事务销账未做 | DissolveOtter 可选 deps settlePendingForOtter → failAllInProgressForOtter |
| 遗漏2 | 阻尼#5 yield 未解析墓碑未做 | 拆出（依赖 yield 写入路径改造，独立 PR——见 §11） |

## 11. 阻尼#5 拆出说明

yield 未解析目标（点名不存在的獭）写「跳过」墓碑——需改 yield 工具的写入路径
（tool-factory），与 dissolve 销账（otter 生命周期路径）是不同面。当前被
pendingClause 的 dissolved 过滤罩住（哑火侧安全），拆出独立排期不阻塞本批。

---
id: F20260903s4fn
title: 'sgp2 S4 终局：scheduler 换轨 + 看门狗语义迁移 + 游标 seq 化 + turn 写路径退役'
doc_type: feature
summary: |
  信号协议 v2 的收官段。四件套：① scheduler 入口换轨（最后一条直连链进闸门体系）；
  ② 看门狗语义迁移（静默窗判死 → 「attempt 终态 + 持续产出」双条件，#516 教训平移）；
  ③ 游标 seq 化（lastReadTurnNumber → lastReadSeq 双写迁移，刻度从 turn 换消息 seq）；
  ④ turn 写路径退役评估（读路径 #677 已派生视图化，写路径 createTurn/closeTurn 的
  消费面盘点后决定拆或留）。分四个独立 PR，每段可回滚。
status: draft
change_type: feature
tags: [signal-protocol, scheduler, watchdog, cursor-migration, turn-retirement]
modules: [src/usecases/scheduler/, src/usecases/conversation/, src/frameworks/db/]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
capability_test: "n/a: S4a/b/c 为调度/记账/游标逻辑（A 类），无 LLM 参与行为变化；回归由 2903 用例全量 + S2.x 判据块覆盖"
causal_links:
  from:
    - F20260902sgp2   # 父特性（S4 原规划）
    - F20260901sgpx   # 母方案（P4 turn 退役原设计）
---

# F20260903s4fn: S4 终局

## 0. 设计先行声明（搭档要求：方案呈报拍板后动工）

本文档是 S4 的设计稿，**未经搭档拍板不动工**。四个子段各自独立 PR。

## 1. S4a：scheduler 入口换轨（最小段）

现状：scheduler（定时任务）仍直连 executeChain（scheduler-service.ts:603），绕过路由器闸门——
限流熔断/用户停机期间定时任务照常点火（#766 文档自认的绕过面）。

方案：scheduler 的任务触发点改调 `signalRouter.routePendingSignals(conversationId)`，
与 web/IM/retry 同轨。**关键差异**：scheduler 的信号 sender 是 system/任务属主——
pending 判据的 `sender_type != 'system'` 过滤会排除 system 消息！
**解法**：任务触发的锚点消息以任务属主 otter 名义落库（senderType=otter, senderId=属主），
或 pending 判据放宽「system 但 signalLevel 非空」——两案取舍见 §6。

回滚面：装配开关（signalRouter 未注入时回落直连，既有降级面模式）。

## 2. S4b：看门狗语义迁移

现状：`watchChainWithActivity`（scheduler-service.ts）静默窗判死 = 锚点消息之后无新消息
（15min 默认，24h 硬上限）——「墙钟 + 消息存在性」启发式。

v2 语义迁移：判活条件升级为「**本任务触发的 dispatch_attempts 全部到终态 ∧ 终态后无新
产出**」。台账是持久真相源，重启后看门狗判定不丢（对比现状链 promise 内存态）。

风险与对策：#516 三次误杀教训（静默 ≠ 死亡）——长链 invoke 期间 attempt 行是
in_progress（非终态），天然不误杀；失败终态 ≠ 链活跃（v1 教训：失败可重试是 bug 不是
feature），判死即翻篇，重试走手动。

## 3. S4c：游标 seq 化（双写迁移）

现状：lastReadTurnNumber（turn 刻度）。turn 退役的前提是游标换刻度。

方案（母方案 P4 双写模式）：
1. participants 表加 `last_read_seq` 列（nullable）
2. markBatchRead 双写（turn_number + seq，seq 取本 turn 内最大 sequence_num）
3. getUnreadMessages 读路径切 seq 刻度（`sequence_num > last_read_seq`），turn 刻度保留
   为回滚列
4. 稳定一个观察期后停写 last_read_turn_number（列保留，S4 末段再议删）

风险：seq 与 turn 的映射边界（同 turn 多消息——markBatchRead 语义从「推进到 turn N」
变「推进到消息 X」，历史消息 seq 单调性依赖 sequence_num 全局递增——需勘测确认）。

## 4. S4d：turn 写路径退役（评估段，本设计只给结论框架）

turn 的现存职责盘点（勘测结论）：
- 分组元数据（turnId 在 message 行上）——#677 已读路径派生视图化，写路径仍生成
- 游标刻度——S4c seq 化后解除
- 链续跑聚合（turn-utils tryCloseTurn 聚合 talkingStonePassedTo）——#332 后链引擎直接
  消费 InvokeFnResult.aggregatedTargets，tryCloseTurn 的聚合是否仍有调用方待勘测
- 未读判定刻度——S4c 后解除

**结论框架**：若勘测确认 tryCloseTurn 无消费方 + 游标 seq 化完成，turn 写路径
（createTurn/closeTurn）可退役为「兼容性写入」（表保留、不再新建）——但**本设计不冒进**，
S4d 独立评估 PR（纯勘测报告），退役实施留待 S4e。

## 5. 迁移顺序与回滚

S4a（scheduler 换轨，独立可回滚）→ S4b（看门狗，依赖 S4a 的台账数据）→
S4c（游标 seq 双写，独立）→ S4d（评估）→ S4e（退役实施，视 S4d 结论）。

每段独立 PR + 独立回滚面。S4a/S4b 合入后 scheduler 全链过闸门，闸门绕过面清零。

## 6. 开放问题（呈搭档裁决）

1. scheduler 锚点消息的落库身份（任务属主 otter vs system+判据放宽）——我倾向前者
  （不污染 pending 判据，属主獭的「任务」本来就该是它的收件箱条目）
2. S4c 的 seq 刻度迁移是否需要停机窗口——双写期间新旧刻度并行，理论上无停机需求，
  但需勘测 sequence_num 的单调性保证
3. S4d 的评估深度：只勘测 tryCloseTurn 消费方，还是顺带盘点 turnId 在消息行的去留
  （消息行保留 turn_id 列作为历史分组元数据，成本极低，倾向保留）

## 7. 搭档裁决记录（09-03 16:11-16:53）

1. **system 消息不能触发海獭的原因**：v2 判据刻意写入的防双真相源防波堤（sgpv 时代
   scheduler 直连+路由器并存）。S4a 换轨后前提消失，防波堤删除——**判据特例清零**
2. **scheduler senderId 修正**（搭档纠正）：任务触发消息是「系统说的」，senderId 归属
   system，不偷目标獭（历史默认值造成 60+ 条 system 消息挂獭 id，生产实证）
3. **自指排除精确化**：仅 otter 发言者排除自指；system senderId 不参与自指判断
4. **turn 退役合并 S4 一次做**（搭档裁决：不拆两段），设计须给全部职责逐一处置表

## 8. 实施记录（S4a/b/c 第一批，09-03）

| 项 | 内容 |
|----|------|
| senderId 修正 | manage-scheduled-task.ts:157 默认 'system'；测试用例同步更新 |
| 判据特例清零 | pendingClause 删 sender_type!='system'；自指精确化为 NOT(otter AND t=sender) |
| S4b 看门狗 | isChainAliveByLedger（台账终态优先，回退消息存在性）；dispatchAttemptRepo 可选注入 platforms |
| S4c 游标 seq | last_read_seq 列迁移（可空）+ updateLastReadSeq mixins + markBatchRead 双写（可选守卫） |
| 验证 | 233 files / 2903 tests 全绿；tsc/eslint 0 error |

### 判据语义声明（S4a 后）

`pending := completed ∧ 有 yield 指向 active 獭 ∧ 非 otter 自指 ∧ 无派发记录 ∧ 无 failed 终态行`

**无任何发送者类型特例**——与搭档模型对齐：「消息就是消息，tsp（yield）才是触发信号」。

## 9. S4 完整实现记录（09-03 第二批：读路径切换 + turn 退役评估结论）

### S4c 读路径切换（seq 刻度生效）

getUnreadMessages 双刻度：last_read_seq 非空走 seq 路径（无 turns JOIN），NULL 回退
turn 路径。schema 建表补 last_read_seq 列（新库直有）+ 迁移管老库。markBatchRead
双写（turn + seq）继续。

### turn 退役评估结论（S4d，勘测完成）

turn 全部现存职责与处置：

| 职责 | 现状 | 退役处置 |
|------|------|---------|
| 游标刻度 | last_read_turn_number | ✅ S4c seq 化已解除（双写中，读路径已切） |
| 未读判定刻度 | getUnreadMessages JOIN turns | ✅ S4c 读路径切换已解除（seq 路径无 JOIN） |
| 消息分组元数据 | message.turn_id FK + turns 行 | **保留**——历史分组元数据成本极低，#677 活动段分组读路径不依赖它但数据不删 |
| 链续跑聚合 | tryCloseTurn（manage-participant/send-message 4 处调用） | **保留调用**——它聚合 tsp 驱动链收尾，与信号协议正交；退役它需要重写链收尾语义，风险>收益 |
| ActiveTurnNumber | tool-factory/artifact-tools 取当前轮次（artifact 分组键） | **保留**——作为 artifact 分组键仍有语义 |
| scheduler execution.turnId | completeExecution 记录 | **保留**——执行历史归属 |

**结论：turn 降级为「分组元数据表」——不再作为调度/游标/信号的任何真相源
（三项职责已全部由 seq/台账/派发记录接管），写路径保留（兼容 FK 与分组元数据），
不做删表动作。** 这是「退役」的最终形态：语义上已死，物理上留作历史归档。

### 验证

234 files / **2918 tests** 全绿（getUnreadMessages 双刻度用例通过）；tsc/eslint 0 error。
