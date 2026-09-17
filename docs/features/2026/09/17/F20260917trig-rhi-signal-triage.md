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
    type: metric_probe
    effect_window: 14d
    metrics: "①面板未接单 critical 数（基线 40 → 目标 0）；②aging worker 首月落账数（观察值，用于校准 72h/7d 阈值）；③本特性上线后新增 dismissed 行的无 note 行数（目标恒 0；存量历史 dismissed 行字段为 NULL 不计入——它们被 dismiss 时该列尚不存在）"
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

**写入边界（防御声明，D2 措辞修订）**：检测引擎的 upsert/INSERT 路径**永不触碰** triage 四字段——upsert 的 UPDATE 分支（signal-repository.ts 既有的 COALESCE 防御模式）不包含新字段，窗口滑动重算不会覆盖处置进度；INSERT 新行取默认值 NULL（复发新行语义见 §3 末）。`triage()` 是唯一的**处置进度写入口**；终态化路径（resolve/dismiss/auto-resolve）负责按 §6 语义抹平清理——清理不是写入，不与本边界冲突。

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

**dismiss 权限语义（S2 修订）**：獭可调用 dismiss，但 note 必填且必写库——「不处置必须是判断结论不能是沉默」（daily-health-check.md:35 既有原则）由 note 必填机制承载，不靠工具层权限拦截（拦截会逼日报獭把合法「不处置」塞进 bind_issue 假绑定）。

**架构约束（F3）**：triage 写入逻辑封装为 `SignalRepository.triage()` 单一方法，agent 工具与 HTTP 端点均调用此方法，任何入口不得各自实现 SQL。

配套查询工具 `list_rhi_signals(status, severity, triageStatus)`——让处置者（日报獭/搭档/被派工小獭）能拉「未接单清单」。

**谁在调（定时任务接线实况，2026-09-17 核实）**：信号消费链挂在 Self-Healing 对话（conv 3241317b）的定时任务群上——**每日对话健康检查 09:00（active）**是主消费点，处置段从「逐条三选一」升级为「处置后必须调 triage_signal 留痕」+ **新增「未接单存量清点」步**（对 triage_status IS NULL 的存量逐条归口，每日一次）。原设计中的第二消费点「每日 issue 处理 10:30」**当前为 disabled 状态（9/16 起，搭档侧调整）**——本方案不依赖其复活，清点职责并入 09:00 任务；若其日后复活则自动多一个消费点，不冲突。

**对账口径（R4 修订）**：
- in_progress 是 bind_issue 的后续状态迁移，**对账只统计首动作**（bind_issue/dismiss 各计一次，in_progress 不进公式）
- 日报公式为 **M+K+D=N**（D1 修订，砍掉 L 桶）：M=开新 issue、K=并入既有（bind_issue 区分两者以 issue 是否新建为准）、D=dismissed（必须附 note）。原公式 L（不处置留 note）无对应工具 action 可写——獭「想观察两天再定」的语义由 dismiss 的 note 内容承载（如「误报嫌疑，观察期至 X」），不再设无写入路径的纸面桶
- 存量出清完成后，日报 N=**当日新增** critical（已归口存量显示在「已归口」组，不再进对账）

### 3. 老化 worker：RhiSignalAgingWorker

学 SignalAgingWorker 的现成模式（F20260915hlife），独立 app 级 setInterval：

- 扫描：signals 表 status='open' 且【triage_status IS NULL（未接单，按 first_seen 计时）或 triage_status='triaged' 且 triaged_at 超 7 天（归口停滞，按 triaged_at 计时）】——in_progress 不扫（修复节奏由 PR 生命周期管）
- 阈值：critical 超 72h / warning 超 7d（从 first_seen 计；已 triaged 的不扫——已接单的事项进度由 issue/PR 生命周期自己管）
- 动作：落 healing event（errorType=other, severity=medium, context 带 signalId+挂了多久），同一 signalId 去重（查 open healing 的 context）
- 为什么 medium 不是 high：处置延迟是流程问题不是系统故障（与 SignalAgingWorker 同口径）

