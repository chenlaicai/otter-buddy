---
id: F20260916b1ea
title: 重启自动恢复机制重建：invoke 模型下的恢复队列 + 信号补扫回归
doc_type: feature

summary: |
  重建 9/13 在 PR #886 重构中被误删的「服务重启自动恢复中断发言」能力
  （历史现场 issue #992）。invoke 模型下重映射：中断锚点 = running invoke 行；
  最小化重建 restart_pending_resumes 队列表（原子 claim + crash-resilience +
  attempts 上限三保障，搭档 9/16 质疑建表必要性后重新论证——metadata 方案
  技术成立但长期可审计性差，L1 拍板建表留痕可否决）；failRunningInvokes
  改 UPDATE...RETURNING 原子化（消 SELECT-then-UPDATE 竞态）；signal 崩溃
  窗口补扫随恢复流程回归（entries 数据源）。成功路径静默（沿用搭档 9/6
  裁决），失败才出声。

causal_links:
  from:
    - F20260826rsme   # 服务重启自动恢复中断发言（初建，被 #886 误删，本档重建）
    - F20260906rsts   # 恢复静默成功（成功不宣告裁决，本档沿用）
    - F20260913ctlv   # 对话视图重构（误删现场，invoke 模型是本次重建的基座）
  supersedes: []

change_type: feature
tags: [resume, recovery, restart, invoke-model, queue, signal-rescan]
modules:
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - src/frameworks/db/conversation/sqlite-invoke-repository.ts
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
  - src/usecases/conversation/resume-interrupted-service.ts
  - src/usecases/conversation/conversation-repository.ts
  - src/bootstrap/database.ts
  - src/app.ts
capability_test: "n/a: 后端恢复机制，由 vitest 单测覆盖（非软代码）"
created_in_conversation: 2964fa59-1b25-45c4-9b0c-23afdb952969
---

# 重启自动恢复机制重建（F20260916b1ea）

## 背景与需求

**历史现场（issue #992）**：「服务重启自动恢复中断发言」能力（F20260826rsme 初建，
搭档一路推动：8/28 初建 → 8/31 #599 锁修复 → 9/4 五连修复 → 9/6 静默化裁决）在
9/13 PR #886（F20260913ctlv 对话视图重构）中被当死代码整删——批4a（6342a9f6）
整删 ResumeInterruptedService + retry-policy 4 个文案函数，批4c（2a30f15f）drop
restart_pending_resumes 表。退役决策链是循环论证（服务删因为队列退役、队列删因为
服务退役），搭档从未拍板退役该能力；9/6 裁决保留的是「重启后触发重跑」行为，
只删宣告文案。

**案发现场（2026-09-16 实测）**：18:17:50 搭档发消息 → 大獭 invoke `ad7ad765`
启动（61 次工具调用）→ 18:28:02 进程 SIGTERM 中断 → 18:30:07 新进程 reconcile
标 failed → **零恢复、零提示、零台账**，中断被系统完全吞掉，靠搭档肉眼发现。

**搭档裁决（2026-09-16）**：「由于系统重启导致的中断就应该由系统重启后重新触发」
「按最优最优雅最完整的方案来」。

## 方案设计

### 语义重映射（messages 模型 → invoke 模型）

| 维度 | 旧（messages 模型） | 新（invoke 模型） |
|------|------|------|
| 中断锚点 | 半截 streaming message 行 | running invoke 行（原生有 trigger_entry_id / otter_id / conversation_id） |
| 半截内容保留 | prepareForRetry(preserveSegments=true) | entries 追加式天然保留，无需保留逻辑 |
| done 判定 | 派发台账 settle 终态 | invoke 终态直读（更直接） |
| 并发窗口数据源 | messages 表查最新 user 消息 | entries 表查 entry_type='user' 的 MAX(created_at) |

### 队列表重建（最小化）

```sql
CREATE TABLE restart_pending_resumes (
  invoke_id TEXT PRIMARY KEY,          -- 被中断的 invoke（锚点即真相源）
  conversation_id TEXT NOT NULL,
  otter_id TEXT NOT NULL,
  trigger_entry_id TEXT,               -- 触发 entry（续跑记账用）
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','done','failed','exhausted')),
  attempts INTEGER NOT NULL DEFAULT 0, -- 恢复尝试计数（防无限重试）
  created_at TEXT NOT NULL,            -- reconcile 入队时刻
  settled_at TEXT                      -- 终态时刻
);
```

