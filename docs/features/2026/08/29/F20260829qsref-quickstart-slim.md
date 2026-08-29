---
id: F20260829qsref
title: quickstart 瘦身——三步上手，贡献者内容移至进阶配置
summary: README quickstart 从5+步瘦身到3步（前置条件→配置→启动），贡献者向/进阶向内容（git hooks 验证、.env 迁移、多模态 input 声明）移至独立「进阶配置」章节，双语同步
date: 2026-08-29
change_type: feature-update
scope: [readme]
type: feature
status: draft
created_in_conversation: cb80d695-bce9-4b83-9f2a-98618242acd0
---

## Background

P1 star 战役目标：让外部用户 10 分钟内跑通 otter-buddy。当前 quickstart 有 5+ 步骤，中间夹杂贡献者向内容（git hooks 验证、.env 迁移表、多模态 input 声明），对新用户是噪音。`scripts/otter-buddy.sh start` 已具备一键安装+构建+启动能力，quickstart 未充分利用。

## Changes

### README quickstart 瘦身

原流程（5+步）：
1. 前置条件
2. 安装依赖（npm install × 2）+ git hooks 验证
3. 配置 + .env 迁移 + 多模态 input 声明
4. 构建前端
5. 启动系统 + 启动脚本详情

新流程（3步）：
1. 前置条件
2. 配置（cp config + 填 API key）
3. 启动（`./scripts/otter-buddy.sh start`，脚本自动完成安装+构建+启动）

### 移位内容（移位不删除）

以下内容从 quickstart 移至新增的「进阶配置」章节：
- 启动脚本详情（端口管理、多 worktree）
- 从 .env 迁移表
- 模型输入能力声明（多模态）
- 验证 git hooks
- 贡献者指南（→ CONTRIBUTING.md）

### 双语同步

README.md + README.en.md 同步修改，结构一致。

## Acceptance Criteria

- [ ] 主线步骤 ≤5 步（实际 3 步）
- [ ] 瘦身内容不丢失（进阶配置章节完整保留）
- [ ] 双语结构一致
