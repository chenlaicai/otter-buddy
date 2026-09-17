---
id: F20260917trig
title: RHI 信号处置状态机：triage 队列 + issue 绑定 + 老化升级 + 处置进度面板
summary: |
  治本改造（搭档 2026-09-17 拍板「直接开始治本」）：RHI 信号从「传感器阵列（只报没人接）」
  升级为「处置队列（每条有主、有进度、有生命周期）」。核心：signals 表加处置状态机
  （open→triaged→in_progress→auto-resolved；dismiss 獭可执行但 note 必填必写库）、信号↔issue 结构化绑定、
  老化 worker（超龄自动落 healing 告警，学 signal-aging-worker 现成模式）、
  面板「警报」页变处置队列视图。
change_type: feature
capability_test: "n/a: 方案阶段（审视通过后进入实现，测试设计随实现 PR 交付）"
intent:
  problem: "40 条 critical bug_recurrence 信号最老的挂了 23 天无人处置（#1012 实锤）；搭档反馈「面板是给我看的不是让我干活的，信号应该有自动化处理流程和生命周期」"
  expected_effect: "每条 critical 信号可见处置状态（谁接了/卡了几天/对应哪个 issue）；超龄未处置自动升级可见；面板上不再出现「建议你去看」而是「处置进度」"
  verify_by:
    type: metric
    effect_window: 14d
    metrics: "①面板未接单 critical 数（基线 40 → 目标 0）；②aging worker 首月落账数（观察值，用于校准 72h/7d 阈值）；③dismissed 无 note 行数（目标恒 0）"
created: 2026-09-17
created_in_conversation: a4d1f7c1-76b1-4cdd-8040-469d3c1b974b
tags: [rhi, signal-lifecycle, triage, health-dashboard, automation]
modules: [health/signal-repository, health/signal-pipeline, health/detect-signals, signal/signal-aging-worker, web/pages/health]
---

## 背景

搭档原话（意图锚，2026-09-17 本对话）：

> 「这个ui是给我看的，不是让我干活的，比如说 警报这种 难道没有自动化流程来处理吗，咋还是"建议我今天看"，在定时任务中，不应该有每日处理吗，这些警告信号是否进去处理队列中、以及，这些信号产生了，那后续是否有更新、是否生命周期呢」

> 「直接开始治本」

现状审计（本对话已查实，锚点可回溯）：

- **处置断档**：signals 表 40 条 critical bug_recurrence，最老 first_seen=2026-08-25（23 天），已全部聚入 issue #1012 但 issue 仍 open——「报警→日报看见→开 issue」之后无人执行
- **唤醒桥未接**：signal-pipeline.ts 留了 `CriticalSignalWakeup` 端口（「由调用方注入 create_scheduled_task 桥」），app.ts:141 装配处注入为空——设计意图的自动唤醒从未接线
- **无老化机制**：獭间信号（signal_events）有 SignalAgingWorker 扫 24h 悬置自动落 healing（F20260915hlife），RHI 信号（signals 表）无任何老化/升级机制——挂 23 天系统不觉得疼
- **已有闭环段在空转**：daily-health-check prompt 的「RHI 信号处置段」（#406/F20260904rclp）要求逐条三选一处置，但该特性文档已预言：「两周后决策点……仍空转 → prompt 硬规则也不够，需要上机制」——现在就是那个决策点，数据证明空转
- **同源重复报警**：bugfix 占比高这一件事，在系统里同时表现为 D1 低分 + 40 条 critical + 55 条 post_merge_fix_density warning——观测器口径问题是 #1012 的范围，本方案只管处置管道，不改检测口径（边界声明见非目标）

## 目标

T1: **处置状态机**——每条信号有明确处置状态与负责人字段：open（未接单）→ triaged（已归口：绑定 issue 或明确不处置）→ in_progress（修复中，issue 有在途 PR/worktree）→ resolved/dismissed 终态
T2: **老化升级**——critical 超 72h / warning 超 7d 未 triaged，自动落 healing event（severity=medium）进自愈台账，系统自己喊疼
T3: **处置进度面板**——「警报」页从「信号列表 + 建议你去看」改为「处置队列」：每条显示状态、挂了几天、绑定的 issue、建议动作变成可执行入口（一键开 issue / 绑定已有 issue）
T4: **存量出清路径**——本方案合入时，40 条存量 critical 按 #1012 口径分析结果批量处置（downgrade/resolve/绑定），面板 critical 回到个位数

