---
id: F20260825sphg
title: 定时任务 prompt git 化治理
summary: |
  issue #416：把散落在 DB 的定时任务 prompt 迁移到 git 仓库作为真相源。三个任务全部治理完成：依赖升级自动化 + 每日 issue 处理迁入 prompts/scheduled/ 模板并同步 DB；self-healing-analysis 的静态文案从 scheduler-service.ts 硬编码提取为 dynamic 模板（{{HEALING_DATA}} 占位符运行时填充）。同步脚本新增 dynamic 模板防护 + 修复文件名直配分支不去 frontmatter 的 bug。
change_type: feature
status: active
capability_test: "n/a: 纯代码/模板变更，无 LLM 行为改动"
created_in_conversation: 725a3302-e1d4-4e3e-bd1f-5f40cf7f9f42
---

# 定时任务 prompt git 化治理

## 背景与需求

### 问题描述

issue #352 暴露的系统性问题：定时任务的 body（prompt）只存在 DB 里，没有 git 追踪——prompt 修改无法走 PR 评审、无法被其他獭审视、出问题没法回溯。PR #411 已治理「每日对话健康检查」，issue #416 要求治理剩余任务。

### 摸底发现（与 issue 描述的偏差）

- **依赖升级自动化、每日 issue 处理**：纯静态 prompt，直接迁移即可
- **self-healing-analysis 不是空壳**：DB 里的 `[self-healing-analysis]` 是调度器动态注入机制的标记（`resolveEffectiveBody`，scheduler-service.ts:347）。触发时 `buildHealingAnalysisBody` 用实时 healing 数据生成 prompt，无待处理事件时自动跳过。它的静态文案硬编码在 scheduler-service.ts 里——已在 git 追踪下，但改文案要改代码。

## 方案设计

### 总体思路

复用 PR #411 模式（`prompts/scheduled/` 模板 + 同步脚本），针对 self-healing-analysis 的动态特性引入 **dynamic 模板**类型：

| 任务 | 治理方式 | DB body |
|------|---------|---------|
| 依赖升级自动化 | 静态模板 → 脚本同步 DB | = 模板内容（frontmatter 后） |
| 每日 issue 处理 | 静态模板 → 脚本同步 DB | = 模板内容（frontmatter 后） |
| self-healing-analysis | **dynamic 模板**：静态文案进模板，`{{HEALING_DATA}}` 占位符由调度器运行时填充 | 保持 `[self-healing-analysis]` 占位符不变 |

### 详细设计

**1. 模板文件**（`prompts/scheduled/`）：

- `依赖升级自动化.md` / `每日-issue-处理.md`：frontmatter（`task_name`）+ 完整 prompt 静态文案
- `self-healing-analysis.md`：frontmatter 加 `dynamic: true` 标记，正文含 `{{HEALING_DATA}}` 占位符

**2. scheduler-service.ts**：

- 新增 `loadHealingTemplate()`：读模板文件、去 frontmatter，文件缺失返回 null
- `buildHealingAnalysisBody` 重构：动态数据拼成 `dataSection`，模板含占位符时 `replace('{{HEALING_DATA}}', dataSection)`；模板缺失或无占位符时回退内置文案（保证可用性）
- 导出 `HEALING_ANALYSIS_TEMPLATE_PATH` 常量

**3. 同步脚本 update-scheduled-task-body.mjs**：

- 新增 `isDynamicTemplate()`：frontmatter 含 `dynamic: true` 的模板跳过同步（exit 0，正常路径）——防止把占位符模板的静态文案覆盖进 DB，破坏调度器的动态注入
- **BugFix**：文件名直配分支（`kebab(任务名).md`）原本不去 frontmatter，导致同步后 DB body 头部带 `---\ntask_name: ...\n---`。daily-health-check 因中文名不匹配 kebab 规则、走的是扫描分支（有去 frontmatter）而侥幸未踩坑。本 PR 统一两分支行为

### 影响范围

- `src/usecases/scheduler/scheduler-service.ts`：`buildHealingAnalysisBody` 重构（行为兼容，产出 prompt 内容不变）
- `scripts/update-scheduled-task-body.mjs`：新增 dynamic 防护 + frontmatter bug 修复
- `prompts/scheduled/`：新增 3 个模板
- 生产 DB 已同步（依赖升级自动化 947 字节、每日 issue 处理 615 字节，与模板逐字节一致）

## 验证

- 新增 `tests/usecases/scheduler/healing-analysis-template.test.ts`（4 用例）：模板生效（body = 模板静态文案 + 动态数据）、无事件跳过、模板缺失回退、普通任务透传
- 全量测试 123 文件 1499 用例通过；lint 通过；tsc 通过
- 同步脚本 dry-run + 实写验证：两个静态模板 DB 与模板逐字节一致；dynamic 模板正确跳过（exit 0）

## 取舍

- **模板缺失回退内置文案 vs 直接报错**：选回退。healing 分析是自愈闭环的一环，模板缺失不该让任务彻底瘫痪；回退文案与模板内容保持一致（同步更新）
- **dynamic 模板用 frontmatter 标记 vs 文件内容含 `{{` 判断**：选 frontmatter。显式声明优于隐式推断，防止未来某静态模板恰好包含 `{{` 误判

## 后续

- 运行时 DB 副本与 git 模板的 drift 检测（如启动时比对告警）未做，留给后续需要时再加