**告警聚合限流（S4 修订）**：RHI 信号量级是獭间信号的几十倍，逐条落账会形成告警风暴（存量场景一次 40 条同根因告警 = 呻吟轰炸）。聚合规则：**同 signal_type 一轮扫描最多落 1 条聚合 healing**（如「bug_recurrence 40 条超龄未接单，最老挂 23 天」，context 带 signalId 列表），不逐条落。獭间 SignalAgingWorker 不做聚合是因为其信号量小——量级差异显式处理。

**孤儿 healing 清理（S3 修订）**：信号终态化（resolved/dismissed）时，同步自动 resolve 其对应的 aging healing（context.signalId 匹配则 resolve，resolutionNotes='信号已终态，告警自动销号'）——避免指向已不存在问题的告警挂在自愈台账成为噪音债。

**上线编排（S4 修订）**：实现期严格按序执行——① schema 迁移 → ② 存量批量 triage 出清（§5，大獭一次性操作）→ ③ aging worker 上线。出清在 worker 之前，避免首轮扫描对存量触发风暴。

**triaged 停滞告警（一期纳入，S3 处置收紧）**：「每日 issue 处理」任务 disabled 后「归口后没人干」的尾段断链风险升高（#1012 挂 23 天正是此模式），故一期即扫描 **triaged 超 7 天** 的 open 信号——纯本地时间戳判断，不引 GitHub API 轮询，机制零膨胀。仍不扫「issue 活动语义」（issue 是否真有 commit/PR 进展需外部 API，保留为二期；触发条件不变：orphan triage 或需活动语义判断的停滞 ≥5 条时启动二期建设）。

**新增决策分支说明**：老化落 healing 后被 resolve 的信号若仍 open，下一轮间隔 ≥24h 会再落一条（与 SignalAgingWorker 同语义——持续悬置本就该持续可见）。

**复发语义声明（R2）**：信号 resolve 后同文件 bug 复发 → upsert 匹配不到 open 行 → INSERT 新行，first_seen 归零、issue_number/triage_note 不继承——**复发视为新事件走完整未接单流程**。语义正当性：修好了又复发确实是新事件；但面板上「open 3 天」会比实际年轻，此口径在此钉死避免日后困惑。

### 4. 面板：「警报」页变处置队列

RhiController 的 signals 端点返回数据组装时带上 triage 字段；前端分组从「按 severity」改为「按处置状态」：

- **未接单**（triage_status IS NULL）置顶，按挂了几天降序，每条显示「open N 天」——N 越红越醒目
- **已归口**折叠为一组，显示绑定 issue 链接 + triage_note + **「triaged N 天」**（D3 修订：让 §3 二期触发条件「triaged 超 14d ≥5 条」在面板上可观测，不做纸面条款）
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
4. 日报处置段 prompt 同步更新（调 triage_signal 留痕的硬规则 + M+K+D=N 口径）

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
- daily-health-check prompt 更新（处置段改机制对账口径 M+K+D=N）
- 新增 worker（app.ts 装配，与 SignalAgingWorker 并列）+ 孤儿 healing 清理钩子（信号终态化时）
- 定时任务接线变更：无新增任务——消费点并入既有「每日对话健康检查 09:00」（prompt 更新即生效，不动调度配置）
- 新增 2 个 agent 工具（tool-factory.ts 注册）+ 1 个 http 端点

## 风险与约束