## 非目标

- **不改信号检测口径**（bug_recurrence ≥3 次阈值、归一化、同根因识别等）——那是 #1012 的范围，本方案只管「信号产生之后的处置管道」。两者解耦：口径修好减少误报，处置管道保证真报有人接
- **不接 CriticalSignalWakeup 唤醒桥**——critical 产生即自动唤醒獭处置是更激进的自动化，先把「处置状态可见 + 超龄升级」跑稳，唤醒桥作为后续演进（退役条件见设计取舍④）
- **不动獭间信号（signal_events）协议**——它已有自己的老化与裁决机制（F20260915hlife），本方案只处理 RHI 健康信号（signals 表）
- **不做信号-动作自动映射表**（#406 原方案的完整工程）——处置决策仍需獭/人判断，本方案只保证「判断结果结构化留痕、进度可见、超龄报警」

## 方案设计

### 1. 数据模型：signals 表加处置字段（schema 迁移）

```sql
ALTER TABLE signals ADD COLUMN triage_status TEXT DEFAULT NULL;
  -- NULL/'open' = 未接单；'triaged' = 已归口；'in_progress' = 修复中
  -- 终态仍走既有 status（resolved/dismissed），triage_status 只管 open 期内的处置进度
ALTER TABLE signals ADD COLUMN issue_number INTEGER DEFAULT NULL;
  -- 绑定的 GitHub issue 编号（处置锚点）
ALTER TABLE signals ADD COLUMN triaged_at TEXT DEFAULT NULL;
  -- 归口时间（老化计时起点之一）
ALTER TABLE signals ADD COLUMN triage_note TEXT DEFAULT NULL;
  -- 处置说明（如「并入 #1012」「误报，阈值问题见 #1012」）
```

**消费方声明**（issue #379 ⑥ 纪律）：
- `triage_status/issue_number/triaged_at` 消费方 = 面板处置队列视图（RhiController 新端点数据组装）+ 老化 worker（计时判断）
- `triage_note` 消费方 = 面板每条信号的处置说明展示 + 日报处置段对账

复用既有 `status` 字段做终态，不新建独立状态机表——处置进度是 open 期内的子状态，与终态正交。

**写入边界（防御声明）**：triage 四字段**只能由 `SignalRepository.triage()` 方法写入**，检测引擎的 upsert/INSERT 路径永不触碰它们——upsert 的 UPDATE 分支（signal-repository.ts 既有的 COALESCE 防御模式）不包含新字段，窗口滑动重算不会覆盖处置进度。INSERT 新行时 triage 字段取默认值 NULL（复发新行语义见 §3 末）。

### 2. 处置写入路径：新增 agent 工具 `triage_signal`

在 signal-tools.ts（现为獭间信号工具文件）或新建 health 域工具文件中实现（实现期定，倾向放 health 域保持语义池分离）：

```
triage_signal(signalId, action, issueNumber?, note?)
```

**action → 状态映射与幂等语义**（实现契约，检视修订补入）：

| action | 状态迁移 | 参数约束 | 幂等语义 |
|---|---|---|---|
| `bind_issue` | triage_status='triaged', issue_number=N, triaged_at=now | issueNumber **必填** | 覆盖式更新（允许换绑 issue，note 随调更新） |
| `in_progress` | triage_status='in_progress' | 前置：须已 bind_issue | 幂等跳过（已 in_progress 重复调无副作用） |
| `dismiss` | status='dismissed', triage_note=note（终态后 note 仍写库） | note **必填必写库** | 幂等跳过（已终态重复调无副作用） |

**dismiss 权限语义（S2 修订）**：獭可调用 dismiss，但 note 必填且必写库——「不处置必须是判断结论不能是沉默」（daily-health-check.md:35 既有原则）由 note 必填机制承载，不靠工具层权限拦截（拦截会逼日报獭把合法「不处置」塞进 bind_issue 假绑定）。兜底：aging worker 扩展扫描「dismissed 且 triage_note 为空」的异常行（防御实现疏漏）。

**架构约束（F3）**：triage 写入逻辑封装为 `SignalRepository.triage()` 单一方法，agent 工具与 HTTP 端点均调用此方法，任何入口不得各自实现 SQL。

