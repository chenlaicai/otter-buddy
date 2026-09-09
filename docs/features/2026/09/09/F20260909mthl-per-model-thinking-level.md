---
id: F20260909mthl
title: 每模型思考深度配置（thinkingLevel）
summary: ModelConfig 新增 thinkingLevel 字段（minimal/low/medium/high/xhigh/max），config.yaml 按模型 alias 配置；每次 invoke 创建 session 后调 SDK setThinkingLevel 生效，档位经 SDK thinkingLevelMap clamp 到模型实际支持档（如 kimi k3 支持 low/high/max）。未配置保持 SDK 默认 off（现状行为不变）。
change_type: feature
capability_test: "n/a: 纯机制层参数透传（config→ModelPool→setThinkingLevel），无可采样对话行为断言点；档位实际效果由 LLM 端点行为决定，单测覆盖配置校验与 ModelPool 查询语义"
created_in_conversation: b1179f8f-5d43-4c97-b9a7-b4e046c23599
tags: [llm, config, models-factory, thinking, agent-session]
intent:
  problem: "kimi k3 等推理模型的思考深度完全由端点默认决定（SDK agent 链路默认 thinkingLevel=off），海獭无法按模型配置推理档位——简单问答和复杂排查用同一深度，要么浪费要么不够想"
  expected_effect: "config.yaml 给某模型 alias 配 thinkingLevel 后，该模型所有 session 以该档位运行；配置非法档位时启动即报错；配置模型不支持的档位时 SDK clamp 并打 info 日志可观测"
  verify_by:
    type: behavior_check
    detail: "config.yaml 配 thinkingLevel: high 后重启，日志出现 'Thinking level applied'（debug）或 'clamped'（info）；配非法值（如 turbo）启动报配置校验失败"
modules:
  - src/frameworks/config-service.ts
  - src/frameworks/llm/model-pool.ts
  - src/frameworks/agent/pi-session-factory.ts
  - tests/frameworks/config-service.test.ts
  - tests/frameworks/llm/model-pool.test.ts
---

# F20260909mthl 每模型思考深度配置（thinkingLevel）

## 背景

搭档体感「kimi k3 回复特别快」，排查（2026-09-09 本会话）发现：otter 整条链路没向 LLM 发任何推理档位参数——`ModelConfig` 无此字段，pi-coding-agent SDK 的 agent 状态 `thinkingLevel` 默认 `"off"`（pi-agent-core/dist/agent.js:32），即 k3 全程不做显式推理。

搭档拍板：做成每个 model 的属性配置；**只留思考深度，不做温度**——调研发现 SDK anthropic-messages 适配器在 thinking 开启时静默丢弃 temperature（`anthropic-messages.js:774`，前置条件 `!options?.thinkingEnabled`），k3/mimo/glm 全是 reasoning 模型，两者互斥，引入温度配置会埋「配了不生效」的坑。

## 方案

三层透传，改动最小化：

1. **config-service.ts**：`ModelConfig` + RawConfig 增 `thinkingLevel?: ThinkingLevel`；`validateModels` 做枚举校验（minimal/low/medium/high/xhigh/max，非法值启动报错）；`applyDefaults` 透传。
2. **model-pool.ts**：`ModelPool.getThinkingLevel(alias)`——alias 缺省回退默认模型；未知 alias 返回 undefined（不回退，避免覆盖「未配置」语义）。
3. **pi-session-factory.ts**：`_createSessionWithTools` 在 `createAgentSession` 返回后调 `session.setThinkingLevel(configuredLevel)`。session 每次 invoke 重建（不持久化），故每次创建后都设。

## 关键设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 档位 clamp 谁做 | SDK（setThinkingLevel 内部） | SDK 有完整 clamp 链（getSupportedThinkingLevels → clampThinkingLevel，先向上再向下），otter 层重复实现只会漂移 |
| 非 reasoning 模型配了档位 | 安全 no-op | available=["off"]，clamp 到 off，不报错 |
| clamp 发生时可观测性 | info 日志（applied !== configured） | 配置与模型能力不一致是运维信号，不该静默 |
| 映射为 null 的档位（如 k3 的 medium） | SDK 侧不发给端点 | thinkingLevelMap 为 null 的档位被 getSupportedThinkingLevels 过滤，clamp 自动避开 |
| 温度 | 不实现 | thinking 开启时 SDK 丢弃 temperature（见背景节）；搭档拍板砍 |

## 验证

- `npx tsc --noEmit` 通过
- 全量测试 3122 通过（新增 7：config 校验 3 + ModelPool 查询 4）
- 已过最简检查：机制完全复用 SDK setThinkingLevel/clamp 链，otter 层只做「配置读取 + 一次 setter 调用」；无新增依赖
- 现状兼容：config.yaml 未配任何 thinkingLevel → getThinkingLevel 返回 undefined → 不调 setThinkingLevel → 行为与改动前完全一致

## 运营项（合入后）

config.yaml（非 git 追踪）可按需给 kimi 配 `thinkingLevel: high`（k3 支持 low/high/max 三档，其余档映射 null 会被 clamp）。本次未改搭档本地 config——开不开档、开哪档由搭档实测体感决定。
