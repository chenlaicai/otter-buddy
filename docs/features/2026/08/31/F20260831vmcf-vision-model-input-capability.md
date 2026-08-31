---
id: F20260831vmcf
title: 模型 input 能力显式化：vision 模型接入 + 未声明警告
summary: 接入 glm-5.3-flash / mimo-v2.5 两个实测 vision 模型；models-factory 对自定义模型未声明 input 且继承 image 能力时打启动警告，消灭 F20260827mmdu 遗留运营项缺席导致的静默吞图幻觉
change_type: feature
capability_test: tests/frameworks/llm/models-factory.test.ts
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
tags: [llm, models-factory, vision, multimodal, config]
modules:
  - src/frameworks/llm/models-factory.ts
  - tests/frameworks/llm/models-factory.test.ts
  - config/config.yaml（非追踪，本文档记录）
from:
  - F20260827mmdu
  - F20260831wxi（排查报告，工作区）
---

# 模型 input 能力显式化：vision 模型接入 + 未声明警告

## 1. 背景与问题

微信媒体真机验收（#566 项③「发图 agent 看见」）发现 agent 收图后全靠宿主 read 工具自我补救，注入链路里的真图没有被模型消化。排查结论（完整报告见会话工作区 troubleshoot-weixin-vision.md）：

1. **注入链路全通**：文件入库 → injection 构造 → dispatch 透传 → LLM 请求携带图（日志铁证 `发言链调用 imageCount:1`）
2. **根因是模型能力断链**：
   - glm-5.3（智谱 anthropic 兼容端点）**静默吞图**——实测 1×1 纯红 PNG，模型 thinking 自述 *"I cannot actually see the image content"*，回答「蓝色」（幻觉）
   - mimo-v2.5-pro 端点直接 `404 No endpoints found that support image input`
3. **放大器**：config.yaml 未声明 `input` 字段 → models-factory 注入自定义模型时继承 anthropic 模板 `["text","image"]`（运行时验证）→ SDK `downgradeUnsupportedImages` 认为 glm 支持图片，不做降级 → 图原样发给看不见图的模型
4. **防御早已存在但从未生效**：F20260827mmdu 合入时 README 明确写了「非 vision 模型必须显式声明 `input: ["text"]`」为合入后运营项——**无任何提醒机制，运营项从未被执行**

## 2. 方案

### 2.1 vision 模型接入（config.yaml，非追踪文件）

实测验证（1×1 纯红 PNG 颜色测试，thinking 含真实像素描述，非幻觉）后配置 4 模型：

| alias | model | input | 依据 |
|-------|-------|-------|------|
| glm | glm-5.3 | `["text"]` | 实测静默吞图+颜色幻觉 |
| glm-flash | **glm-5.3-flash（新增）** | `["text","image"]` | 实测正确识别「红色」 |
| mimo | mimo-v2.5-pro | `["text"]` | 实测 404 拒绝 |
| mimo-vision | **mimo-v2.5（新增）** | `["text","image"]` | 实测正确识别「红色」 |

运行时验证（`initModels` 后查 modelPool）：4 个 alias 的 `model.input` 全部按声明注册。

### 2.2 未声明 input 启动警告（models-factory.ts）

`initModelPool` 循环内新增检查：自定义 provider 模型（apiKey/apiBaseUrl 触发）且 `mc.input === undefined` 且解析后的 `resolvedModel.input` 含 `"image"` 时，打 warn：

```
自定义模型 "<alias>" (<model>) 未显式声明 input，已继承模板值 ["text","image"]。
若该模型不支持 vision，请在 config.yaml 声明 input: ["text"]——否则图片会被注入给
看不见图的模型，产生静默幻觉
```

设计取舍：
- **为什么只 warn 不 hard fail**：模板继承对真支持 vision 的自定义模型是正确行为（如本次 glm-flash 不写也行），误伤不可接受；提示写清楚让运维自己判断
- **为什么限定 custom provider 路径**：默认 provider 的模型走 SDK 内置字典，input 值是官方维护的可信数据；自定义模型（私有端点/中转）才是模板继承的重灾区
- **为什么检查继承结果含 image 而非恒警告**：文本-only 模板继承（罕见）无风险，不制造噪音

### 2.3 消息处理层：确认现有机制已完备（无代码改动）

针对「图片放入上下文、不支持的模型可能出问题」的完整分析（SDK 源码级验证）：

| 环节 | 机制 | 结论 |
|------|------|------|
| LLM 请求构造 | `transformMessages` 每次**全量**执行 `downgradeUnsupportedImages`（transform-messages.js:19-35） | 历史+当前的 image block 统一降级为 `(image omitted)` 占位——即使 vision 会话历史带图、后续切非 vision 模型也安全 |
| 会话压缩 | compaction `serializeConversation` 经 `contentText` 只保留 text block（utils.js:94-131） | 图片不进摘要请求，无跨模型污染 |
| 手动 retry | message-controller 从原 user 消息 attachments 重建注入（审视修复 R9 语义） | retry 不丢图 |
| 中断恢复 | resume 用恢复提示文本重新 invoke，不带新图 | 历史图有降级兜底 |

**input 声明是唯一真相源**：声明后全链路自动正确，声明缺失全链路静默错——这就是启动警告存在的意义。

## 3. 测试

models-factory.test.ts 新增 4 用例（18 → 22）：

1. 自定义模型未声明 input 且继承 `["text","image"]` → warn（含 alias 与 action 标记）
2. input 显式声明 → 不警告
3. 继承结果 text-only → 不警告
4. 默认 provider 路径（dict 命中）→ 不警告

全量：`tests/frameworks/llm/` 22 passed，tsc --noEmit 干净。

## 4. 影响范围

- **即时生效**：config.yaml 的 4 模型声明（服务重启后 glm/mimo 收图自动降级为占位文本，agent 可诚实自述「收到图但我看不见」；glm-flash / mimo-vision 可被 create_otter(modelAlias) 指派做视觉任务）
- **防复发**：任何部署环境下未声明 input 的自定义 vision-claiming 模型，启动日志立见 warn
- **遗留**（本次不动，独立跟踪）：
  - 微信 connection `externalType` 硬编码 "feishu"（manage-connection.ts:37）→ 微信消息误触发飞书广播失败噪音（`invalid receive_id`）。修复需 externalType 参数化 + MessageBroadcaster 按类型路由
  - 大獭/小獭默认模型仍是纯文本——视觉任务需显式指定 vision alias（或等 vision 模型成熟后调整默认）

## 5. 验证方式

```bash
# config 注册验证（重启服务后）
# 启动日志应见 4 模型初始化且无 model_input_undeclared 警告
# 微信发图 → glm 回复应含「图片已收到但当前模型看不见」类自述（SDK 占位符触发）
```