配套查询工具 `list_rhi_signals(status, severity, triageStatus)`——让处置者（日报獭/搭档/被派工小獭）能拉「未接单清单」。

**谁在调**：daily-health-check 的处置段从「逐条三选一（开 issue/并入/不处置）」升级为「处置后必须调 triage_signal 留痕」——处置动作从此在系统里留结构化记录。

**对账口径（R4 修订）**：
- in_progress 是 bind_issue 的后续状态迁移，**对账只统计首动作**（bind_issue/dismiss 各计一次，in_progress 不进公式）
- 日报公式扩展为 **M+K+L+D=N**：M=开新 issue、K=并入既有（bind_issue 区分两者以 issue 是否新建为准）、L=不处置留 note（獭 judge 但暂不 dismiss 的过渡态）、D=dismissed（必须附 note）
- 存量出清完成后，日报 N=**当日新增** critical（已归口存量显示在「已归口」组，不再进对账）

### 3. 老化 worker：RhiSignalAgingWorker

学 SignalAgingWorker 的现成模式（F20260915hlife），独立 app 级 setInterval：

- 扫描：signals 表 status='open' AND triage_status IS NULL（未接单）
- 阈值：critical 超 72h / warning 超 7d（从 first_seen 计；已 triaged 的不扫——已接单的事项进度由 issue/PR 生命周期自己管）
- 动作：落 healing event（errorType=other, severity=medium, context 带 signalId+挂了多久），同一 signalId 去重（查 open healing 的 context）
- 为什么 medium 不是 high：处置延迟是流程问题不是系统故障（与 SignalAgingWorker 同口径）

**告警聚合限流（S4 修订）**：RHI 信号量级是獭间信号的几十倍，逐条落账会形成告警风暴（存量场景一次 40 条同根因告警 = 呻吟轰炸）。聚合规则：**同 signal_type 一轮扫描最多落 1 条聚合 healing**（如「bug_recurrence 40 条超龄未接单，最老挂 23 天」，context 带 signalId 列表），不逐条落。獭间 SignalAgingWorker 不做聚合是因为其信号量小——量级差异显式处理。

**孤儿 healing 清理（S3 修订）**：信号终态化（resolved/dismissed）时，同步自动 resolve 其对应的 aging healing（context.signalId 匹配则 resolve，resolutionNotes='信号已终态，告警自动销号'）——避免指向已不存在问题的告警挂在自愈台账成为噪音债。

**上线编排（S4 修订）**：实现期严格按序执行——① schema 迁移 → ② 存量批量 triage 出清（§5，大獭一次性操作）→ ③ aging worker 上线。出清在 worker 之前，避免首轮扫描对存量触发风暴。

**已知缺口（显式接受的风险，S3 处置）**：worker 只扫「未接单」，**「已 triage 但绑定 issue 长期停滞」暂不扫描**——这正是本次事故（#1012 挂 23 天）的同构失败模式，此处显式声明接受而非遗忘。二期触发条件：**orphan triage（绑定 issue 已关闭但信号仍 open）或 triaged 超 14d 的信号数量 ≥5 时启动二期建设**（issue 活动扫描需引入 GitHub API 轮询，机制膨胀不放入一期）。

**新增决策分支说明**：老化落 healing 后被 resolve 的信号若仍 open，下一轮间隔 ≥24h 会再落一条（与 SignalAgingWorker 同语义——持续悬置本就该持续可见）。

**复发语义声明（R2）**：信号 resolve 后同文件 bug 复发 → upsert 匹配不到 open 行 → INSERT 新行，first_seen 归零、issue_number/triage_note 不继承——**复发视为新事件走完整未接单流程**。语义正当性：修好了又复发确实是新事件；但面板上「open 3 天」会比实际年轻，此口径在此钉死避免日后困惑。

### 4. 面板：「警报」页变处置队列

RhiController 的 signals 端点返回数据组装时带上 triage 字段；前端分组从「按 severity」改为「按处置状态」：

- **未接单**（triage_status IS NULL）置顶，按挂了几天降序，每条显示「open N 天」——N 越红越醒目
- **已归口**折叠为一组，显示绑定 issue 链接与 triage_note
- **修复中**显示 issue + 在途 PR 状态
- 每条的操作按钮从「详情」变为「开 issue 处置 / 绑定已有 issue / 忽略（附理由）」——写路径经新后端端点 `POST /api/health/signals/:id/triage`（与 agent 工具共享 `SignalRepository.triage()` 单一方法）

