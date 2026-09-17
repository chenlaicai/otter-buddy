---
id: F20260917trig
title: RHI 信号处置状态机：triage 队列 + issue 绑定 + 老化升级 + 处置进度面板
summary: |
  治本改造（搭档 2026-09-17 拍板「直接开始治本」）：RHI 信号从「传感器阵列（只报没人接）」
  升级为「处置队列（每条有主、有进度、有生命周期）」。核心：signals 表加处置状态机
  （open→triaged→in_progress→auto-resolved，dismissed 仅搭档）、信号↔issue 结构化绑定、
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

### 2. 处置写入路径：新增 agent 工具 `triage_signal`

在 signal-tools.ts（现为獭间信号工具文件）或新建 health 域工具文件中实现（实现期定，倾向放 health 域保持语义池分离）：

```
triage_signal(signalId, action, issueNumber?, note?)
  action = 'bind_issue'   → triage_status='triaged', issue_number=N   （已开/并入 issue）
  action = 'in_progress'  → triage_status='in_progress'               （有在途 PR/worktree）
  action = 'dismiss'      → status='dismissed', triage_note=理由       （误报/不处置，附理由）
```

配套查询工具 `list_rhi_signals(status, severity, triageStatus)`——让处置者（日报獭/搭档/被派工小獭）能拉「未接单清单」。

**谁在调**：daily-health-check 的处置段从「逐条三选一（开 issue/并入/不处置）」升级为「处置后必须调 triage_signal 留痕」——处置动作从此在系统里留结构化记录，日报 M+K+L=N 自检可以直接用 triage 数据对账（机制替代自觉）。

### 3. 老化 worker：RhiSignalAgingWorker

学 SignalAgingWorker 的现成模式（F20260915hlife），独立 app 级 setInterval：

- 扫描：signals 表 status='open' AND triage_status IS NULL（未接单）
- 阈值：critical 超 72h / warning 超 7d（从 first_seen 计；已 triaged 的不扫——已接单的事项进度由 issue/PR 生命周期自己管）
- 动作：落 healing event（errorType=other, severity=medium, context 带 signalId+挂了多久），同一 signalId 去重（查 open healing 的 context）
- 为什么 medium 不是 high：处置延迟是流程问题不是系统故障（与 SignalAgingWorker 同口径）

**新增决策分支说明**：老化落 healing 后被 resolve 的信号若仍 open，下一轮间隔 ≥24h 会再落一条（与 SignalAgingWorker 同语义——持续悬置本就该持续可见）。

### 4. 面板：「警报」页变处置队列

RhiController 的 signals 端点返回数据组装时带上 triage 字段；前端分组从「按 severity」改为「按处置状态」：

- **未接单**（triage_status IS NULL）置顶，按挂了几天降序，每条显示「open N 天」——N 越红越醒目
- **已归口**折叠为一组，显示绑定 issue 链接与 triage_note
- **修复中**显示 issue + 在途 PR 状态
- 每条的操作按钮从「详情」变为「开 issue 处置 / 绑定已有 issue / 忽略（附理由）」——写路径经新后端端点 `POST /api/health/signals/:id/triage`（复用 triage_signal 同一 repo 方法）

### 5. 存量出清（T4 交付路径）

本 PR 合入后第一轮动作（写进验证段）：
1. 按 #1012 第一步做 5 条高频 critical 的根因复盘（同根因 vs 不同 bug）
2. 复盘结论决定：阈值口径修复若归 #1012 后续 PR，则本 PR 先把 44 条存量按「并入 #1012」批量 triage（triage_status='triaged', issue_number=1012）——面板立即从「40 条未接单」变「40 条已归口同一 issue」，数字诚实了
3. 日报处置段 prompt 同步更新（调 triage_signal 留痕的硬规则）

## 影响范围

- signals 表 schema 迁移（4 个新字段，全部 nullable/默认值——存量行为零变化）
- 面板 signals 端点返回结构扩展（新增字段，前端旧版忽略新字段不炸）
- daily-health-check prompt 更新（处置段改机制对账口径）
- 新增 worker（app.ts 装配，与 SignalAgingWorker 并列）
- 新增 2 个 agent 工具 + 1 个 http 端点

## 风险与约束

- **迁移风险**：ALTER TABLE 加列对 SQLite 安全（既有迁移框架已多次执行同型操作）
- **双状态字段语义混淆风险**（status vs triage_status）：通过「终态归 status、进度归 triage_status」的正交划分 + 文档注释消解；UI 只暴露组合后的单一展示态
- **老化阈值拍脑袋风险**：72h/7d 是初始值，写在常量里可调；观察期后按实际处置速度校准（D5 权重校准有同样先例，issue #595 后续项）

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
| 存量 40 条 | 批量 triage 并入 #1012，不逐条 resolve | 逐条人工处置 | 它们同根因候选已由 #1012 聚合分析接管；逐条 resolve 是把口径问题的债伪装成处置完成。批量 triage 后数字诚实（已归口≠已解决），#1012 修好口径后统一清算 |

## 验证

方案阶段验收（本 PR 为方案文档，实现另起 PR）：
1. 对抗审视通过（双检视獭：glm + mimo）
2. 搭档终审定稿

实现阶段验收（写入实现 PR 的验证清单，此处冻结承诺）：
1. schema 迁移后存量 148 条 open 信号读取不变（回归测试）
2. triage_signal 工具三动作（bind/in_progress/dismiss）行为测试 + 幂等
3. aging worker：伪造超龄信号 → 落 healing；同 signalId 去重；resolve 后复悬置再落
4. 面板端点返回 triage 字段；前端分组渲染测试
5. 存量出清执行记录：40 条 critical → triaged(issue=1012)，面板未接单清零
6. 日报处置段新 prompt 首跑对账：M+K+L=N 从 triage 数据自动生成

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| docs/features/2026/09/17/F20260917trig-rhi-signal-triage.md | 新增 | 本方案文档 |
| src/frameworks/db/schema.ts + migration | 修改 | signals 表 4 新字段（实现期） |
| src/usecases/health/signal-repository.ts | 修改 | triage 写入/查询方法（实现期） |
| src/usecases/health/rhi-signal-aging-worker.ts | 新增 | 老化扫描（实现期） |
| src/interface-adapters/agent-runtime/tools/ | 修改/新增 | triage_signal + list_rhi_signals（实现期） |
| src/interface-adapters/http/controllers/rhi-controller.ts | 修改 | signals 端点 + triage POST（实现期） |
| web/src/pages/health/ | 修改 | 处置队列视图（实现期） |
| prompts/scheduled/daily-health-check.md | 修改 | 处置段机制对账口径（实现期） |