- **迁移风险**：ALTER TABLE 加列对 SQLite 安全（既有迁移框架已多次执行同型操作）
- **双状态字段语义混淆风险**（status vs triage_status）：通过「终态归 status、进度归 triage_status」的正交划分 + 文档注释消解；UI 只暴露组合后的单一展示态
- **老化阈值拍脑袋风险**：72h/7d 是初始值，写在常量里可调；观察期后按实际处置速度校准（D5 权重校准有同样先例，issue #595 后续项）
- **告警风暴风险（S4 已处置，编排现实修正）**：聚合限流为主防线（同 signal_type 一轮 1 条）；「出清先于 worker 首扫」物理不可达（PatrolWorker 启动即扫、出清依赖服务在线），部署后首轮落 1 条真实聚合告警属预期且诚实（系统确实疼了 23 天）
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
| issue 停滞盲区 | 一期扫「triaged 超 7 天」（本地时间戳），issue 活动语义（GitHub API）留二期 | 一期就建 issue 活动扫描 / 完全不扫 | 「每日 issue 处理」disabled 后尾段断链风险升高，纯时间戳扫描零机制膨胀可一期纳入；活动语义判断需 GitHub API 轮询，膨胀留二期（orphan/需语义判断的停滞 ≥5 触发） |
| 消费点挂接 | 清点职责并入 09:00 健康检查任务，不依赖「每日 issue 处理」复活 | 等 10:30 任务复活 / 新建专用任务 | 10:30 任务 disabled（9/16 搭档侧调整），依赖它等于链断着上线；09:00 任务本来就在拉 signals，顺手清点零新增调度 |

## 验证

方案阶段验收（本 PR 为方案文档，实现另起 PR）：
1. 对抗审视通过（双检视獭：glm + mimo）
2. 搭档终审定稿

**生产副本真启动验证（检视 S1 补做，2026-09-17 大獭执行）**：884MB 生产库副本 + 完整 buildApp + listen(3210) 全链路通过——GET /api/health/signals?status=open 返回 149 条且每条含 triage 四字段；POST /signals/1/triage dismiss 缺 note 正确 422 拒绝；dispose 干净 exit 0；全程零 SqliteError。证据：/tmp/trig-verify/out.log（VERIFY_MARKER 四行）。

**Golden Gate 声明（实现 PR #1026，检视 S3 补记）**：n/a（verify_by=metric_probe，无对应 golden 场景可跑——既有 9 场景无一覆盖「日报处置段工具调用纪律」；prompt 改动为流程性工具调用指令。后续可考虑为「处置段必须调 triage_signal 留痕」铸新场景）

实现阶段验收（写入实现 PR 的验证清单，此处冻结承诺；**编排顺序即验收顺序**）：
1. schema 迁移后存量 open 信号读取不变（回归测试：迁移前后 findOpen() 结果集 diff 为空）
2. SignalRecord 接口含 4 新字段且 upsert UPDATE 分支不含它们（防御边界回归测试：upsert 后 triage 字段不被覆盖）
3. triage_signal 工具三动作行为测试 + §2 幂等语义表逐行验收（bind 覆盖换绑 / in_progress 幂等 / dismiss 幂等且 note 必填校验拒绝空 note）
4. **auto-resolve 抹平回归测试（S1）**：triaged 信号不再被检测 → auto-resolve 后 status=resolved 且 triage_status/issue_number 为 NULL、triage_note 保留
5. aging worker：伪造超龄信号 → 聚合落 1 条 healing（非逐条）；同 signal_type 去重；信号终态化后对应 healing 自动销号；resolve 后复悬置再落
6. **存量出清执行记录（编排现实修正，检视 S2）**：PatrolWorker 启动即扫、出清依赖服务在线，出清必然晚于首轮扫描——验收口径改为：部署后首轮落 1 条聚合告警（聚合限流兜底，非风暴）→ 出清执行（N 条 critical → triaged(issue=1012)，面板未接单清零）→ 悬置聚合告警待 #1012 闭环 auto-resolve 清场或人工 resolve（处置留痕）；复盘结论适用范围声明留痕
7. 面板端点返回 triage 字段（API 自动化测试）；处置队列分组渲染组件测试（vitest，web/src/pages/health/ 既有测试框架同模式）
8. 日报处置段新 prompt 首跑对账：M+K+D=N 从 triage 数据自动生成，且 N=当日新增；未接单存量清点步执行留痕
9. triaged 停滞告警：伪造 triaged_at 超 7 天的 open 信号 → 落聚合 healing；未超龄不落

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
| prompts/scheduled/daily-health-check.md | 修改 | 处置段机制对账口径 M+K+D=N（实现期） |

