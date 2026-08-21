---
id: F20260821lgts
title: lint-gates-wiring
doc_type: feature

summary: |
  把 lint:skills 与 lint:tool-manifest 两个既有校验脚本接线进 pre-commit hook 与 CI（#366 PR-2）。
  动机：脚本此前不挂任何 hook 或 CI，形同虚设（尽调 #19），且只挂 hook 会被绕过（#14 教训：纪律≠机制）。
  机制：pre-commit 追加两行 npm run；CI 在 npm ci 后、build 前新增独立 step。
  本档为 Wave 0 清理类共用薄档，PR-1（skills 页"建设中"标注）后续作为 Part B 补入。

causal_links:
  from:
    - F20260811sktp

status: implemented
change_type: feature
tags: [lint, ci, engineering-hygiene]
modules:
  - .githooks/pre-commit
  - .github/workflows/ci.yml
capability_test: "n/a: 纯工程接线（A 类），无 LLM 参与行为"
---

# F20260821lgts: lint-skills / lint-tool-manifest 接入 pre-commit + CI

## 背景与需求

### 问题描述

#366 尽调 #19（工程卫生）：`lint-skills` / `lint-tool-manifest` 两个校验脚本已存在于 `package.json` scripts，但不挂任何 hook 或 CI——依赖开发者手动运行，形同虚设。

### 根因分析

脚本产出（F20260811sktp、F20260820a4rt）只落在了脚本本身，没有接线到强制执行点。

### 数据实锤

- `package.json` 有 `lint:skills` / `lint:tool-manifest` 两个 script。
- `.githooks/pre-commit` 此前未包含它们。
- `.github/workflows/ci.yml` 此前未包含它们。

## 方案设计

### 技术方案

1. `.githooks/pre-commit` 在既有 lint 链（lint:docs / lint-capability-docs / lint-tests）之后追加 `npm run lint:skills` 与 `npm run lint:tool-manifest`。
2. `.github/workflows/ci.yml` 在 `npm ci` 之后、`npm run check` 之前新增 step「Run skills / tool-manifest lint gates」，执行同一对命令。两个脚本只读源文件与 manifest，不依赖 dist 构建，可前置获得快速反馈。
3. 以 CI 为准绳而非只挂 hook：`--no-verify` 可绕过本地 hook，CI 是不可绕过的机制层（#14 教训）。

### 目标

- T1: pre-commit 阻断 skill 契约 / tool manifest 违规提交。
- T2: CI 在 PR 上独立执行两个 lint，绕过本地 hook 也无法合入违规内容。

### 成功标准

- CI workflow 含 lint gate step，且在当前 main 内容上通过（警告不阻断，符合脚本既有语义）。

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 本地 hook 生效 | 在 pre-commit 接线后提交 | pre-commit 输出两个 lint 的通过信息 |
| AT-2 | CI 生效 | push 分支开 PR | CI workflow 出现 lint gate step 且绿 |

### 能力测试映射

无（纯工程接线，A 类）。

## 实现细节

### 代码修改

- `.githooks/pre-commit`：追加两行 lint 命令，带 F 编号注释。
- `.github/workflows/ci.yml`：新增「Run skills / tool-manifest lint gates」step。

### 逻辑变更

无行为变更；纯执行点接线。

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| .githooks/pre-commit | 修改 | 追加 lint:skills / lint:tool-manifest |
| .github/workflows/ci.yml | 修改 | 新增 lint gate CI step |

## 验收结果

### 测试结果

- 主仓当前内容：`npm run lint:skills` 通过（9 skills，7 warnings，警告不阻断）；`npm run lint:tool-manifest` 通过。
- CI 验证见本 PR checks。

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 hook 生效 | 本分支提交时 pre-commit 实际执行（见提交过程） | ✅ |
| T2 CI 生效 | PR CI checks 含 lint gate step 且通过 | ✅ |

## 设计决策

- lint gate step 放在 `npm run check` 之前：两脚本不依赖构建产物，前置可在 build 失败前先报契约违规，反馈更快。
- 不顺带把 lint:docs / lint-tests 等既有 hook 命令接进 CI：超出本 PR 范围（一个 PR 一件事），如需扩展另行立项。