**http 端点身份约束（R3）**：面板服务为本机信任域（与既有 POST /api/health/scan 先例同口径），不引入鉴权机制；dismiss 动作的「附理由」约束由 repo 层 note 必填承载（与獭入口同一语义，无双标）

### 5. 存量出清（T4 交付路径）

**执行主体（R5）**：大獭在本 PR 合入后一次性执行批量 triage（脚本/工具调用），note 统一注明「存量出清批量操作 F20260917trig」——执行记录可回溯。

**数字口径澄清（R1）**：#1012 标题「44 条 critical」为 9/17 09:00 健康检查拉取的生产库当时值；本方案背景「40 条」为 9/16 备份库快照值（critical 全为 bug_recurrence）。差 4 条为 9/16→9/17 新增或库间差异，非矛盾——以执行出清时的生产库实时数为准。

步骤（写进验证段）：
1. 按 #1012 第一步做 5 条高频 critical 的根因复盘（同根因 vs 不同 bug）
2. **复盘结论适用范围声明（R1）**：若结论为「阈值口径过松」（大概率，#1012 已有佐证），批量 triage 适用于全部存量；若结论为「真腐烂」，剩余条目**逐条过一遍再归口**，不一键并入
3. 批量 triage：全部存量 critical → triage_status='triaged', issue_number=1012——面板从「40 条未接单」变「40 条已归口同一 issue」，数字诚实（已归口≠已解决，#1012 修好口径后检测熄火、auto-resolve 按 §6 语义自然清场）
4. 日报处置段 prompt 同步更新（调 triage_signal 留痕的硬规则 + M+K+L+D=N 口径）

### 6. 与 auto-resolve 的交互语义（S1 修订——机制间防拆解）

既有 `resolveStaleSignals`（signal-pipeline.ts:135-146）每轮扫描把「本轮未再检测到的 open 信号」全量 auto-resolve，**不区分 triage 状态**。若不协调，triaged/in_progress 信号会因窗口滑动或真实修复被自动销号，而 triage 字段残留——面板出现「已 resolved 信号挂着 closed issue 链接」的幽灵行，「卡了几天」计数中断，处置队列失真。**机制间相互拆解是新机制最大的风险，故单列一节钉死语义**。

**决策（选项 b）**：auto-resolve 时**同步抹平 triage 字段**（triage_status=NULL, issue_number=NULL, triage_note 保留作历史痕迹）。理由：

1. 与方案自身原则自洽——「处置进度是 open 期内的子状态」，终态发生后进度无意义，终态覆盖进度
2. 改动面最小——只在 resolveStaleSignals 的 UPDATE 里加三个字段置 NULL，不改比对逻辑
3. 存量清场路径自动化——40 条并入 #1012 后，#1012 口径修复合入 → 检测自然熄火 → auto-resolve 连状态带进度一次抹平 → 面板回到干净「已解决」，无需人工再清 40 条

signal-pipeline.ts 因此进入改动范围表。

## 影响范围

- signals 表 schema 迁移（4 个新字段，全部 nullable/默认值——存量行为零变化）
- signal-pipeline.ts resolveStaleSignals：auto-resolve 同步抹平 triage 字段（§6）
- SignalRecord 接口扩展 4 字段 + repo 新增 triage()/findByTriageStatus() 方法（改动范围表已列）
- 面板 signals 端点返回结构扩展（新增字段，前端旧版忽略新字段不炸）
- daily-health-check prompt 更新（处置段改机制对账口径 M+K+L+D=N）
- 新增 worker（app.ts 装配，与 SignalAgingWorker 并列）+ 孤儿 healing 清理钩子（信号终态化时）
- 新增 2 个 agent 工具（tool-factory.ts 注册）+ 1 个 http 端点

## 风险与约束

