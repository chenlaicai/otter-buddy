---
id: F20260824dhck
title: 每日健康检查产出前数据源引用清单（硬门禁）
summary: |
  落地 kimi-分析獭-v2 对 issue #352 的建议：每日健康检查产出日报/issue 前必须列示数据源引用清单，
  漏一项不许产出。方案选择"prompt 模板 git 化 + DB 运行时副本"而非新建 daily-health-check skill：
  定时任务由 create_scheduled_task 机制直接触发（不经过 skill 路由），skill 触发链对它无效；
  而散落在 DB 里的 prompt 无法走 PR 评审——这正是 #352 的教训之一。
  新增 prompts/scheduled/ 模板目录（真相源在 git）+ scripts/update-scheduled-task-body.mjs 更新脚本，
  数据源从 3 项扩到 5 项（补 self-healing events、memory），并固化 #352 的调查纪律。
change_type: feature
status: active
capability_test: "n/a: 定时任务 prompt 模板 + 运维脚本，无 LLM 参与的行为变更（LLM 行为由 prompt 内容引导，效果观察走 #352 关闭条件：观察 2 周）"
created_in_conversation: 1030241b-4ef2-46f2-99d3-82ae34cd1f66
tags:
  - scheduled-task
  - prompt
  - daily-review
  - claim-before-verify
  - observability
modules:
  - prompts/scheduled/daily-health-check.md
  - scripts/update-scheduled-task-body.mjs
---

# 每日健康检查产出前数据源引用清单（硬门禁）

## 背景与需求

### 问题描述

issue #352 记录了大獭在 2026-08-20 健康检查中的 claim-before-verify 模式——先推测故事再找数据佐证、
虚空猜测数字与因果、错误声明能力边界（"无法跨对话查询"）、草率处置（"分析类不需要PR"）。

kimi-分析獭-v2 的建议（issue #352 评论）：

> ✅ 每日健康检查 skill 流程硬编码（推荐）：产出日报前必须列示数据源引用清单，漏一项不许产出。
> 把"先收集再归纳"从 prompt 软约束变成流程硬约束

PR #356 已完成 SYSTEM.md 层修复（A1 调查方法论 / A2 能力边界 / R2 issue 处理规范，本 PR 同批修复其 CI）。
本特性解决剩余部分：健康检查的执行流程约束。

### 方案评估

| 方案 | 结论 | 理由 |
|------|------|------|
| A. 新建 daily-health-check skill | 否决 | skill 路由只对"对话中 LLM 判断任务类型"有效；每日健康检查由定时任务（`0 9 * * *`）直接触发，`create_scheduled_task` 的 body 直接注入被唤醒海獭，**不经过 skill 路由链**——skill 写了也没人读 |
| B. SYSTEM.md 加规则 | 否决 | SYSTEM.md 是全局 SDK base（8KB / 2000 token 预算敏感），为单一场景加流程规则挤占所有对话的上下文；且定时任务场景已有专用载体（task body） |
| **C. prompt 模板 git 化 + DB 运行时副本** | **采纳** | 定时任务 body 的真相源移到 git 仓库（`prompts/scheduled/`），DB 只是运行时副本。修复散落在 DB 里无法评审的根本问题——"prompt 层修复散落在 DB 里"正是 #352 遗留的隐性缺陷 |

方案 C 的关键洞察：现行任务 body 里已有 3 项数据源清单（#337 修复后加的），但它是软约束——
LLM 收到 body 后自行决定执行强度，没有产出前的强制自查。本方案把清单从"任务描述"升级为
"产出前硬门禁"（逐项自查 + 漏一项不许产出），并扩展数据源覆盖。

## 方案设计

### 产出前检查清单（硬门禁）核心段落

任务 body 中新增：

```
## 产出前检查清单（硬门禁）

产出日报/issue 前，必须先列示数据源引用清单并逐项自查——漏一项不许产出：

[ ] 1. 对话历史 — 已查/发现：…
[ ] 2. GitHub issues — 已查/发现：…
[ ] 3. GitHub PRs — 已查/发现：…
[ ] 4. self-healing events — 已查/发现：…
[ ] 5. memory — 已查/发现：…

每项"发现"注明具体来源（issue 编号/对话 ID/事件 ID），无法定位的数据不上报。
清单全部勾选后才写分析结论。
```

数据源从 3 项扩到 5 项，新增：

- **self-healing events**：#352 案发现场中 otterId 字段曾用于纠正"6 只小獭→实际 4 只"的虚空猜测
- **memory**（跨对话检索）：#352 第三轮"声称无法跨对话查询"被搭档纠正——memory + healing events 可以覆盖

同时固化三条分析纪律（对应 #352 根因 1-3）：

1. 先收集数据再归纳结论，禁止先推测故事再找佐证
2. 不确定的因果不写——时间相邻 ≠ 因果
3. 能力边界先测试再声明

### 文件变更

| 文件 | 变更 |
|------|------|
| `prompts/scheduled/daily-health-check.md` | 新增：任务 body 的 git 真相源（frontmatter 带 task_name 便于脚本匹配） |
| `scripts/update-scheduled-task-body.mjs` | 新增：模板 → DB 同步脚本。按任务名匹配 active 任务，支持 `--dry-run` / `--db <path>`；CI 无 DB 时跳过 |

### 部署

`node scripts/update-scheduled-task-body.mjs --name "每日对话健康检查"` 已在本地主仓 DB 执行，
任务 `b7b6639f-5b3f-4f36-9606-c574d61caa88` 的 body 已更新（含硬门禁段落）。明早 09:00 触发即生效。

## 验证

- 脚本 dry-run 与实跑均通过，DB 中 body 长度 543 → 1444，含"产出前检查清单（硬门禁）"段落
- 后续观察：#352 建议的关闭条件（PR #356 合入后观察 2 周，不再出现被搭档逐条纠正的记录）覆盖本特性效果验证

## 影响范围

- 仅影响「每日对话健康检查」定时任务的执行 prompt，不触碰任何代码逻辑
- 其他定时任务（self-healing-analysis、依赖升级自动化）如需同等治理，复用同一脚本 + 模板目录即可

## 取舍

- **不做 skill**：见方案评估 A——触发链不通，做了是死代码
- **不进 SYSTEM.md**：见方案评估 B——上下文预算 + 场景专用载体已存在
- **不在 CI 里自动同步 DB**：CI 环境无 DB（也不该有），同步是部署动作（本地跑脚本），保持脚本幂等即可
- **模板目录命名为 prompts/scheduled/**：与 prompts/skills/ 平行，语义为"定时任务 prompt 的真相源目录"
