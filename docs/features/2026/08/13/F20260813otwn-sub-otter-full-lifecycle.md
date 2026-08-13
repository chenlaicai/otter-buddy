---
id: F20260813otwn
title: sub-otter-triggering
doc_type: feature

summary: |
  优化大獭召唤小獭的判断指导：触发条件具体化 + scheduler task body 不再催眠大獭。
  根因：今日 4 个并行 issue 处理时大獭 7 次退化（mimo repeat_window），不是 mimo 单方面问题，
  是判断指导失效——"任务量大/并行做多件事"过于抽象，加上 scheduler 把 task body 直接催眠大獭
  成"每日 issue 处理小獭"，绕过了召唤判断。三处 prompt 层面的微调，不动代码机制。

causal_links:
  from:
    - F20260805f146   # degenerate-output-gradient-intervention（退化梯度介入，今日事故的兜底机制）
    - F20260804dglp   # OutputGuard 双机制检测
    - F20260730heal   # self-healing-system

status: development
change_type: prompt
tags: [agent-architecture, sub-otter, prompt-engineering, degenerate-prevention]
modules:
  - .pi/skills/otter-summon/SKILL.md
  - src/interface-adapters/agent-runtime/tools/scheduled-task-tools.ts
capability_test: "待定：B 类（LLM 行为），需真系统 + 真 LLM 验证大獭在收到任务时是否触发召唤判断"
---

# F20260813otwn: 大獭召唤小獭的判断指导

## 背景与需求

### 问题描述

对话《Self-Healing》（conversation_id=`3241317b-99d6-4d78-9248-ff208a7461bc`）今日（2026-08-13）10:29~11:35 期间，大獭在 1 小时内触发 **7 次 repeat_window 退化**（同 100 字符窗口重复 ≥ 50 次），其中 2 次重试再犯落终态。退化文本量 3,239 ~ 33,962 字符不等。

退化集中在 4 个并行 PR 处理流程中（4 个 daily-review issue → 4 个 PR → 4 只检视獭 → 多轮 delta 复核）。

### 根因分析

不是 mimo 单方面的问题（虽然 mimo 有 repeat_window 自发倾向，已记录于 `project_mimo_degenerate_tendency.md`）。**核心是判断指导失效**——大獭本该派开发獭处理 4 个并行 issue，实际却自己在 main session 跑完了全部任务体。

判断指导失效有三层：

#### 失效 1：otter-summon SKILL.md 触发条件太抽象

`.pi/skills/otter-summon/SKILL.md` L4 & L31-38 给出的触发场景是：

- "需要独立审视"
- "**并行做多件事**"
- "模拟多角色讨论"
- "**任务量大需分担**"

——"任务量大""并行做多件事" **没有可操作信号**。今天 4 个 issue 完全符合这两个条件，但大獭没触发召唤判断——凭"感觉任务量大不大"判断太模糊。

#### 失效 2：scheduler task body 直接催眠大獭

`src/usecases/scheduler/scheduler-service.ts` L341-358 直接把 task body 喂给 `task.talkingStonePassedTo[0]`（=大獭）。今日 seq 11 的 body 原文：

```
# 每日 Issue 处理

你是大獭召唤的每日 issue 处理小獭。任务：处理 daily-review 标签的 open issue...

## 步骤
### 1. 获取待处理 issue
### 2. 逐个分析 issue
### 3. 设计优化方案
### 4. 按研发流程提交 PR
### 5. 汇总
```

**双重打击**：
- 文本"你是小獭"催眠大獭错位（绕过 BIG_OTTER.md 的身份锚定）
- 步骤 1~5 直接展开任务体——大獭**根本没机会触发召唤判断**，被文本推着走

#### 失效 3：BIG_OTTER.md 把判断权完全下放

`prompts/identity/BIG_OTTER.md` L14: "简单的事你直接上手做；复杂的事你也有办法——小獭是你的延伸"。L30-32 整个"召唤小獭"小节只说"判断见 otter-summon skill"。

→ "简单/复杂"判断**完全下放给 skill**，但 skill 又太抽象（见失效 1）。大獭没有明确的"该查 skill 了"的锚点。

### 数据实锤

#### 退化事件时间线（北京时间 2026-08-13）

