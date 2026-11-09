---
id: F20261109apigc
title: 自定义 OpenAI 模型支持 Chat Completions 协议
summary: 修复自定义 OpenAI 网关被固定走 Responses 的问题。新增可选 apiFormat=chat，模型工厂选用 openAICompletionsApi，运行时沿用 Model.api；第三方 Chat 网关统一使用 system 角色。火山 APIG 六模型以 apig- 前缀接入本地配置。
change_type: fix
capability_test: "n/a：硬代码协议适配，验证=配置/工厂/运行时单元回归 + 真实 SDK 六模型行为检查；无 prompt 或技能场景"
intent:
  problem: "自定义 OpenAI provider 在 models-factory 与 ModelRuntimeRegistry 两层固定使用 Responses。火山 APIG 的 kimi-k3 在 Responses 下返回 messages cannot be empty，GLM 默认 off 思考档位报错，导致 API 本身可用但 Otter 无法选用。"
  solution: "ModelConfig 增加 apiFormat=responses|chat（缺省 responses），模型工厂同步选择 provider handler 与 Model.api，运行时注册直接沿用 Model.api；Chat 模型使用 system 角色，GLM 配置 low 思考档位。"
  expected_effect: "六个 apig- 模型均经 Otter 同款 SDK 返回 OK；未配置 apiFormat 的存量模型仍走 Responses，行为不变。"
  verify_by:
    type: behavior_check
    assertions:
      - "真实 initModels → completeSimple 链路：六个 apig- 模型 api 均为 openai-completions，stopReason=stop 且正文=OK"
      - "配置校验接受 openai+chat，拒绝非法值及非 OpenAI provider 上的 apiFormat"
      - "缺省 apiFormat 的自定义 OpenAI provider 仍注册 openai-responses"
created_in_conversation: 9d6ffef1-c9b2-48f9-b2ac-0751090f3ebf
created_at: 2026-11-09
tags: [llm, openai-completions, model-provider, apig]
modules: [src/frameworks/config-service.ts, src/frameworks/llm/models-factory.ts, src/frameworks/agent/model-runtime-registry.ts]
---

# 自定义 OpenAI 模型支持 Chat Completions 协议

## 背景与实证

搭档提供火山 APIG 聚合网关及六个模型，目标是能在 Otter 中直接选用，并统一以 `apig-` 前缀命名。

实测确认：

- API Key 有效，六模型直接 `POST /v1/chat/completions` 均返回 HTTP 200 与 `OK`。
- Otter 固定走 Responses：`kimi-k3` 返回 `messages cannot be empty`；换 `/v1/responses` 仍失败。
- Anthropic `/v1/compatible` 与 Otter 的鉴权/响应结构不兼容，不能作为替代路径。
- `glm-5.3` 不接受默认关闭思考；`glm-5.3-flash` 拒绝 OpenAI SDK 默认的 `developer` 角色（1214），接受 `system`。

因此问题在客户端协议适配，不在 API Key 或 Base URL。

## 设计取舍

- **模块切分**：配置层负责声明与校验；`models-factory` 负责协议选择；`model-runtime-registry` 只沿用已解析的 `Model.api`，不再重复决策。
- **关键接口**：`ModelConfig.apiFormat?: "responses" | "chat"`，仅 `provider=openai` 可配，缺省 `responses`。
- **核心数据结构**：无 DB/持久化结构变化；`Model.api` 成为工厂到运行时的单一协议事实源。
- **被否替代**：仅更换 Base URL（实测无效）；走 Anthropic compatible（鉴权与响应结构不兼容）；新增一套独立 provider 类型（复用 SDK 已有 Completions handler 即可，无需扩张抽象）。
- **机制识别检查点**：未命中新守护、重试、状态机或持久化机制。新增字段是既有 provider 路由语义内补参，按 `narrow-fix` 处理。
- **确认**：搭档明确目标为「用上这些模型，统一 apig- 前缀」，并授权直接完成；上述接口取舍由大獭依据实测确定。

## 实现

1. `config-service.ts`：读取并保留 `apiFormat`；拒绝未知枚举、非 OpenAI provider、以及无自定义 Key/URL 的默认 provider 路径上的配置，避免静默失效。
2. `models-factory.ts`：
   - `chat` 时加载 `openAICompletionsApi()`，缺省仍加载 `openAIResponsesApi()`。
   - 字典模型和自定义注入模型的 `api` 同步切换，防止 provider 已切 Chat 而模型仍指向 Responses。
   - Chat 模型声明 `supportsDeveloperRole: false`，以 `system` 兼容第三方网关。
3. `model-runtime-registry.ts`：注册时使用 `model.api`，消除第二层写死 Responses 的覆盖。
4. `config.yaml.example`：补配置说明。
5. 本地 `config.yaml`（gitignored）：六个模型统一使用 `apig-deepseek-v4-pro`、`apig-deepseek-v4.1-flash`、`apig-glm-5.3`、`apig-glm-5.3-flash`、`apig-kimi-k3`、`apig-hy3`；GLM 两项 `thinkingLevel=low`。

## 兼容性 / 负面向验收

- 本次不破坏旧契约：未配置 `apiFormat` 的条目仍走 Responses；定向测试显式钉住缺省路径。
- 不绕过鉴权、重试、上下文或运行时保护；仅替换 SDK 请求协议 handler。
- 无历史配置迁移要求；只有显式写 `apiFormat` 的非 OpenAI 条目或默认 provider 条目会在启动时报错，避免用户误以为配置已生效。
- 本地旧 `volc-apig*` 测试别名由六个 `apig-*` 别名替换，无运行时数据迁移。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| Chat 六模型真实调用 | `initModels` 构建六个 `apig-*`，逐条 `completeSimple` 携带 system+user | 六条 `api=openai-completions`、`stopReason=stop`、正文 `OK` |
| 缺省兼容 | 自定义 OpenAI 条目不传 `apiFormat` 初始化 | provider 使用 `openai-responses` |
| 配置防呆 | 传入非法枚举或 anthropic+chat | 启动校验给出明确错误 |
| GLM 角色兼容 | GLM Flash 携带 system+user 经真实 SDK 调用 | 不再出现 1214，返回 `OK` |
| 本地模型选择 | 读取主仓本地 `config.yaml` | 存在六个唯一 `apig-` 别名，均为 chat |

## 验证记录

- 定向单元测试：74/74 通过（config-service 48、models-factory 25、model-runtime-registry 1）。
- 全量测试：441 个文件、5753/5753 条通过；`npm run check`、`lint:intent`、`lint:docs` 均通过（仅存量 warning）。
- 真实 SDK 行为检查（非 curl）：六个模型均返回 `stopReason=stop`、`text=OK`、`error=null`；GLM Flash 的 developer 角色问题已修复后复测通过。
- 真实工具调用检查：六模型均返回 `stopReason=toolUse`，调用 `echo({"text":"OK"})`，无协议错误。
- 本地配置读取：总计 14 个模型，其中 6 个 `apig-` 条目均为 `apiFormat=chat`，GLM 两项为 `thinkingLevel=low`。
- 最简检查：复用 SDK 已有 Completions handler，运行时直接沿用 `Model.api`；未新增 provider 类型、依赖、状态机或兼容桥。

## 影响面

- 影响自定义 OpenAI provider 的协议选择；存量默认 Responses 路径不变。
- API Key 仅写入 gitignored 本地配置，不进入提交。