**建表论证（搭档 9/16 质疑后的重新论证，L1 拍板留痕可否决）**：恢复机制需要
「持久化、原子、跨重启的状态」是语义刚需——①恢复中崩溃可重拾（恢复机制存在的
意义就是「进程会死」，恢复流程自己死了就丢 = 只在运气好时工作）；②attempts 上限
防配额耗尽型 429 无限重试（#843 实证）。双进程原子 claim 在本项目单进程部署下
被高估（检视报告 S1 部分纠偏）。invokes metadata 方案技术成立，但状态机藏 JSON
无 CHECK 约束无索引、查询靠 JSON_EACH，回到誊抄结构——本状态机要长期活、每次
重启事故都要查账，显式结构长期维护成本低于 JSON 字段。选建表是形态取舍不是
安全必需，metadata 路径可作否决后的替代。

### 恢复流程（启动序列）

```
postInitDatabase（reconcile 阶段）
 └─ failRunningInvokes 改造：UPDATE invokes SET status='failed'
    WHERE status='running' RETURNING id, conversation_id, otter_id, trigger_entry_id
    （单条 SQL 原子完成标记+取详情，消 SELECT-then-UPDATE 竞态——S2 处置；
    SQLite 3.35+ 支持 RETURNING，开工验证 better-sqlite3 版本）
 └─ 对每个 RETURNING 行：INSERT OR IGNORE INTO restart_pending_resumes
    （pending 状态；scheduler 来源 invoke 排除——A3 处置：trigger_entry_id 为 NULL
    或指向 system entry 的 invoke 不入队，防定时任务重复产出）

buildApp 完成、服务就绪后（fire-and-forget，不阻塞就绪）
 └─ ResumeInterruptedService.resume()（延迟 3s 错开启动尾段）
     ├─ 信号补扫（A1 回归）：扫崩溃窗口内未消费 user entry
     │   （entry_type='user' + yield_targets 非空 + metadata.signalMeta 无 consumed
     │   标记 + created_at 早于本次启动），逐条走 routeTriggerMessage 补点火
     ├─ 取 pending 队列，跨会话并行、同会话串行（F202609048840 F1 移植）
     └─ 逐条恢复：
         ├─ 跳过检查：participant 失效（dissolved/inactive）→ exhausted 静默；
         │   并发窗口（恢复前 3s 内有新 user entry）→ exhausted + 系统消息提示手动重试
         ├─ attempts++（原子 UPDATE ... WHERE status='pending'，CAS 认领）
         ├─ 链引擎续跑：executeChain(initialTargets=[otterId],
         │   userMessageContent=续跑引导文案, triggerMessageId=invoke_id)
         ├─ 429/网络错误指数退避重试（≤3 次，5s 起步，旧实现移植）
         ├─ done 判定：新 invoke 终态直读（completed → done）
         ├─ 失败路径：标 failed + 系统消息「恢复过程中 invoke 失败，已标记为失败，
         │   请手动重试该消息。」（可手动重试）；超限标 exhausted
         ├─ 终态守卫（A4 移植）：finally 中兜底写终态，异常不逃逸中断同会话剩余
         └─ healing 台账落账（#613 模式：服务重启事件，severity 按中断数分级）
```

### 恢复期间的用户消息交互（A5，已知行为记录）

恢复链启动后目标獭 isRunning=true，此时用户新消息经 signal-router 走 steer/followUp
注入恢复 session——属预期行为（用户消息不丢，被恢复中的獭接住），并发窗口检查
（3s）只覆盖恢复触发前的间隙，不覆盖恢复全程。特性文档显式记录，不做更强互斥。

## 设计取舍

- **建表 vs metadata**：见「建表论证」段（L1 拍板，搭档可否决换 metadata 路径）
- **成功静默 / 失败出声**：沿用 F20260906rsts 搭档裁决，不新增宣告
- **scheduler invoke 排除**（A3）：定时任务恢复语义 = 重新触发任务而非续跑发言，
  误恢复会重复产出（日报写两遍）；scheduler 任务有自己的 catch-up 语义（#912 修复
  后），不属本机制管辖——收窄管辖边界（修法排序②特征，但整体为恢复既有机制）
