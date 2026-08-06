---
id: F20260806smr6
title: single-model-compat-removal
doc_type: feature

summary: |
  移除 LLM 配置的单模型兼容路径：llm.models[] 成为唯一配置方式，删除顶层 llm.provider/model/apiKey/apiBaseUrl 及其回填逻辑。
  动机：validateMultiModel 把 models[default] 双写回顶层字段，同一份配置两个真相源；initSingleModel 与 initMultiModel 双路径并存。
  机制：validate 强制 models[] 非空（单模型写为一条 models[] 条目），AppConfig.llm 只保留 default + models[]。

causal_links:
  from:
    - F20260806cnp6   # dead-code-cleanup（本 PR 叠于其分支之上）
    - F20260731-multi-model-routing   # 多模型路由引入时的双路径兼容设计，本次收编

status: development
change_type: refactor
tags: [config, llm, cleanup, incompatible]
modules:
  - src/frameworks/config-service.ts
  - src/frameworks/llm/models-factory.ts
  - src/bootstrap/database.ts
  - src/bootstrap/controllers.ts
  - config/config.yaml.example
  - README.md
  - README.en.md
  - tests/frameworks/config-service.test.ts
  - tests/frameworks/llm/models-factory.test.ts

created_at: 2026-08-06
---

# 单模型兼容路径移除

## 破坏性变更 [Incompatible]

`config.yaml` 的 `llm.provider` / `llm.model` / `llm.apiKey` / `llm.apiBaseUrl` 顶层字段不再被识别。
旧格式配置启动即报错：`llm.models[] 为必填字段`。
迁移方式：把顶层字段写为一条 `models[]` 条目（alias 自取，default 缺省取第一条）：

```yaml
# 旧（不再支持）
llm:
  provider: openai
  model: gpt-4o
  apiKey: sk-...

# 新
llm:
  models:
    - alias: default
      provider: openai
      model: gpt-4o
      apiKey: sk-...
```

本机 config.yaml 已是 models[] 格式，无迁移成本。README 双语的配置示例与 .env 迁移表已同步更新。

## 改动明细

| 位置 | 改动 |
|------|------|
| `config-service.ts` | `AppConfig.llm` 收窄为 `{ default: string; models: ModelConfig[] }`；`RawConfig.llm` 删顶层字段；`validate` 删单模型分支、强制 models[] 非空；`validateMultiModel` 更名 `validateModels` 并删除"为单模型兼容填充"的回填（provider/model/apiKey/apiBaseUrl 双写）；loadConfig 日志改记 defaultModel/modelCount |
| `models-factory.ts` | 删 `initSingleModel` 与 `isMultiModel` 分流，`initMultiModel` 更名 `initModelPool` 成为唯一路径；`loadProvider`/`needsCustomProvider` 参数从整个 llm 配置收窄为 `{ apiKey?, apiBaseUrl? }` |
| `bootstrap/database.ts` | `syncApiKeyToAgentAuth` 删单模型 else-if 分支（models[] 恒存在） |
| `bootstrap/controllers.ts` | `appConfig.llm.default ?? appConfig.llm.provider` → `appConfig.llm.default`（validate 保证非空） |
| `config.yaml.example` | 删"单模型模式（兼容旧格式）"注释段 |
| `README.md` / `README.en.md` | 最简配置示例改 models[] 格式；.env 迁移表字段改 `llm.models[]` |

## 与 PR #162 的关系

本 PR 叠在 F20260806cnp6（死代码清理）分支之上：#162 已删 pi-session-factory 的单模型 else 分支（`appConfig.llm` 的最后消费者），本 PR 删配置层根源。合并顺序：先 #162，本 PR 随后 retarget main。

## 验证

- `npx tsc --noEmit` 通过
- `npm run lint` 通过
- `npx vitest run`：86 文件 / 1051 测试全绿（config-service / models-factory 测试重写为 models[] 唯一格式）