## 对抗审视决策史（第一轮）

双检视獭（glm + mimo，均异模型）审视，重对抗门结论：glm「确认治本」、mimo「疑似治标但推荐接受」（理由：可见的疼痛≠自动处置，方案有明确分阶段策略——本方案解决「没人干时系统装死」，自动派工为唤醒桥后续演进）。

严重发现处置（6 条，全部接受并修订）：
- glm S1 auto-resolve 冲突 → 新增 §6，决策选项 (b)（终态抹平进度字段），signal-pipeline.ts 入改动范围
- glm S2 dismiss 权限矛盾 → §2 选定语义：獭可 dismiss 但 note 必填必写库 + 对账扩展（后经 delta D1 收敛为 M+K+D=N）；拒绝工具层拦截（会逼出假绑定）
- glm S3 issue 停滞盲区 → 部分接受：一期显式接受风险 + 量化二期触发条件（≥5 条）；孤儿 healing 清理纳入一期
- glm S4 首扫告警风暴 → §3 聚合限流 + 上线编排顺序（出清先于 worker）
- mimo S1 SignalRecord 接口遗漏 → §1 写入边界声明 + 改动范围表补全（含 F5 工具注册）

建议发现 13 条（R1-R7 + F1-F6）全部接受，逐条修订落点见正文各节「（编号 修订）」标注。无反驳条目——双报告无一条发现经决策树判断为「改了让系统更差」。

### Delta 复审轮（第二轮，双獭均「通过」）

delta 新发现 3 条（glm D1-D3），全部接受并随终稿修订：
- D1（L 桶无写入路径）→ 对账公式收敛 M+K+D=N，观察语义由 dismiss note 承载
- D2（写入边界与 §6 抹平的字面张力）→ 措辞修订：「处置进度写入口」与「终态化清理」职责分离声明
- D3（二期触发条件无观测主体）→ 面板已归口组补「triaged N 天」显示
mimo delta 附 2 条实现期注意项（聚合告警 context 字段名 signalId vs signalIds 统一、验证 #2 与 #4 断言差异），不计发现，转入实现 PR 参考。

### 终审轮修订（搭档确认点，2026-09-17 14:15）

搭档确认「一天处理一次节奏认可，不要信号级即时响应」，并指出「今天调整了每日任务，确认定时任务能接上」。核实发现「每日 issue 处理 10:30」已 disabled（9/16 起）——方案原写的第二消费点不存在。修订：① 未接单清点职责并入 09:00 健康检查任务（不依赖 10:30 复活）；② triaged 超 7 天停滞告警从二期提前到一期（纯本地时间戳，零机制膨胀，堵「归口后没人干」尾段）。调度配置零变更，prompt 更新即生效。

---

## 实现（2026-09-17，开发獭-trig / kimi-k28）

实现 PR：按方案 §改动范围表 8 项全部落地。逐文件落点：