- **机制识别检查点**（逐项打勾）：
  - ☑ 新增持久化存储（restart_pending_resumes 表重建）——**命中，但非净新增**：
    本表是 8/28 既有机制的同名重建（9/13 被误删，issue #992 定性重构吞功能），
    恢复的是被推翻的退役决策前的状态，不是引入系统从未有过的新机制。机制预算
    四问视角：原始问题（重启中断无恢复）从未消失，9/16 案发现场实证其回归。
  - □ 新增配置字段/枚举/开关：无
  - □ 新增状态生命周期：恢复队列状态机为既有机制恢复（同上论证）
  - □ 新增定时任务/后台进程：无（启动时一次性消费，fire-and-forget）
  - □ 新增信号类型/消息格式：复用既有 buildRestartResume* 文案语义
  - □ 新增决策分支：恢复/跳过/失败分支均为旧实现移植
  - □ 新增跨模块调用路径：复用 dispatch-chain-engine / signal-router 既有入口
- **Modification-Class 声明**：`narrow-fix`（修法排序①：在既有机制语义内补缺——
  恢复被误删的既有能力；建表是同名机制的恢复不是新增，论证见上）

## 影响范围

- 用户可见行为：重启后被中断的发言会被自动重新触发（成功静默）；恢复失败/跳过
  时对话流出现失败提示系统消息（可手动重试）
- 兼容性：新增一张表（initSchema + migration 幂等登记，老库补表）；invokes 表无
  schema 变更；`failRunningInvokes` 返回类型从 number 扩展为返回行详情（内部接口）
- 测试：resume 服务单测（移植旧 24 用例并按 invoke 模型改写）+ reconcile 入队测试
  + RETURNING 版本守卫

## 验证

（2026-09-16 实现完成后回填，全部在 worktree `restart-resume-rebuild` 分支
`feature/restart-resume-rebuild` 上实测）

- `npx tsc --noEmit`：0 错
- `npx vitest run`：全绿（260 文件 / 3164 用例，含本特性新增 17 用例——
  resume 服务 12 + reconcile 入队 5）
- `npx eslint <改动文件>`：0 error（含 max-statements/max-depth/max-lines 约束合规——
  reconcile 入队逻辑提取为 `reconcileRunningInvokes` 独立函数）
- `npm run lint:intent`：0 error（本期判定 0/0）
- **生产副本真启动（db 迁移硬规则）**：备份 `data/otter-buddy.db`（924MB，
  WAL checkpoint 后副本）至 /tmp，隔离环境（独立端口 18777 + 占位 LLM key）
  跑完整 `main.js` 启动路径：
  - ✅ 服务监听成功（HTTP 404）
  - ✅ 日志 0 SqliteError
  - ✅ `restart_pending_resumes` 在既有库上自动补建
    （日志：`"created":["restart_pending_resumes"],"msg":"Schema init: 1 tables created on existing database"`），
    表形为 invoke 模型（invoke_id PK）
  - ⚠️ **实测发现风险**：信号补扫在生产数据上扫到历史未消费 user entry 并补点火，
    同一獭并发 invoke 触发 SessionLockConflictError（36 active locks → invoke failed）。
    补扫范围（`created_at < serviceStartedAt` 的全部历史）宽于「崩溃窗口」语义——
    与 F20260908rlcp 收窄 routeSignals 的教训（09-09 一句话点 3 次 invoke）存在张力。
    已作为 objection 提交大獭审视裁决（见会话 signal 台账）。

### 新增测试覆盖（17 用例）

- resume-interrupted-service.test.ts（12）：pending 消费（引导文案/initialTargets/
  triggerMessageId=中断 invoke/done 流转/成功零系统消息——9/6 静默裁决沿用）/
  并发窗口跳过（exhausted+降级提示）/participant 失效（exhausted 静默）/链引擎抛错
  （failed+失败提示）/429 退避重试后成功/429 重试耗尽（failed+失败提示）/CAS 认领
  冲突跳过/healing 落账（severity 分级）/信号补扫调用（rescanPending 早于启动时刻）/
  invokeFn 拒绝非可重试错误/invoke 终态直读 failed/多会话并行容错
- restart-resume-enqueue.test.ts（5）：user entry 触发 invoke → failed+pending 入队/
  trigger_entry_id NULL（scheduler）不入队/trigger entry 为 system 不入队/无 running
  空转零副作用/幂等（重复 reconcile 不重复入队）