- **迁移风险**：ALTER TABLE 加列对 SQLite 安全（既有迁移框架已多次执行同型操作）
- **双状态字段语义混淆风险**（status vs triage_status）：通过「终态归 status、进度归 triage_status」的正交划分 + 文档注释消解；UI 只暴露组合后的单一展示态
- **老化阈值拍脑袋风险**：72h/7d 是初始值，写在常量里可调；观察期后按实际处置速度校准（D5 权重校准有同样先例，issue #595 后续项）
- **告警风暴风险（S4 已处置）**：聚合限流 + 出清先于 worker 上线的编排顺序双重防线
- **机制间拆解风险（S1 已处置）**：auto-resolve 抹平语义见 §6；实现 PR 必须有「triaged 信号被 auto-resolve 后 triage 字段已抹平」的回归测试

## 不兼容更新

无。新字段全部 nullable/有默认值；既有消费方（面板 severity 分组、D5 计数、日报处置段）读取路径不变。

## 设计取舍

**机制识别检查点**：命中 4 项——新增持久化字段 / 新增决策分支（triage 写入被记住并影响后续面板与老化行为）/ 新增后台进程（aging worker）/ 新增跨模块调用（triage 工具 → signals repo）。**机制预算四问**：

① **谁需要它**——搭档（面板从「要我看」变「给我看进度」）、daily-health-check 獭（处置留痕有工具可调用，M+K+L=N 对账从自觉变机制）、被派工的小獭（list_rhi_signals 拉未接单清单作为派工输入）
② **失败后果**——triage 字段写坏了：面板处置状态显示错误（用户可感知，但 signals 本体数据无损，重算可修）；aging worker 挂了：退回现状（处置延迟无人喊疼），不会让情况比今天更差
③ **后续机制**——新状态 triage_status 可能出错的方式：绑定的 issue 被关闭但信号未 resolve（orphan triage）→ 由 aging worker 二期扩展扫「triaged 但 issue closed 且信号仍 open」兜住（本期标注为已知缺口，不阻塞）；triage 后问题实际仍在（检测再次触发 upsert 刷新 last_seen）→ 既有 upsert 机制会刷新证据，triage 状态保留，语义正确
④ **退役条件**——若 CriticalSignalWakeup 唤醒桥（非目标项）未来接线且证明「自动派工处置」稳定运行，triage 队列可退化为纯展示层；aging worker 在「open 信号常态 <5 条」连续 30 天后可考虑降频或退役

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 处置状态放哪 | signals 表加 triage_status 子状态字段 | 独立 signal_triage 表 | 处置进度与信号同生命周期，1:1 关系，分表只增 join 复杂度；终态复用 status 避免双状态机 |
| 终态与进度 | status=终态，triage_status=open 期进度，正交 | 单一状态字段全包 | 既有 resolve/dismiss/auto-resolve 路径全部不动，改动面最小；双字段语义边界用文档钉死 |
| 老化实现 | 新建 RhiSignalAgingWorker（复刻 SignalAgingWorker 模式） | 扩展 SignalAgingWorker 扫两张表 | 两个信号池语义不同（獭间协调 vs 健康观测），阈值、告警文案、去重键都不同；分开各自演进，同模式不共享代码 |
| 处置写入 | agent 工具 + http 端点双入口 | 只 http 端点 | 日报獭处置走工具（流程内嵌）；搭档面板操作走 http（事后操作）——两种消费形态都真实存在 |
| 阈值 72h/7d | 常量起步，观察校准 | 配置化 | 尚无数据支撑配置价值；常量+后续校准与 D5 权重先例一致。此为初始值声明，非省事主张 |
| 存量 40 条 | 批量 triage 并入 #1012，不逐条 resolve | 逐条人工处置 | 它们同根因候选已由 #1012 聚合分析接管；逐条 resolve 是把口径问题的债伪装成处置完成。批量 triage 后数字诚实（已归口≠已解决），#1012 修好口径后 auto-resolve 统一清场（§6） |
| dismiss 权限 | 獭可 dismiss 但 note 必填必写库，无工具层拦截 | 工具层拦截（dismiss 仅 http/搭档） | 拦截会逼日报獭把合法「不处置」塞进 bind_issue 假绑定，污染 triage 数据；note 必填由 repo 层承载，与 #406「不处置必须是判断结论」原则同构 |
| issue 停滞盲区 | 一期显式接受，量化触发条件（orphan/停滞 ≥5 启动二期） | 一期就建 issue 活动扫描 | issue 活动扫描需引入 GitHub API 轮询与速率管理，机制膨胀；先量化盲区、让盲区可见（数量可观测），再决定二期 |