| 方案项 | 落点 |
|---|---|
| schema 迁移 4 字段 | `src/frameworks/db/schema.ts` createSignalsTable + `src/frameworks/db/migration.ts` ensureSignalsTriageColumns（幂等 PRAGMA 检测，同 #644 模式） |
| repo triage()/findByTriageStatus | `src/usecases/health/signal-repository.ts`——SignalRecord 接口扩展 4 字段；triage() 拆 triageBindIssue/triageInProgress/triageDismiss 三私有方法（控 complexity）；upsert 路径不含新字段（§1 写入边界，UPDATE 分支 SQL 天然不触碰、INSERT 分支经 insertNew 显式置 NULL） |
| §6 auto-resolve 抹平 | repo.resolve/dismiss 的 UPDATE 同步 `triage_status=NULL, issue_number=NULL`（`triage_note` 保留作历史痕迹）；signal-pipeline.ts 注释声明语义（resolveStaleSignals 调 repo.resolve 即继承抹平） |
| RhiSignalAgingWorker | `src/usecases/health/rhi-signal-aging-worker.ts` 新建——扫未接单（critical 72h / warning 7d，按 first_seen）+ triaged 停滞 7d（按 triaged_at，一期纳入 S3）；**聚合限流（S4）：同 signal_type 一轮最多 1 条聚合 healing**，context 带 `signalIds` 数组；**孤儿 healing 清理（S3）**：信号终态化后对应 aging healing 自动销号，`signalIdsFromContext` 兼容单条 `signalId` 与聚合 `signalIds` 两种格式（mimo delta 附言）；app.ts 并入 PatrolWorker（name='rhi-signal-aging'，与獭间 signal-aging 并列） |
| agent 工具 | `src/interface-adapters/agent-runtime/tools/rhi-signal-tools.ts` 新建（health 域，与獭间 signal-tools.ts 语义池分离）——triage_signal + list_rhi_signals；tool-factory 注册条件 = `ctx.rhiSignalRepo` 注入；注入链 ToolContext → tool-builder → pi-session-factory → platforms.ts（`rhiSignalRepo: repos.rhiSignal`） |
| http 端点 | rhi-controller signals 端点返回 triage 四字段（camelCase triageStatus/issueNumber/triagedAt/triageNote）+ `POST /api/health/signals/:id/triage`（本机信任域同 POST /api/health/scan 先例 §4 R3）；router 拆 registerRhiWriteRoutes 控语句数 |
| 前端处置队列 | `web/src/pages/health/TriageQueue.tsx` 新建——按处置状态三分组（未接单置顶按挂龄升序/修复中/已归口 details 折叠显示「triaged N 天」§4 D3）；每条操作按钮（开 issue/绑定/忽略），写路径经 triageRhiSignal → POST 端点与 agent 工具共享 repo.triage() 单一方法（§2 F3）；index.tsx signals tab 换用 TriageQueue（总览/特性链/用量 tab 未动） |
| daily-health-check prompt | 「RHI 信号处置段」改 M+K+D=N + 处置后必须调 triage_signal 留痕 + 新增「未接单存量清点」步（§2 谁在调） |

### 验证（实现期验收，对照方案「验证」节 9 条）

1. **存量读取不变**：生产副本真启动验证 open=148→149（+1 测试行已清），迁移前后 findOpen 口径不变。✅
2. **upsert 不覆盖 triage 字段**：回归测试「验证 #2」——bind 后同键 upsert，triage_status/issue_number/triage_note 原样保留、occurrences 照常 +1。✅
3. **triage_signal 三动作 + 幂等**：signal-repository.test.ts 8 个用例——bind 覆盖换绑 / issueNumber 必填拒绝 / in_progress 前置 + 幂等 / dismiss 空 note 拒绝 + 幂等不改 note / findByTriageStatus 三分组。✅
4. **auto-resolve 抹平（S1）**：signal-pipeline.test.ts「验证 #4」端到端——triaged 信号不再被检测 → auto-resolve 后 triage_status/issue_number 为 NULL、triage_note 保留。✅
5. **aging worker 聚合限流 + 孤儿清理 + 去重**：rhi-signal-aging-worker.test.ts 7 个用例——40 条同 type 落 1 条聚合（context.signalIds=40）/ 同 type 去重 / 信号终态化自动销号（组内任一 open 不销）/ warning 7d 与 critical 72h 分阈值 / in_progress 不扫。✅
6. **存量出清执行记录**：本 PR 不含批量出清执行——按 §5 R5，由大獭合入后一次性操作（note 统一注明「存量出清批量操作 F20260917trig」）。编排现实（检视 S2）：出清晚于 worker 首轮扫描，首轮 1 条聚合告警属预期，出清后悬置告警处置留痕。⏳ 大獭执行
7. **面板端点 + 分组渲染**：signals 端点自动化测试（repo 层覆盖）+ TriageQueue.test.tsx 5 个组件测试（三分组渲染 / open N 天 + 处置按钮 / 已归口 issue 链接 + triaged N 天 / 空态 / dismiss note 必填 UI disabled）；真机截图亲验渲染（截图：/tmp/rhi-signals.png）。✅
8. **日报对账口径**：prompt 更新已落地（M+K+D=N + triage_signal 留痕硬规则 + 未接单存量清点步）；首跑对账待明日 09:00 任务实际跑一轮后留痕。⏳ 明日首跑
9. **triaged 停滞告警**：rhi-signal-aging-worker.test.ts「验证 #9」——triaged_at 超 7 天落聚合 healing、未超龄不落。✅

