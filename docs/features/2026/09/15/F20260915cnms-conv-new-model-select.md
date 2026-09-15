---
id: F20260915cnms
title: 新建对话选大獭模型
doc_type: feature

# 记忆索引
summary: |
  新建对话时支持选择大獭的模型，默认取配置文件默认模型。动机：kimi 周配额耗尽时，
  新建对话仍被钉死在配置文件默认模型上（原 NewConvModal 只传 title，大獭无模型自选），
  只能整 restart 才能换。本次在既有「有效模型一等化」链路上前移：DTO 补 modelAlias、
  controller 校验+透传、usecase 传给 CreateOtter（落 otter_configs.model_alias + 首世 session 快照），
  前端两个新建入口（conversation 页 NewConvModal + conversation-list 页内联 Modal）都加模型下拉，
  加载失败降级为不展示下拉（创建走服务端默认）。

# 因果链路
causal_links:
  from: ["F20260908efmd"]   # 有效模型一等化与 restart 切模型：model_alias 一等字段 + 首世建账快照
  to: []

# 元数据
change_type: feature
capability_test: "n/a: HTTP 契约与 UI 表单变更为主，无 LLM 行为变更；验证走 vitest 单测（usecase 透传/controller 校验/UI 下拉交互与降级）"
tags: [conversation, model-routing, web-ui, api-contract]
modules: [api-contract/api/conversation.ts, src/interface-adapters/http/controllers/conversation-controller.ts, src/usecases/conversation/manage-conversation.ts, src/bootstrap/controllers.ts, web/src/pages/conversation/Modals.tsx, web/src/pages/conversation/index.tsx, web/src/pages/conversation-list/index.tsx]

# 时间
created_at: 2026-09-15
created_in_conversation: b70b3277-a318-4a66-973e-af1cb3ed526d
---

# 新建对话选大獭模型

## 背景

搭档原话（意图锚）：
「新建对话时，现在是填写标题，然后下方有一个固定的大獭；下方这个大獭无意义、因为本来大獭就是固定在的
但这几天由于kimi无额度了，而新建对话又固定了大獭的模型（读配置文件）。所以我想要在新建对话 能够选择 大獭的模型。当然，默认就是配置文件这个」

现状（2026-09-15 实测代码）：
- `NewConvModal`（web/src/pages/conversation/Modals.tsx）只收集 title，下方「参与 Otter」区仅静态文本「大獭 (默认)」——无信息量（大獭恒在场，见 F20260716ttf7）
- `CreateConversationRequestDTO` 无 modelAlias 字段，HTTP 契约层断链
- 后端 `ManageConversation.create` 调 `CreateOtter.execute({ name: "大獭", type: "big" })` 不传 modelAlias——大獭配置层走默认模型
- conversation-list 页（空列表态/常规态）各有一个内联新建 Modal，同样只传 title

既有能力（不重复建设）：
- F20260908efmd 已把 model_alias 做成 otter_configs 一等字段，`CreateOtterInput.modelAlias` 可选、
  首世建账快照有效模型（`resolveModelForFirstSession`）
- F20260827ucrt 已为 UI 入口建了 modelAlias 校验先例：otter-controller + ModelPoolLike 可选注入（400 附可用列表）
- 前端已有两处模型下拉模式可复用：CreateOtterModal（defaultModelAlias 默认选中）与 RestartModal（空串=不换模型）

## 方案设计

链路四层打通，全部复用既有管道，不新增机制：

1. **HTTP 契约**：`CreateConversationRequestDTO` 补 `modelAlias?: string`（缺省 = 配置文件默认模型）
2. **Controller 校验+透传**：conversation-controller 可选注入 ModelPoolLike，与 otter-controller.create 同款校验
   （`[错误] 未知的模型别名「X」。可用模型：...` 400）+ 透传。bootstrap/controllers.ts 装配追加 modelPool