## 验证

方案阶段验收（本 PR 为方案文档，实现另起 PR）：
1. 对抗审视通过（双检视獭：glm + mimo）
2. 搭档终审定稿

实现阶段验收（写入实现 PR 的验证清单，此处冻结承诺；**编排顺序即验收顺序**）：
1. schema 迁移后存量 open 信号读取不变（回归测试：迁移前后 findOpen() 结果集 diff 为空）
2. SignalRecord 接口含 4 新字段且 upsert UPDATE 分支不含它们（防御边界回归测试：upsert 后 triage 字段不被覆盖）
3. triage_signal 工具三动作行为测试 + §2 幂等语义表逐行验收（bind 覆盖换绑 / in_progress 幂等 / dismiss 幂等且 note 必填校验拒绝空 note）
4. **auto-resolve 抹平回归测试（S1）**：triaged 信号不再被检测 → auto-resolve 后 status=resolved 且 triage_status/issue_number 为 NULL、triage_note 保留
5. aging worker：伪造超龄信号 → 聚合落 1 条 healing（非逐条）；同 signal_type 去重；信号终态化后对应 healing 自动销号；resolve 后复悬置再落
6. **存量出清执行记录（先于 worker 上线）**：N 条 critical → triaged(issue=1012)，面板未接单清零；复盘结论适用范围声明留痕
7. 面板端点返回 triage 字段（API 自动化测试）；处置队列分组渲染组件测试（vitest，web/src/pages/health/ 既有测试框架同模式）
8. 日报处置段新 prompt 首跑对账：M+K+L+D=N 从 triage 数据自动生成，且 N=当日新增

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| docs/features/2026/09/17/F20260917trig-rhi-signal-triage.md | 新增 | 本方案文档 |
| src/frameworks/db/schema.ts + migration | 修改 | signals 表 4 新字段（实现期） |
| src/usecases/health/signal-repository.ts | 修改 | SignalRecord 接口扩展 4 字段 + 新增 triage() 单一写方法 + findByTriageStatus() 查询；upsert 路径不含新字段（防御边界）（实现期） |
| src/usecases/health/signal-pipeline.ts | 修改 | resolveStaleSignals auto-resolve 同步抹平 triage 字段（§6，S1 修订）（实现期） |
| src/usecases/health/rhi-signal-aging-worker.ts | 新增 | 老化扫描（聚合限流 + 孤儿 healing 清理）（实现期） |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts + 工具文件 | 修改/新增 | triage_signal + list_rhi_signals 注册与实现（实现期） |
| src/interface-adapters/http/controllers/rhi-controller.ts | 修改 | signals 端点返 triage 字段 + triage POST 端点（实现期） |
| web/src/pages/health/ | 修改 | 处置队列视图 + 分组组件测试（实现期） |
| prompts/scheduled/daily-health-check.md | 修改 | 处置段机制对账口径 M+K+L+D=N（实现期） |

## 对抗审视决策史（第一轮）

双检视獭（glm + mimo，均异模型）审视，重对抗门结论：glm「确认治本」、mimo「疑似治标但推荐接受」（理由：可见的疼痛≠自动处置，方案有明确分阶段策略——本方案解决「没人干时系统装死」，自动派工为唤醒桥后续演进）。

严重发现处置（6 条，全部接受并修订）：
- glm S1 auto-resolve 冲突 → 新增 §6，决策选项 (b)（终态抹平进度字段），signal-pipeline.ts 入改动范围
- glm S2 dismiss 权限矛盾 → §2 选定语义：獭可 dismiss 但 note 必填必写库 + 对账扩展 M+K+L+D=N；拒绝工具层拦截（会逼出假绑定）
- glm S3 issue 停滞盲区 → 部分接受：一期显式接受风险 + 量化二期触发条件（≥5 条）；孤儿 healing 清理纳入一期
- glm S4 首扫告警风暴 → §3 聚合限流 + 上线编排顺序（出清先于 worker）
- mimo S1 SignalRecord 接口遗漏 → §1 写入边界声明 + 改动范围表补全（含 F5 工具注册）

建议发现 13 条（R1-R7 + F1-F6）全部接受，逐条修订落点见正文各节「（编号 修订）」标注。无反驳条目——双报告无一条发现经决策树判断为「改了让系统更差」。
