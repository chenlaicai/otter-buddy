---
id: F20260824skvg
title: 能力文本版本门
summary: |
  当 .pi/skills/ 目录下的文件被修改时，必须 bump prompts/skills/manifest.yaml 中的 version 字段。
  通过 pre-commit hook + CI 双保险机制实现，防止"改了能力文件但忘记标版本"。
change_type: feature
status: active
capability_test: "n/a: 纯脚本逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
---

# 能力文本版本门

## 背景与需求

### 问题描述

skill 能力文件（`.pi/skills/` 目录下的 SKILL.md 等）是 otter 行为的核心配置。当这些文件被修改但没有在 `prompts/skills/manifest.yaml` 中递增 version 字段时，出问题时无法归因是"哪版 prompt 导致的行为变化"。

### 设计意图

建立版本门机制：
- **pre-commit hook**：本地开发时，skill 文件改动必须 bump manifest version 才能提交
- **CI 集成**：PR 合入前，CI 再次检查，防止 `--no-verify` 绕过

## 方案设计

### 核心逻辑

`scripts/check-skill-version-bump.mjs` 脚本：

1. 获取变更文件列表（区分 pre-commit 和 CI 环境）
2. 检查是否有 `.pi/skills/` 目录下的改动
3. 如果有，检查 `prompts/skills/manifest.yaml` 的 version 字段是否递增
4. 未递增则阻断

### 环境区分

- **pre-commit**：使用 `git diff --cached` 获取 staged 文件
- **CI**：使用 `git diff origin/main...HEAD` 获取 PR 分支差异
- 通过 `CI=true` 或 `GITHUB_ACTIONS=true` 环境变量自动区分

### 集成点

1. `.githooks/pre-commit`：在 `npm run lint:skills` 之前执行
2. `.github/workflows/ci.yml`：在 "fast lint gates" 步骤中执行

## 验收标准

- [x] pre-commit 时，修改 `.pi/skills/` 下文件但未 bump version → 阻断
- [x] pre-commit 时，修改 `.pi/skills/` 下文件且 bump version → 通过
- [x] pre-commit 时，未修改 `.pi/skills/` 下文件 → 跳过
- [x] CI 时，PR 包含 skill 文件改动但未 bump version → 失败
- [x] CI 时，PR 包含 skill 文件改动且 bump version → 通过

## 参考

- Issue #379 候选项 ⑤
- tutu-vessel 蒸馏研究（R20260811rclo）启示