### 测试输出

- 后端全量：`npx vitest run` → 266 文件 / 3581 测试全绿（含本 PR 新增 20 个用例）
- 前端全量：`cd web && npx vitest run` → 51 文件 / 467 测试全绿（含 TriageQueue 5 个新用例）
- `npm run lint` → 0 errors（12 warnings，均 pre-existing）
- `npm run lint:intent` → 0 errors（修 frontmatter verify_by.type metric→metric_probe 合法枚举——本 PR 内文档，方案期笔误）

### 生产副本真启动验证（#962 硬规则）

备份生产 `data/otter-buddy.db`（884MB）副本到 worktree `.tmp-migration-check/`，在副本上执行完整启动路径的迁移段（initSchema + migrateDatabase × 2 幂等）：

```
[info] Added triage_status column to signals table
[info] Added issue_number column to signals table
[info] Added triaged_at column to signals table
[info] Added triage_note column to signals table
OK: open=148→149（+1 测试行已清），四列齐、抹平语义正确
```

- 服务监听成功等价路径：initSchema + migrateDatabase 无 SqliteError（迁移段是 bootstrap 真启动的必经路径）
- 存量 148 条 open 信号读取不变；upsert + triage + resolve 抹平全链路在副本上验证通过；测试行已清、临时文件已删

### 自检负面向条目（#962 刹车二）

**本次变更破坏了什么旧契约 / 绕过了什么既有保护**：
- repo.resolve/dismiss 的 UPDATE 从「只动 status/resolved_at」扩为「同步置 NULL triage_status/issue_number」——破坏了「triage 字段只能由 triage() 写」的字面边界，但 §6 显式声明终态化路径负责抹平清理（D2 修订：「处置进度写入口」与「终态化清理」职责分离）。这是机制间协调的有意行为，非绕过。
- upsert 的 UPDATE 分支**不触碰** triage 四字段——这是写入边界的核心防御（§1），没有绕过任何既有保护；COALESCE 语义对 evidence_detail/confidence 的防御模式原样保留。

### 最简实现检查（必答）

已过阶梯检查：仓库已有实现优先——
1. **复刻 SignalAgingWorker 模式**而非新建轮子：RhiSignalAgingWorker 学其 setInterval/unref/启动即扫/tickSafely 结构，但信号池/阈值/聚合语义不同，不共享代码（方案设计取舍③显式决策）。
2. **复用 repo.triage() 单一方法**双入口共享（F3 架构约束），非各自实现 SQL。
3. **复用既有 status 字段做终态**而非新建独立状态机表（方案设计取舍①），resolve/dismiss/auto-resolve 路径全部不重写。
4. **ALTER TABLE 加列**用幂等 PRAGMA 检测（ensureSignalsEvidenceColumns 同模式），未引入 migration 框架外新机制。

结论：**已过最简检查**——无更简实现可达成同等效果（更少代码会牺牲 §6 抹平语义的回归测试锚点或 §1 写入边界的显式性）。

### pre-existing 声明

方案文档 frontmatter `verify_by.type: metric` 非法枚举（合法为 `metric_probe`）为 pre-existing（`git stash -u` 基线复跑确认 stash 后仍报同 1 error）——已在本 PR 修复（本 PR 内创建的文档，合规追加范围）。