| Seq | 时间 | 触发 | totalLength | 结果 |
|-----|------|------|-------------|------|
| 12 | 10:29:59 | 大獭接收 "每日 issue 处理" body 后开始干活 | — | failed → 重试 |
| 14 | 10:42:19 | 重试再犯 | 23,865 | **aborted（终态）** |
| 16 | 10:47:42 | 用户："异常重复了？你不要变傻" | — | failed → 重试成功 |
| 20 | 10:54:51 | 用户："你拉检视獭去检视pr" | — | failed → 重试成功 |
| 28 | 11:10:20 | 检视獭-PR260（第 2 只）汇报后 | — | failed → 重试成功 |
| 33 | 11:15:55 | 检视獭-PR262（第 4 只）汇报后 | — | failed → 重试成功 |
| 48 | 11:33:45 | 检视獭-PR262 第三轮 delta 复核报告后 | — | failed → 重试 |
| 50 | 11:35:56 | 重试再犯 | 13,044 | **aborted（终态）** |

**关键规律**：退化集中在 N 个同构任务的处理过程中（处理到第 2、第 4 只时复发），不是单点输入污染。

#### 执行者分布（验证"判断指导失效"）

| 阶段 | 实际执行者 | 是否隔离 |
|------|----------|---------|
| Issue 分析 + 设计 + 写代码 + 提 PR（4 份） | **大獭自己**（sender_id=`87f172c6`） | ❌ main session |
| 4 份 PR 对抗审视 | 4 只检视獭（独立 otterId） | ✅ 各自独立 session |
| 修复 + 推送 + delta 复核协调 | **大獭自己** | ❌ main session |

如果大獭在第 1 阶段就触发判断派出 4 只开发獭，main session 累积从 O(N × 任务体) 降到 O(N)，退化大概率不会发生。

#### 现有基础设施（已经齐了）

| 调查项 | 结论 |
|--------|------|
| 开发/审视 skill 基础设施 | ✅ `requirement-analysis` / `code-implementation` / `adversarial-review` 已存在 |
| Sub-otter 创建机制 | ✅ `create_otter` 工具 |
| 并行调度技术底座 | ✅ `dispatch-chain-engine.ts` 已用 `Promise.allSettled` |
| `otter-summon` 协作模式参考 | ✅ `references/collaboration-patterns.md` 已有并行调研/开发↔检视循环/Skill Chain |

→ **不需要引入新概念或新机制**。差的是把"该召唤"的判断信号写清楚。

## 方案设计

### 技术方案

三处 prompt 层面的微调，不动代码机制、不引入新概念。

#### 改动 1：otter-summon SKILL.md 触发条件具体化

**位置**：`.pi/skills/otter-summon/SKILL.md` 的 description（L4）、触发条件（L18）、工作流步骤 1（判断示例）

**改法**：把抽象词换成**可操作信号**，让大獭看到任务时能机械匹配。

| 当前（抽象） | 改后（可操作信号） |
|------------|------------------|
| "并行做多件事" | "≥2 个**同 skill** 任务并行（如 4 个 issue 都走开发流程、3 个 PR 都走审视流程）" |
| "任务量大需分担" | "单任务涉及多阶段产出（设计+实现+测试）" |
| "需求明确且简单"（排除） | "单步可答或一次 read + speak 能闭环" |

**为什么 description 也必须改**：SKILL.md 的触发机制是"LLM 只看 name + description 决定是否 read SKILL.md"（F20260811sktp 铁律）。description 不改，大獭可能根本不会读 SKILL.md，判断示例加了也白加。

—— 让大獭看到"4 个 issue 待处理"时**立刻匹配到信号**，而不是凭"任务量大不大"的模糊感觉。

#### 改动 2：scheduler task body 防催眠

**位置**：两处——(a) `create_scheduled_task` 工具的 body 参数 description（`scheduled-task-tools.ts`），(b) DB 中已有的 `scheduled_tasks` 记录（数据修复）。

**改法**：把"你是小獭 + 步骤 1~5"改为"任务清单 + 判断委托"：

```
今日 N 个 daily-review issue 待处理（每日健康检查生成）。

请查询当前列表，判断如何处理：自己干 / 派开发獭并行。参考 otter-summon skill 的判断示例。
```

**关键约束**：
- ❌ 不写"你是小獭"（避免身份催眠）
- ❌ 不预设步骤 1~5（避免绕过判断）
- ✅ 列任务清单（信息）
- ✅ 委托判断（让大獭按 skill 信号判断）

