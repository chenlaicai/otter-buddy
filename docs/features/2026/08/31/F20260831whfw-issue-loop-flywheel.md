---
id: F20260831whfw
title: issue/healing 闭环飞轮：intake triage + backlog digest + 口径协议
summary: 四链模型（自愈链/系统改进链/特性链/排期链）补断环——每日任务加 Step 0 分流（bug 必修自决、增强呈决策、RHI 跳过）、语义级关闭检查、RHI 链看护、#600 处置权口径协议；新增周一 backlog digest 周任务（DB 配置，不在本 PR 文件内）
change_type: feature
capability_test: "n/a: 纯 prompt 配置改动无代码可测，生效验证为定时任务首次运行观察 Step 0 分流输出（9/1 10:30 每日处理）"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [scheduled-task, issue-loop, prompt, triage, self-healing]
modules: [prompts/scheduled/每日-issue-处理.md, prompts/scheduled/daily-health-check.md, prompts/scheduled/self-healing-analysis.md]
---

# issue/healing 闭环飞轮

## 背景与问题

搭档发现 open issue 持续堆积（60 条，无标签 23 + tech-debt 13 无消费端），且指出核心洞察：**RHI 式 issue 是特性对话的步骤记录，有自己的闭环，日常机制只该看护不该接管**。「本质还是需要闭环」。

大獭 + 飞轮獭（mimo）对撞分析，确认 6 个断环：①运行中产出消费真空（36 条）②PR 合入语义级漏网（#566）③healing 处置口径跨任务冲突（#600，每日复发）④RHI 特性链无超时看护（#405/406/407 挂 6 天）⑤搭档排期入口缺失 ⑥self-healing-analysis 生产端故障（consecutive_failures=1，另行处理）。

## 四链模型（设计核心）

issue 是状态载体不是待办清单，每条 issue 属于一条状态链，飞轮保证每条链有活着的驱动者 + 可达终态：

| 链 | 驱动者 | 终态 | 消费机制 |
|---|---|---|---|
| A 自愈链（healing events） | 定时任务 | resolve/dismiss | 9:00 健康检查 / 22:00 分析 |
| B 系统改进链（daily-review） | 定时任务 | 修复合入自动关 | 10:30 每日处理 |
| C 特性链（RHI 总纲+子issue） | 特性对话自身 | 对话内走完 | **跳过**，只看护 |
| D 排期链（tech-debt/enhancement） | 搭档 | 勾选后转处理 | 周一 backlog digest |

## 改动清单

### 1. 每日-issue-处理.md：Step 0 Intake Triage
- 输入域扩展：今天 daily-review + **昨天非 daily-review**（原红线只吃 daily-review，运行中产出真空）
- 四类分流：actionable（bug 必修/≤2 文件 tech-debt，**自决不请示**）/ enhancement（留周报呈决策）/ rhi-linked（跳过）/ unclear（评论求人工）
- 每天上限 3 条防爆量
- **分级授权**（搭档 8/31 原话）：「明确系统有问题/漏洞的，bugfix 必须修复；只有可有可无的功能，可能需要我来决策是否引入」——triage 第一问是「bug 还是增强」，不是「要不要问搭档」
- 自动关闭检查 1 升级语义级：扫近 7 天合入 PR 做语义匹配（#566 漏网案例）
- 新增 RHI 链看护：无更新 >7 天评论提醒，不代处理

### 2. daily-health-check.md：#600 口径协议（方案 B）
- 「需要修复」分支改为**证据快照后立即 resolve**——「留 open 等修复」废除，跟踪职责归 issue
- 处置权归属：首个消费事件的任务拥有处置权，后续任务不推翻

### 3. self-healing-analysis.md：前置处置权检查
- 处置 open 事件前先查是否已被 9:00 任务处置过口径（关联 issue），命中不推翻、存疑走 issue 评论

### 4. self-healing-analysis.md + scheduler-service.ts 回退文案同步

处置权检查同样写入代码内回退文案（HEALING_FALLBACK_PROMPT）——守卫测试 healing-analysis-template.test.ts 锁定双源同步，改模板必须同步改回退文案，否则 CI 挂（本次 rebase 后 CI 实测拦截，已同步修复）。这暴露一个设计事实：**self-healing 模板是双源维护**，后续改它必须两处同步。

### 5. backlog digest 周任务（create_scheduled_task 配置，不在本 PR）
- 周一 9:30，只读不改：全量 open 按四链分组（年龄+简评）呈搭档勾选本周处理项
- 搭档排期是产品决策权，只展示不代勾选（飞轮獭反方视角确认）

## 测试与自检

- `npx vitest run tests/usecases/scheduler/healing-analysis-template.test.ts` → 6 passed（含双源同步守卫，本次同步修复后全绿）
- prompt 文件其余部分无测试覆盖（纯 markdown 配置），验证方式为 3 个 task_name 与 DB scheduled_tasks.name 严格一致
- `grep -c "task_name" prompts/scheduled/*.md` 无重复声明
- 语义级关闭检查范围限定近 7 天 PR（成本控制，与搭档确认过边界）
- **pre-existing 声明**：无。CI 首次失败全部由本 PR 引入（PR 标题格式 + 双源不同步），修复均为本 PR 内变更，无需基线复跑证据

## 取舍

- **不建第三个每日任务**：每日处理与新增 intake 职责同构（每日触发→查列表→分流→处理），时间重叠会打架；扩展现有任务输入域更符合「每日 issue 处理」的语义
- **RHI 链不自动关闭**：C 链驱动者是特性对话，日常任务只提醒——方向盘还给特性对话
- **tech-debt stale 阈值放宽 30 天**：它们常等排期，14 天误杀
- **每日上限 3 条**：8/29 曾单日批量立项 13 条（RHI+微信），无上限会爆量
