---
id: F20260825vrqh
title: Web 前端直观展示每只海獭所用模型
summary: |
  多模型路由已支持小獭创建时指定 modelAlias（mimo/kimi/glm），后端 agent 工具
  get_active_participants 已返回 modelAlias，但 Web 前端 UI 完全未展示。
  本特性打通后端 HTTP 链路（ParticipantDTO/OtterDTO 补 modelAlias）+ 前端展示
  （参与者卡片模型 badge + 详情弹窗模型字段），搭档可直观看到每只獭用什么模型。
change_type: feature
status: active
capability_test: "n/a: 纯 A 类 DTO 透传 + UI 渲染，无 LLM 参与行为"
created_in_conversation: f8bf2fbe-6da0-4861-8f48-9ccb27f50c07
---

# Web 前端直观展示每只海獭所用模型

## 背景与需求

### 问题描述

项目已支持多模型路由（F20260824cfgs model-identity-injection）：小獭创建时可指定 `modelAlias`，模型身份随 identityPrefix 注入 prompt，agent 工具 `get_active_participants` 已返回 `modelAlias`。但 **Web 前端 UI 完全看不到**每只海獭用什么模型——搭档想直观确认「这只獭是 mimo 还是 kimi」只能查库。

### 方案选择

后端补 HTTP 链路 + 前端展示，一个 PR 交付。全链路**可选字段**（向后兼容，无破坏性变更）：`modelAlias` 未配置（大獭、老数据、默认模型）时前端不渲染，不留空占位。展示原始 alias 字符串（如 `mimo`），不做中文昵称映射。

技术域拍板（大獭）：全链路可选字段、无破坏性变更。

## 方案设计

### 后端链路（4 处断点）

1. **`ManageParticipant.getActiveParticipants`**（src/usecases/conversation/manage-participant.ts）：构造器加可选第三参 `configProvider?: OtterConfigProvider`，从 `configProvider.getConfig(otterId)?.modelAlias` 读取，写入 `ParticipantWithOtter.modelAlias`
2. **`toParticipantDTO`**（src/interface-adapters/http/dto/conversation-dto.ts）：extra 加 `modelAlias`，`!== undefined` 才透传（缺省不返回 key）
3. **契约 `ParticipantDTO`**（api-contract/api/conversation.ts）：加可选字段 `modelAlias?: string`（注释风格同 otterType）
4. **`OtterDTO` 链路**（api-contract/api/otter.ts + src/interface-adapters/http/dto/otter-dto.ts + otter-controller.ts）：`toOtterDTO(otter, modelAlias?)` 可选第二参；`OtterController` 注入可选 `configProvider`，getById/create 两处读 modelAlias

### DI 组装

- `initUseCases`（src/bootstrap/usecases.ts）：`UseCaseDeps` 加可选 `otterConfigProvider`，传入 `ManageParticipant`
- `initControllers`（src/bootstrap/controllers.ts）：`ControllerDeps` 加 `otterConfigProvider`，传入 `OtterController`
- `src/app.ts`：`initDatabaseAndModels` 返回的现成 `otterConfigProvider` 实例透传给两处

### 前端链路（3 处断点）

5. **`LocalOtter`**（web/src/lib/mappers.ts）加 `modelAlias?: string`；`mapParticipantDTO` / `mapOtterDTO` 均 `!== undefined` 才映射
6. **参与者卡片 `OtterParticipantCard`**（web/src/pages/conversation/RightPanel.tsx）：模型 badge 放「大獭」badge 左侧，同 `text-[9px] font-semibold px-2 py-0.5 rounded-full` 视觉权重，色调用 stone 系（`bg-stone-400/15 text-stone-500`）与大獭 otter 色系区分
7. **详情弹窗 `OtterDetailModal`**（web/src/pages/conversation/Modals.tsx）：「角色」字段后加「模型」字段，样式同现有 `text-[10px] font-semibold uppercase tracking-wider` 标签行；`modelAlias` 为 undefined 时不渲染

### 不改的东西（边界）

- 不改 modelAlias 的写入/路由逻辑（F20260824cfgs 已有）
- 不动 OtterAvatar（纯头像组件无文字位）
- 不做模型中文名映射
- 不涉及 SSE 事件链路（参与者列表走 HTTP GET，卡片渲染随 otters prop 刷新）

## 影响范围

- 契约：api-contract/api/conversation.ts、api-contract/api/otter.ts（各 +1 可选字段，向后兼容）
- 后端：manage-participant.ts、conversation-dto.ts、otter-dto.ts、conversation-controller.ts、otter-controller.ts、bootstrap/{usecases,controllers}.ts、app.ts
- 前端：mappers.ts、RightPanel.tsx、Modals.tsx
- 测试：tests/usecases/conversation/manage-participant.test.ts（+2）、tests/api/conversation.test.ts（+1）、tests/api/otter.test.ts（+1）、tests/api/helpers.ts（TestDeps 加可选字段）、web/src/lib/mappers.test.ts（+4）、web/src/pages/conversation/RightPanel.test.tsx（+3）
- 共享资源边界：契约只加可选字段，存量客户端（飞书等）不受影响

## 取舍

- **controller 直接读 configProvider 而非下沉到 QueryOtter usecase**：QueryOtter 返回的是实体 Otter（domain 层无 modelAlias 概念），modelAlias 是配置层关注点。在 DTO 组装边界（controller）读配置注入 DTO，不污染领域模型。代价是 controller 多一个依赖（构造器 6 参，eslint-disable max-params，同 message-controller 先例）。
- **模型 badge 用 stone 系而非 otter 系**：与「大獭」badge 形成视觉区分（身份标签 vs 配置标签），避免同色系争抢视觉。
- **卡片 badge 放右侧栏而非 meta 行**：右侧栏是现有 badge 位（大獭/解散按钮），meta 行（第N世·时间）是纯文本信息行，混排会破坏行高一致性。

## 验证

- [x] 后端全量测试 1574 通过（含新增 4 个：usecase modelAlias 透传/缺省 ×2、participants API 透传+缺省、otter API 透传+缺省）
- [x] 前端全量测试 156 通过（含新增 7 个：mappers 映射/缺省 ×4、卡片 badge 渲染/不渲染/与大獭共存 ×3）
- [x] `npm run lint` 干净、`npm run build` + `web npm run build` 通过
- [ ] CI 绿（推 PR 后 gh run watch 确认）
