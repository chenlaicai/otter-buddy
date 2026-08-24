---
id: F20260824cfgs
title: config.yaml 作为默认模型的唯一真相源
summary: |
  删除 applyDefaultModelOverride() 机制，让 config.yaml 的 llm.default 成为默认模型的唯一真相源。
  Settings API 切换默认模型时直接写 config.yaml（write-to-temp + rename），不再写 DB settings 表。
change_type: feature_update
status: active
capability_test: "n/a: 配置写入行为由单元测试覆盖（config-service.test.ts）"
created_in_conversation: 5dbd05ca-adfa-4f93-8f75-98d18e5c1564
tags:
  - settings
  - config
  - llm
  - model-routing
modules:
  - src/frameworks/config-service.ts
  - src/interface-adapters/http/controllers/settings-controller.ts
  - src/bootstrap/controllers.ts
  - src/bootstrap/database.ts
  - src/app.ts
  - src/usecases/settings/settings-keys.ts
  - tests/api/settings.test.ts
  - tests/frameworks/config-service.test.ts
---

# config.yaml 作为默认模型的唯一真相源

## 背景与需求

### 问题描述

config.yaml 的 `llm.default` 被 DB settings 表的 `llm.defaultModelAlias` 静默覆盖。用户改了 config.yaml 以为生效了，实际运行的是 DB 里的值。

现场数据：
- config.yaml 设置 `default: "glm"`
- settings 表有 `llm.defaultModelAlias: mimo`（2026-08-10 通过 API 写入）
- 实际运行的模型是 MiMo v2.5 Pro，用户以为是 GLM
- 只有启动日志里一条 info 级别的 `应用 settings 默认模型覆盖: mimo`，无其他提示

### 根因分析

`applyDefaultModelOverride()` 在启动时从 DB 读取 `llm.defaultModelAlias` 并覆盖 config.yaml 的默认值。这个设计让 DB settings 表成为"更高优先级"的真相源，与用户对"配置文件是真相源"的预期冲突。

## 设计方案

### 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 真相源选择 | config.yaml | 用户对配置文件的预期是"改了就生效" |
| API 写入目标 | config.yaml（而非 DB） | 保持真相源唯一性 |
| 写入模式 | write-to-temp + rename | 原子写入，避免进程崩溃导致配置损坏 |
| 注入方式 | 构造函数注入 writeDefaultModel | 遵守 Clean Architecture 层约束（interface-adapters 不能直接 import frameworks） |

### 改动范围

| 文件 | 改动 |
|------|------|
| `config-service.ts` | 新增 `updateDefaultModelInYaml()` 函数 |
| `settings-controller.ts` | 通过注入的 `writeDefaultModel` 回调写 config.yaml |
| `bootstrap/controllers.ts` | 注入 `updateDefaultModelInYaml` 到 SettingsController |
| `bootstrap/database.ts` | 删除 `applyDefaultModelOverride()` |
| `app.ts` | 移除旧的覆盖逻辑 |
| `settings-keys.ts` | 清理废弃的 `DEFAULT_MODEL_ALIAS_KEY` |
| `settings.test.ts` | 更新测试适配新行为 |
| `config-service.test.ts` | 新增 `updateDefaultModelInYaml` 单元测试 |

## 已知边界

1. **存量 DB 记录**：settings 表中的 `llm.defaultModelAlias` 记录将成为死数据，不影响功能但占用空间
2. **YAML 注释丢失**：`yaml.dump(yaml.load(...))` 会丢失 config.yaml 中的注释（#391）
3. **写入失败一致性**：文件写入失败时内存状态已更新但文件未更新，重启后 self-heal（#390）

## 关联

- PR: [#388](https://github.com/chenlaicai/otter-buddy/pull/388)
- Issue: [#390](https://github.com/chenlaicai/otter-buddy/issues/390) (写入失败一致性)
- Issue: [#391](https://github.com/chenlaicai/otter-buddy/issues/391) (YAML 注释丢失)