**范围限定**：只针对大獭通过 `create_scheduled_task` 动态创建的任务。ensure 创建的系统级任务（recruiting / healing）保持现状——recruiting body 已合规（无催眠文本），healing body 是系统侧分析任务（不适用"任务清单+委托"格式）。

#### 改动 3（不做）：BIG_OTTER.md hook

对抗审视后判定为可选——description 具体化后大獭能直接匹配到信号，不需要额外 hook。如明天观察发现大獭仍不触发召唤，再补。

### 目标

- T1: 大獭看到"≥2 个同构任务"信号时，主动召唤开发獭并行处理（不自己在 main session 跑任务体）
- T2: scheduler 触发的任务 body 不再催眠大獭（不出现"你是小獭"等身份错位文本）
- T3: 大獭 main session 累积从 O(N × 任务体) 降到 O(N)

### 成功标准

- SC1: 同样跑 4 个 daily-review issue，大獭主动召唤 ≥1 只开发獭（行为可观测）
- SC2: 大獭 main session cacheRead 峰值 < 50K（今日事故峰值 172K；4 个 dispatch + 4 份 terminal signal 估算 < 50K）
- SC3: 同期退化事件数显著下降（基线：今日 7 次 / 1 小时）

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1: 同构任务触发召唤 | 准备 2+ 个同构 issue，触发每日处理 | 大獭主动召唤开发獭，不自己跑任务体 |
| AT-2 | T1: 简单任务不召唤 | 给大獭单步可答的任务 | 大獭直接处理，不召唤 |
| AT-3 | T2: scheduler 不催眠 | 触发定时任务，检查 task body | body 不含身份催眠文本，含任务清单 + 判断委托 |
| AT-4 | T3: session 累积可控 | 跑 4 个并行任务，跟踪大獭 cacheRead | 峰值 < 50K |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 / AT-2 | tests/capability/sub-otter-triggering.capability.test.ts（待新建） |
| AT-3 | tests/capability/scheduler-task-body.capability.test.ts（待新建） |
| AT-4 | 同 AT-1，附带 session token 度量 |

## 实现细节

### 代码修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `.pi/skills/otter-summon/SKILL.md` | 修改 | description 具体化（L4）+ 触发条件具体化（L18）+ 工作流步骤 1 加"判断示例"段（6 个具体场景） |
| `src/interface-adapters/agent-runtime/tools/scheduled-task-tools.ts` | 修改 | `create_scheduled_task` body 参数 description 加防催眠引导 |
| DB `scheduled_tasks` 表 | 数据修复 | 每日 issue 处理 + 每日健康检查两个任务的 body 去掉"你是小獭"催眠文本 |

### 逻辑变更

无代码逻辑变更。两处改动都是 prompt / 文本层面 + 一处 DB 数据修复。

### 改动范围

prompt 文件 1 个 + 工具 description 1 处 + DB 数据 2 条。

## 验收结果

> 待实施后填。

## 对抗审视记录

### 第一轮（3 视角并行，已完成）

3 个独立 agent 并行审视，发现合并后 8 题。用户拍板结果：

| 题 | 决策 |
|----|------|
| 题 1：触发信号设计 | 选 A——用"同 skill"替代"同构"，删除"读 ≥2 文件"，加规模下限 |
| 题 2：scheduler body 落点 | 选 A——改动 2 缩窄为只针对大獭通过工具创建的动态任务，改 `create_scheduled_task` 工具 description。recruiting 不动，healing 保持现状 |
| 题 3：措辞 vs 机制 | 选 A——维持改 body 措辞（轻量），不升级为机制 |
| 题 4：根因分层 | 选 A+B——F 文档加根因分层声明，SC3 限定为"main session 退化下降" |
| 题 5：能力测试标准 | 暂缓——明天定时任务触发后线上观察 |
| 题 6：50K 阈值 | 选 B——改为"显著低于今日 172K"（无硬阈值） |
| 题 7：范围限定 | 选 A——F 文档加范围声明（仅覆盖独立同构任务） |
| 题 8：方案取舍 | 选 A——三处一起上，避免改 body 后大獭不催眠但仍不会判断 |

### PR 检视（第 1 轮，已完成）

检视獭发现 1 严重 + 4 建议。S1 判定为**实现遗漏**（description 未改导致判断示例白加），已补齐 description 具体化。A1~A4 建议发现待明天观察后决定是否处理。

## 设计决策

> 关键决策的 rationale，待审视后填。
