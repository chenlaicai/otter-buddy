---
id: F20261111menab
title: 模型配置启用开关
summary: 为 llm.models[] 增加 enabled 开关，让停用模型保留在 YAML 中但不进入运行时模型池；缺省保持启用，并校验默认模型与至少一个启用条目。
change_type: feature
created_at: 2026-11-11
created_in_conversation: 46b7a6af-b37c-47d7-bbdc-64dae9b6f24a
capability_test: "n/a: 纯配置解析与模型注册的确定性代码逻辑，无 LLM 参与行为"
doc_type: feature
tags: [config, llm, model-routing]
modules:
  - src/frameworks/config-service.ts
  - config/config.yaml.example
  - tests/frameworks/config-service.test.ts
intent:
  problem: "MiMo 额度耗尽后，删除配置会丢失连接参数，保留配置又会继续被海獭使用"
  expected_effect: "enabled: false 的模型保留在 YAML 但不进入 AppConfig 和 ModelPool；缺省配置行为不变，禁用默认模型或全部模型时启动明确报错"
  verify_by:
    type: behavior_check
---

# 模型配置启用开关

## 背景

搭档原话：「当前mimo都无token了，我也暂时不想续费，但我想保留config配置文件中的配置。所以我期望配置文件中可以加一个 启用与否的字段，然后可以先设置为false然后系统就不读取就行了（避免海獭用这个model）」。

现有 `config.yaml` 默认模型为 `kimi`，两个 MiMo 条目可独立停用，无需改默认模型。

## 目标

- T1：`llm.models[].enabled` 缺省为 `true`，未配置该字段且助理 alias 有效的现有配置无需迁移。
- T2：`enabled: false` 的条目保留在 YAML，但不进入 `AppConfig.llm.models`、模型池、设置页模型列表与 prompt 模型描述。
- T3：未指定默认模型时选择首个启用条目；默认条目被禁用或所有条目均被禁用时启动报错。

## 非目标

- 不增加设置页开关或运行时热更新；本特性只读启动配置。
- 不删除或改写现有模型连接参数，不处理供应商额度状态。
- 不改变既有 session 对未知 alias 回退默认模型的行为。

## 不兼容更新

`im.assistant.modelAlias` 指向不存在或已禁用的模型时，旧行为是正常启动并在运行时静默回退默认模型；新行为是启动校验直接报错。现网主仓配置未设置该字段，不受此变化影响。若升级后命中此错误，需将助理 alias 改为某个启用条目或移除该配置。

## 方案设计

配置层是唯一过滤点：`validateModels` 先校验所有条目的 `alias` 唯一性与 `enabled` 布尔类型，再只校验启用条目的连接参数；`applyDefaults` 仅投影启用条目。下游 `initModels` 与 `ModelPool` 无需新增分支，自然只注册、展示和描述启用模型。

关键接口仅为原始 YAML 字段 `llm.models[].enabled?: boolean`；内部 `ModelConfig` 不携带冗余的启用状态，因为其中只可能存在启用条目。核心数据结构、模块边界和运行时模型解析接口均不变。

被否替代：在 `initModelPool` 遍历处过滤。该位置过晚，禁用条目仍会进入 `AppConfig`、默认模型校验及测试注入的合成池，语义不一致。

## 设计取舍

机制识别检查点：命中「新增配置字段/开关」；其余状态生命周期、后台任务、消息格式、持久化、跨模块路径均不新增。修法决策树④，新增一个配置开关及配置投影过滤。

机制预算四问：

1. **谁需要它**：需要暂时停用供应商模型但保留连接配置的用户；间接受益者是新建或重启 session 的海獭，不会再拿到已停用模型。
2. **失败后果**：若开关失效，海獭继续调用无额度模型，用户看到供应商错误且当前对话无法推进；若错误过滤启用模型，则可用模型列表或默认模型错误，启动会失败或选择错误。
3. **后续机制**：可能出错的状态包括非布尔值、全部禁用、默认指向禁用项、禁用条目参数残缺；分别由类型校验、非空校验、默认 alias 校验和仅启用条目参数校验覆盖。未来若需运行时切换，必须另设配置写回与 session 影响方案，不在本特性内隐式支持。
4. **退役条件**：若模型配置迁出 YAML 并由另一套带启用状态的唯一真相源接管，且所有启动与测试注入路径完成迁移，则删除此字段及过滤逻辑；无固定到期日。

