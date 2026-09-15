---
id: F20260915rptx
title: 定时任务 prompt 启动对账
doc_type: feature

# 记忆索引
summary: |
  定时任务 body 已 git 化（PR #428），但同步纯手动——daily-health-check.md 四次 PR
  更新后脚本从未运行，9/3-9/4 健康检查跑旧版 prompt（issue #784）。本次在
  SchedulerService.start() 挂启动对账：扫 prompts/scheduled/*.md（非 dynamic），
  按 task_name 或 kebab 文件名匹配 DB 任务，body trim 比对漂移即同步。
  对账方向为正向遍历（模板→DB），无模板任务天然豁免；覆盖全量任务含 disabled
  （repo 新增 getAll）；JSON 包装形态（paper-trading）只替换内层 prompt、
  watchlist 等运行时字段保留。顺手修存量缺口：paper-trading-daily.md 补
  task_name frontmatter（DB 内层 prompt 与模板已逐字一致，纳管零影响）。
  实施时实证健康检查 DB body 又漂了（缺 9/7 PR #832 的「标签与标题硬约束」段），
  首次部署即自愈同步。

# 因果链路
causal_links:
  from: ["F20260824dhck"]   # update-scheduled-task-body.mjs 脚本（手动同步的真相源迁移）
  to: []

# 元数据
change_type: feature
capability_test: "n/a: scheduler 启动对账为确定性代码路径（fs 读取 + hash 语义比对 + repo.update），无 LLM 行为变更；验证走 vitest 单测（11 用例：漂移同步/已同步跳过/disabled 覆盖/dynamic 豁免/匹配规则/JSON 包装/目录不可读降级）"
tags: [scheduler, prompt, git-truth-source, reconciliation]
modules: [src/usecases/scheduler/prompt-template-reconciler.ts, src/usecases/scheduler/scheduler-service.ts, src/usecases/scheduled-task/scheduled-task-repository.ts, src/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.ts, prompts/scheduled/paper-trading-daily.md]

# 时间
created_at: 2026-09-15
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
---

# 定时任务 prompt 启动对账

## 背景与需求

### 问题描述

issue #784：定时任务 prompt 已 git 化（PR #428）——`prompts/scheduled/*.md` 为真相源，DB body 是运行时副本，由 `scripts/update-scheduled-task-body.mjs` 手动同步。但脚本纯手动、无 CI/钩子挂载：

- `daily-health-check.md` 经 #444/#545/#629/#712 四次 PR 更新后，脚本从未运行，9/3-9/4 健康检查跑旧版 prompt，#600 处置权协议与止损线检查未生效（PR #782 特性文档有完整记录）
- issue 两方案：① GitHub Actions（CI 无本地 sqlite，跑不动）② 服务启动时自动对账（推荐，零外部依赖，重启即自愈）

### 实施时的新实证

本次实施时查 DB 发现**漂移又发生了**：每日对话健康检查的 DB body 缺 2026-09-07 PR #832 加的「标签与标题硬约束（F20260907itri）」段（模板 6529 字符 vs DB 5876）——#784 描述的缺口至今仍在复发，本修复正当其时。首次部署重启即自愈该漂移。

### DB 现状盘点（实施时逐任务核实）

| 任务 | 模板 | 状态 |
|---|---|---|
| self-healing-analysis | 有（dynamic: true） | 调度器运行时填充，天然豁免 |
| 依赖升级自动化 | 有 | 逐字同步 ✓ |
| 每日对话健康检查 | 有 | **漂移**（缺 PR #832 标签硬约束段） |
| 每日 issue 处理 | 有 | disabled + 漂移（DB 613 vs 模板 2855） |
| paper-trading-daily-trading | 有（但模板缺 task_name） | JSON 包装 {prompt, watchlist}，内层 prompt 与模板逐字一致 |
| paper-trading-match-orders | 无（function executor） | 不适用（body=`{}`） |
| 生日提醒/backlog digest/上下文观察/rcmm 复测/补丁回看 | 无 | 正向遍历天然豁免 |

## 方案设计

### 核心语义：正向遍历（模板→DB）

对账以模板为纲，git 真相源语义——**无模板的任务不被碰**。这是与手动脚本（反向：任务→模板）的关键差异：脚本按任务名找模板，找不到报错退出；对账器扫目录，无模板任务根本不进循环，天然豁免运行时创建的任务（生日提醒、backlog digest 等）。

### 匹配规则（与脚本 loadTemplate 规则一致，避免两套真相）

- frontmatter `task_name` 字段精确匹配任务名（跨语言命名唯一可靠键）
- 无 `task_name`：kebab(任务名) === 文件名（空格转连字符，大小写不敏感）
- `dynamic: true` 模板跳过（body 由调度器运行时填充占位符，issue #416）

### JSON 包装形态兼容

paper-trading-daily-trading 的 body 是 `{"prompt": "...", "watchlist": [...]}` 形态（#610 watchlist-only patch 的领域）。对账规则：body 解析为 JSON 且含 prompt 字符串 → 只对账/替换内层 prompt，**watchlist 等运行时字段保留**——自选池是运行时状态，模板管不着也不该管。match-orders 的 `{}` 无 prompt 字段不受影响（且它无模板）。

### 覆盖 disabled 任务（repo 新增 getAll）

「每日 issue 处理」处于 disabled 且 body 落后模板 2200+ 字符。disabled 不是「删除」——重新启用时该跑新 prompt，漂移照治。repository 接口新增 `getAll()`（必选，非可选：静默降级会漏掉 disabled 漂移，等于 bug 换马甲）。

### 挂载点与失败语义

挂在 `SchedulerService.start()`，紧跟 #775 僵尸对账之后、#814 调度完整性对账之前，同模式：**失败不阻塞启动**（try/catch + warn 日志）——对账是自愈增强，不该让它自己成为启动故障点。

### 顺手修存量缺口

paper-trading-daily.md 补 `task_name: paper-trading-daily-trading` frontmatter：之前无 frontmatter，按名匹配（kebab('paper-trading-daily-trading') ≠ 'paper-trading-daily'）永远匹配不到，一直处于「有模板但失联」状态。已验证 DB 内层 prompt 与模板内容逐字一致，加 frontmatter 纳管零影响。

## 实现内容

### 新增 `src/usecases/scheduler/prompt-template-reconciler.ts`

导出 `reconcilePromptTemplates({ taskRepo, logger, templateDir? })`：

- 扫描模板目录 `*.md`，dynamic 跳过
- `getAll()` 拉全量任务（含 disabled），按匹配规则找对应任务
- 裸 body：trim 比对；JSON 包装：内层 prompt trim 比对
- 漂移即 `taskRepo.update({ ...task, body, updatedAt: now })`，其余字段不动
- 每条变更记 `changes[]`（一句话描述），汇总数字进 info 日志
- 模板目录不可读：warn 后返回空结果（不阻塞启动）

### 接线

- `ScheduledTaskRepository` 接口 + Sqlite 实现：新增 `getAll()`
- `SchedulerService.start()`：#775 对账后调用 `reconcilePromptTemplates`（try/catch 包裹）
- 测试 mock 补齐（manage-scheduled-task.test.ts 强类型 mock）

### 测试（tests/usecases/scheduler/prompt-template-reconciler.test.ts，11 用例）

漂移同步 / 已同步跳过 / disabled 覆盖 / dynamic 豁免 / 两种匹配规则 / unmatched 不误伤 / JSON 包装替换内层 / 包装内层已同步跳过 / 非 prompt JSON 不误伤 / 目录不可读降级 / 其余字段与 updatedAt 保持

## 验证

- **单测**：新增 11 用例全绿；全仓 250 文件 2962 测试全绿（`npx vitest run`）
- **类型**：`npx tsc --noEmit` 零错误（含强类型 mock 补齐后）
- **最简实现检查**：已过——实现前阶梯逐级检查：仓库无既有对账模块（#814 模式只管触发窗口不管 body）；核心复用既有规则语义（task_name/kebab/dynamic 判定与手动脚本一致，未新造规则）；fs 直接读取零新依赖；对账器与 scheduler 松耦合（`Pick<..., 'getAll'|'update'>` 最小接口面）
- **Golden Gate**：n/a——非软代码（prompt 模板本身未改内容，只加 frontmatter 元数据；对账是确定性代码路径）
- **Intent 块**：n/a——非软代码变更（同上）

## 影响范围

| 文件 | 改动 |
|---|---|
| src/usecases/scheduler/prompt-template-reconciler.ts | 新增：对账核心模块 |
| src/usecases/scheduler/scheduler-service.ts | start() 挂对账（#775 后 #814 前，try/catch） |
| src/usecases/scheduled-task/scheduled-task-repository.ts | 接口 +`getAll()` |
| src/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.ts | 实现 `getAll()` |
| prompts/scheduled/paper-trading-daily.md | 补 task_name frontmatter（纳管） |
| tests/usecases/scheduler/prompt-template-reconciler.test.ts | 新增 11 用例 |
| tests/usecases/scheduled-task/manage-scheduled-task.test.ts | mock 补 getAll |

**首次部署效果**（预期）：重启后健康检查任务 body 自愈同步（补上 PR #832 标签硬约束段）；每日 issue 处理（disabled）body 同步；其余任务 no-op。

**运行时风险**：低。对账只在启动时跑一次；失败不阻塞启动；误伤面为正向遍历天然隔离（无模板不碰）。

## 取舍与备选

- **GitHub Actions 方案**（issue 方案①）：CI 无本地 sqlite 落地不了，弃
- **对账方向**：正向遍历（模板→DB）vs 反向遍历（任务→模板）。选正向——无模板任务天然豁免，且「git 真相源」语义下以模板为纲正确；反向会把 11 个任务里 6 个无模板的都暴露成「missing template」问题
- **getAll 必选 vs 可选**：必选。可选+静默降级会漏 disabled 漂移，bug 换马甲
- **discovery：脚本与对账器规则并存**——手动脚本保留（增量单任务同步场景仍有用），对账器与它规则一致（task_name/kebab/dynamic），不形成两套真相

## Discovered Issues

- 本次盘点发现「每日 issue 处理」任务 disabled 且 body 落后 2200+ 字符——本次一并自愈（disabled 覆盖决策），不另建 issue
- paper-trading-daily.md 缺 task_name 导致失联——本次顺手修（见「顺手修存量缺口」节），不另建 issue