3. **Usecase 透传**：`CreateConversationInput.modelAlias` → `CreateOtter.execute({ name: "大獭", type: "big", modelAlias })`。
   下游自动生效：otter_configs.model_alias 落库 + 首世 session 快照有效模型 + 参与者卡片模型 badge 正确展示
4. **前端两入口**：conversation 页 NewConvModal + conversation-list 页两处内联 Modal，均加「大獭模型」下拉
   （数据源 GET /api/settings，默认选中 defaultModelAlias，标注「（默认）」）。加载失败降级：不渲染下拉，
   创建请求不下发 modelAlias（服务端走默认模型），不阻断创建流程

### 交互细节

- NewConvModal 的「参与 Otter」区升级：大獭头像（OtterAvatar type="big"）+ 名称 + 模型下拉，原无信息量的
  「大獭 (默认)」文本仅在降级时兜底展示
- 下拉提示文案：「默认取配置文件；某家配额耗尽时可在此换模型」——与动机场景呼应
- conversation-list 页每次打开弹窗重新拉 settings（默认模型可能已被切换，不用陈旧缓存）
- onConfirmNewConv 签名 `(title: string)` → `(title: string, modelAlias?: string)`，空串转 undefined 不下发

## 变更清单

| 文件 | 变更 |
|------|------|
| api-contract/api/conversation.ts | DTO 补 modelAlias 可选字段 |
| src/usecases/conversation/manage-conversation.ts | CreateConversationInput.modelAlias + 透传给 CreateOtter |
| src/interface-adapters/http/controllers/conversation-controller.ts | ModelPoolLike 可选注入 + modelAlias 校验 + 透传 |
| src/bootstrap/controllers.ts | ConversationController 构造追加 modelPool |
| web/src/pages/conversation/Modals.tsx | NewConvModal 加模型下拉 + OtterAvatar 展示 + 降级 |
| web/src/pages/conversation/index.tsx | confirmNewConv 透传 modelAlias |
| web/src/pages/conversation-list/index.tsx | 两处内联 Modal 加模型下拉（打开时拉 settings） |
| tests/usecases/conversation/manage-conversation.test.ts | +3 断言：modelAlias 透传/缺省不下发/大獭参数 |
| web/src/pages/conversation/Modals.test.tsx | +3 用例：下拉默认选中/选中提交携带/降级不渲染 |

## 验证

- `npx vitest run tests/usecases/ tests/interface-adapters/`：120 files / 1411 tests 全绿（含新增）
- `npx vitest run`（web）：48 files / 426 tests 全绿（含新增 3 例）
- `npx tsc --noEmit` 主仓 + web 双端 0 error
- eslint 仅存量 warning（cost-output-collector no-console、index.tsx 660/894 exhaustive-deps，均非本次文件行）

### 最简实现检查

已过：DTO 补一个可选字段 + controller 校验一行复用 otter-controller 同款 + usecase 透传一行 +
前端下拉复用 CreateOtterModal 既有模式（getSettings 数据源 + 受控 select）。无新增依赖、无新增机制、
无兼容桥代码。9 文件 +206/-12。

## 取舍

- **校验放 controller 不放 usecase**：与 F20260827ucrt otter-controller 同层先例一致（settings-controller
  hasModel 同层），usecase 层 ModelPool 注入会引入组装复杂度；UI 入口统一在 controller 校验，大獭工具链
  不走此 controller 不受影响
- **降级展示「大獭 (默认)」而非空占位**：settings 拉取失败是异常路径，保住创建主流程比强制模型选择更重要
  （「有值才渲染、缺失如实省略」是展示语义，此处是功能降级，不冲突）
- **conversation-list 每次打开重拉 settings**：默认模型可能已切换（settings 页可改），缓存会导致默认选项过期

## 对旧特性的影响

无破坏性变更。F20260908efmd 的 model_alias 一等化管道原样复用；F20260827ucrt 的 controller 校验模式
原样复用。既有调用方（不带 modelAlias 的 POST /conversations）行为不变——字段可选，缺省走默认模型。