机制提案准入三问：①决策者不变，用户显式决定条目是否启用，系统只执行配置；②靠配置类型/默认值/非空机械校验与单元测试守卫；③用户可直接在 YAML 控制并观察启动错误与模型列表，无需深入运行时排查。P0 负面清单未命中。

前置重对抗审查（检视獭-模型开关方案）结论为通过，确认 `AppConfig.llm.models` 是模型池、设置页、prompt 描述、API Key 同步与运行注册的共同上游。三条建议的处置：

1. **接受并修订**：`im.assistant.modelAlias` 指向禁用或未知条目时启动即报错，避免静态助理配置静默回退默认模型。
2. **接受并补测**：增加「首条禁用且 default 缺省」用例，明确断言默认模型解析到首个启用条目。
3. **反驳，不扩大改动**：对话与已有 session 的「未知 alias」行为保持原契约。运行时模型池只含启用条目，若要在这些消费点区分「不存在/已禁用」，必须额外传递原始配置状态；这对本次停用需求无行为收益，且与最小单点过滤设计冲突。

## 验证

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 向后兼容 | 加载不含 `enabled` 的现有最小配置 | 模型仍启用并成为默认模型 |
| 禁用过滤与缺省默认 | 首条为 `enabled: false` 且未指定 default，后条启用 | `AppConfig.llm.models` 只含启用条目，默认解析到首个启用条目 |
| 默认模型保护 | `llm.default` 指向禁用条目 | 启动校验报「指向已禁用的模型条目」 |
| 助理模型保护 | `im.assistant.modelAlias` 指向禁用或未知条目 | 启动校验报「不存在或对应模型已禁用」 |
| 空池保护 | 所有条目均禁用 | 启动校验报「至少一个启用的模型条目」 |
| 类型保护 | `enabled` 使用非布尔值 | 启动校验报字段类型错误 |
| 全量别名查重 | 一个禁用条目与一个启用条目使用相同 alias | 启动仍报重复 alias，避免重新启用时出现影子冲突 |
| 停用条目跳过初始化 | 禁用条目仅保留 alias，缺 provider/model/handoffThresholdTokens | 配置可加载且运行时投影不包含该条目 |

已通过最简实现检查：复用现有配置校验和投影单一入口，下游模型池零新增过滤分支、零依赖、零持久化；新增的助理 alias 校验复用同一份启用模型集合语义，防止静默回退。

负向验收：不禁用条目时，既有配置加载、默认模型选择与模型字段投影保持不变；禁用条目不会再被模型注册、展示或选择，但 YAML 文件本体不被改写。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/config-service.ts | 修改 | 原始配置类型、启用条目校验与投影 |
| config/config.yaml.example | 修改 | 记录 enabled 缺省与禁用语义 |
| tests/frameworks/config-service.test.ts | 新增用例 | 覆盖过滤、默认回退及失败路径 |

## 验收结果

实现者自检（2026-11-11）：

- `npm test`：PASS，458 个测试文件、5888 个测试全部通过。
- `npm run build`：PASS；`npm run lint`：PASS；`npx tsc --noEmit`：PASS。
- `npm run smoke:boot`：PASS，全新库与存量库两种启动形态均通过。
- `npm run lint:intent` / `npm run lint:docs`：PASS（仅存量警告）。
- 真实配置加载：以主仓 `config/config.yaml` 调用构建后的 `loadConfig`，默认模型仍为 `kimi`，运行时 aliases 共 12 个且不含 `mimo-pro` / `mimo-flash`；原 YAML 中两个 MiMo 条目及连接字段均保留并标记 `enabled: false`。
- Golden Gate：n/a，纯配置解析与模型注册硬代码，无 prompt/skill 行为改动。
- 对抗审视：初轮 0 严重、2 建议；已补不兼容披露与跨启用状态 alias 查重测试，待 delta 复核。
