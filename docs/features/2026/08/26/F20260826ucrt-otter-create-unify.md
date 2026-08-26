---
id: F20260826ucrt
title: otter-create-unify
doc_type: feature

# 记忆索引
summary: |
  统一小獭创建双入口：UI 弹窗与大獭 create_otter 工具底层本就走同一 CreateOtter usecase，
  但 UI 入口停留在 mock 时代——模型选择断在 HTTP 契约层（CreateOtterRequestDTO 缺 modelAlias）、
  头像无自选能力（纯前端 hash）、能力选择/上下文注入是摆设控件、systemPrompt 是玩具模板、
  parentOtterId 由前端猜测。本方案补契约（modelAlias/avatar/parentOtterId 服务端解析）、
  重做 UI 表单（模型下拉+头像九宫格+prompt 编辑）、avatar 字段落 otters 表持久化。

# 因果链路
causal_links:
  from: []
  to: []

# 元数据
status: reviewed
change_type: feature
capability_test: "n/a: HTTP 契约与 UI 表单变更为主，无 LLM 行为变更；验证走 vitest 单测（契约透传/血缘解析/头像持久化/UI 交互）"
tags: [otter-creation, api-contract, web-ui, avatar, model-routing]
modules: [api-contract, src/usecases/otter, src/interface-adapters/http, src/frameworks/db, web/src]

# 时间
created_at: 2026-08-26
created_in_conversation: 60a89cc6-f61e-4e5c-a034-bb0570bf4735
---

# 统一小獭创建双入口（UI 与大獭工具链对齐）

## 背景

搭档原话（意图锚）：

> 「新建小獭中有几个问题，感觉没随着功能更新呀，比如说，选择模型、选择头像 等等，我觉得ui用户创建 和 大獭创建 只是 入口不同而已吧，底层应该是同一个功能」
> （核对差距清单后）「全做」

事实核查结论（2026-08-26）：

- 底层确实同源：UI `POST /api/otters` 与大獭 `create_otter` 工具最终都进 `CreateOtter.execute()`（`src/usecases/otter/create-otter.ts`），DB 写入、agent 创建、首世 session、失败回滚一份代码。
- 但两条入口能力演进严重不对称：

| 维度 | 大獭工具链 | UI 弹窗（现状） |
|------|-----------|----------------|
| 模型选择 | `modelAlias` + `modelPool.hasModel` 校验 | 无。**且 `CreateOtterRequestDTO`（`api-contract/api/otter.ts:28`）没有 modelAlias 字段，controller（`otter-controller.ts:42`）不透传——契约层断裂** |
| 头像 | 九款像素池按 otterId hash 自动分配（`web/src/lib/otter-avatars.ts`） | 同左（前端自动），无自选；avatar 不落库 |
| systemPrompt | 大獭精心编写 | 前端拼玩具模板 `你是X，角色：Y。职责：...`（`web/src/pages/conversation/index.tsx:1157`） |
| 能力/skill 选择 | 按 prompt 承载 | `mockSkills` 假 checkbox（`Modals.tsx:12`），勾选不生效 |
| 上下文注入 | 大獭检索后注入 prompt | 摆设 textarea，未接 state |
| 父獭血缘 | 系统注入 parentOtterId（BOUNDARY 不可伪造） | 前端猜 `convOtters[0]`，多獭在场时不可靠 |
| 重名检查 | 在场同名拒绝 | 无，靠服务端 500 |

## 目标

- T1: HTTP 契约补齐——`CreateOtterRequestDTO` 增加 `modelAlias`、`avatar` 可选字段；controller 透传到 usecase。
- T2: 头像自选能力——`avatar` 持久化到 `otters` 表；小獭默认仍走 hash 分配，选了就固定。
- T3: UI 表单重做——模型下拉（数据源 `GET /api/settings` 的 `models[]` + `defaultModelAlias`）、头像九宫格自选（含"随机"默认项）、删除 mockSkills 和上下文注入两个摆设控件、systemPrompt 可视化编辑（三段式：一句话身份 + 职责 + 可选自由编辑）。
- T4: 血缘修正——`parentOtterId` 由服务端按对话内 type='big' 的参与者解析，前端不再猜测；前端显式传值时拒绝（防伪造血缘，与大獭工具链 BOUNDARY 对齐）。
- T5: 重名预检——UI 提交前用 `get_active_participants` 对应的 HTTP 端点（`GET /api/conversations/:id/participants`）做前端预检，服务端 usecase 层兜底。

## 非目标

- 不改大獭 `create_otter` 工具的行为（工具链没有上述缺口）。
- 不做头像上传/自定义绘制——只开放现有九款池选择（`web/public/avatars/` 资产不变）。
- 不做 skill 系统的真接线（skill 勾选 → 注入 prompt 是另一个特性的范围，本方案直接删摆设控件，避免假功能误导用户）。
- 不改 `otter_configs` 表结构——`modelAlias` 真相源已在 `otter_configs`（`sqlite-otter-config-provider.ts`），本方案只补 UI 入口到 usecase 的通路。

## 方案设计

### 模块总览

```
api-contract/api/otter.ts          T1: CreateOtterRequestDTO + modelAlias?, avatar?
src/usecases/otter/create-otter.ts T1/T4: input 加字段；parentOtterId 服务端解析
src/interface-adapters/http/
  controllers/otter-controller.ts  T1: 透传 conversationId + modelAlias/avatar 校验（血缘已上收 usecase）
src/entities/otter/otter.ts        T2: Otter 实体加 avatar?: string | null
src/frameworks/db/schema.ts        T2: otters 表加 avatar 列（幂等 ALTER）
src/frameworks/db/otter/
  sqlite-otter-repository.ts       T2: createOtter/getById 读写 avatar
src/interface-adapters/http/
  dto/otter-dto.ts                 T2: OtterDTO + avatar
web/src/api/client.ts              T1: CreateOtterRequestDTO 类型（来自 @contract）
web/src/lib/otter-avatars.ts      T2: getOtterAvatar 优先 avatar 字段，缺省 hash 池
web/src/lib/mappers.ts             T2: mapOtterDTO/participant → avatar 透传
web/src/pages/conversation/
  Modals.tsx                       T3: CreateOtterModal 重做
  index.tsx                        T3/T4: confirmCreateOtter 重写（prompt 组装 + 血缘交服务端）
```

### A. 契约补齐（T1）

`CreateOtterRequestDTO`（`api-contract/api/otter.ts`）新增：

```ts
/** 模型别名（可选，须为 config.yaml models[] 合法 alias；缺省用默认模型） */
modelAlias?: string;
/** 头像资源名（可选，九款池之一如 "otter-03-zhujie"；缺省按 otterId hash 分配） */
avatar?: string;
```

controller `create()`：body.modelAlias → input.modelAlias，body.avatar → input.avatar。
校验放 controller（与 settings-controller 的 `hasModel` 同层）：非法 alias 返回 400 并列出可用列表（复用 `modelPool.describeModels()`），错误文案与大獭工具链（`tool-factory.ts:236`）保持同一措辞风格「[错误] 未知的模型别名」。

`CreateOtterInput` 已有 `modelAlias`（usecase 层已支持，只是 HTTP 层断），新增 `avatar?: string`。

**avatar 值域**：存资源名（`otter-03-zhujie`）不存完整 URL——UI 前缀 `/avatars/` 由渲染层拼，DB 不存部署路径。服务端校验白名单（九款池数组下沉到 `api-contract` 或 src 侧共享常量，避免两端各写一份）。非法值 400。

### B. 头像持久化（T2）

- `otters` 表加 `avatar TEXT` 列——`schema.ts` 用项目既有幂等模式（参照 F20260824ax376 healing_events 先例，`try { ALTER } catch {}`）。
- `Otter` 实体加 `avatar: string | null`；`createOtter` INSERT 带 avatar，`getById` SELECT 读回。
- `toOtterDTO` 透传 avatar（null 时不下发字段——与 modelAlias 缺省不返回的既有约定一致）。
- **消费方声明（issue #379 ⑥）**：avatar 的消费者是 web 渲染链 `ParticipantDTO/OtterDTO → mappers.ts → otter-avatars.ts getOtterAvatar(otterId, type, avatar?)`——有 avatar 用 avatar，无 avatar 落 hash 池。旧数据全部无 avatar → 行为不变（hash 池兼容回退），零迁移成本。
- 头像面板（`OtterProfileCard`）同样读 avatar 字段展示。

### C. usecase 层血缘与重名（T4/T5）

`CreateOtter.execute()` 增强（`src/usecases/otter/create-otter.ts`）：

**依赖注入**（审视发现 1/2 处置：数据通路缺口补齐）：`CreateOtter` 构造函数新增注入 `ConversationRepository`（repo 接口，非 usecase——`create-otter.ts:57` 已有先例论证：注入 repo + 实体工厂不形成组装环，注入 usecase 才会）。`getActiveParticipants()`（`conversation-repository.ts:149`）现成可用。血缘解析与重名兜底**统一在 usecase 层**做，controller 只透传 `conversationId`、不新增注入——原方案"血缘放 controller"的取舍因此反转：两处需求同一数据源，usecase 一处注入覆盖两个，controller 再建一份是重复（见设计取舍表更新）。

1. **血缘服务端解析**：`CreateOtterInput` 新增 `conversationId?: string`。有值时：查该对话 active participants 中 type='big' 的獭取其 id 作 parentOtterId；多个大獭取 joinedAtTurnNumber 最小者（对话主大獭）；无大獭时 parentOtterId 落 null 并继续（允许纯 UI 场景无血缘）。**controller 强制传 conversationId（UI 入口必填），前端传的 parentOtterId 一律忽略**。注意：`ConversationParticipant` 实体不含 otterType（`conversation.ts:68`，检视獭补充观察），实现需两步查询——`getActiveParticipants(conversationId)` 后逐个 `otterRepo.getById(p.otterId)` 检查 type。
2. **重名兜底**：创建前用同一 `getActiveParticipants(conversationId)` 查在场同名 active 小獭，命中抛 DomainError（409）。错误信息附在场同名者 ID，与大獭工具链措辞对齐。
3. `avatar` 进 otter 实体（见 B）。

大獭工具入口（`tool-factory.ts`）不传 conversationId——保持系统注入 `ctx.otterId` 为父（现有行为），不受本次改动影响。

controller `create()` 变更收窄为：`body.conversationId → input.conversationId` 透传 + `modelAlias`/`avatar` 校验（校验留 controller：`modelPool` 已是 controller 层既有依赖模式，settings-controller 先例）。

### D. UI 表单重做（T3）

`CreateOtterModal` 重做后的字段结构：

```
名称*          input（必填，占位「如：分析獭」）
角色名称        input（可选，占位「如：审查獭」——展示在右侧面板 o.role?.name 处）
头像           「随机」独立选项（默认选中，🎲 icon + 文案「按 otterId 命中九款池」）置于网格上方一行；
               下方 3×3 九宫格（九款像素 SVG 直接渲染，选中即预览放大 + 意象名标注：
               獭祭鱼/竹笠/朱结/眠月/抱贝/衔竹/墨痕/莲叶/葫芦）。
               审视发现 5：九款+随机=10 项硬塞 3×3 会溢出，改为「随机独立 + 3×3」两层结构
模型           select，数据源 GET /api/settings → models[]（显示 alias + description 摘要），
               默认选中 defaultModelAlias
职责           textarea（每行一条，可选）——替代原 mockSkills 与「上下文注入」两个摆设控件
系统提示词      分两档：
               - 默认「引导生成」：由名称+角色+职责自动组装（模板升级：含协作约定/工具边界/汇报
                 格式的三段式骨架，而非一句话玩具模板），折叠展示生成结果
               - 「高级」开关：展开自由编辑 textarea。切换语义（审视发现 4 定义）：
                 开启高级时预填当前生成内容（所见即所得起点）；关闭高级时编辑内容保留在
                 state（不丢弃）但不生效，重新开启可继续编辑；引导档再点开始终展示
                 基于当前表单的最新生成结果（旧编辑仅保存在高级档）
```

- 提交逻辑（`confirmCreateOtter` 重写）：
  - 调 `GET /api/conversations/:id/participants` 预检重名（同名在场 → toast 阻断，不请求）
  - POST body：`{ name, type: 'small', role, modelAlias?, avatar?, systemPrompt, conversationId }`——**不再传 parentOtterId**
  - 成功后 setAllOtters 合入新獭（含 avatar/modelAlias），toast 提示
- **审视发现 6**：`onConfirmCreateOtter` 回调签名同步变更——`ModalsProps`（`Modals.tsx` 接口定义）改为携带完整表单对象（`{ name, roleName, responsibilities, modelAlias?, avatar?, systemPrompt, }`）而非三个散参数，`index.tsx` 消费端同步。列入改动范围。
- 上下文注入控件删除理由：该能力本质是"大獭召唤时的记忆检索注入"，UI 用户没有大獭编排语境，保留输入框只会误导（摆设控件比缺控件更差）。

**prompt 生成模板**（引导生成档的骨架，落 `web/src/lib/` 纯函数便于单测）：

```
你是{name}，{角色名}。
职责：
- {每条职责}

协作约定：
- 完成子任务后把行动权交回召唤者或工作流下一步
- 不确定的事如实说明，不编造
- 汇报时先结论后细节
```

（具体文案实现时细化，测试断言只锁结构不锁措辞。）

### 数据流（改后）

```
UI Modal ──POST /api/otters {name, type, role?, modelAlias?, avatar?, systemPrompt, conversationId}──▶
controller：校验 modelAlias（modelPool）+ avatar（白名单）+ 透传 conversationId ──▶
CreateOtter.execute()：血缘解析（participants → big otter）→ 重名兜底 → repo.createOtter（含 avatar）→ agentGateway.create（含 modelAlias）→ 首世 session
```

## 影响范围

| 影响点 | 说明 | 风险 |
|--------|------|------|
| `POST /api/otters` 请求体 | 新增可选字段，向后兼容 | 无（老调用不传新字段行为不变） |
| `GET /api/otters/:id` 响应体 | OtterDTO 多 avatar? 可选字段 | 无（增量字段） |
| otters 表 | 加 avatar 列（幂等 ALTER） | 旧库自动补列，NULL → hash 池回退，零迁移 |
| UI 创建弹窗 | 全量重做 | mock 控件删除是用户可见变化（摆设功能移除） |
| 大獭 create_otter 工具 | **不改** | 无 |
| profile 卡片/消息列表头像 | getOtterAvatar 加第三参 | 缺省路径行为不变 |

## 风险与约束

- **avatar 白名单同步**：九款池名单目前只在 `web/src/lib/otter-avatars.ts`，服务端校验需要共享常量。方案：名单下沉到 `api-contract`（TS 包 web/src 同源引用），两端 import 同一常量。风险低，编译期对齐。
- **血缘解析的对话边界**：conversationId 必须真实存在且用户有权（单用户系统，暂不涉及权限，列为假设）。
- **prompt 模板质量**：引导生成的模板由我方维护，无法穷尽用户意图——「高级编辑」开关兜底，不锁死自由度。
- **modelAlias 缺省语义**：不传 = 默认模型（与工具链一致）。注意 config.yaml 改默认模型后，老獭的 otter_configs 里存的显式 alias 不受影响（既有行为，本次不动）。
- **存量措辞不一致**（审视发现 7，部分接受）：settings-controller:53 `未知模型 alias: X` 与 tool-factory:236 `[错误] 未知的模型别名「X」。可用模型：...` 措辞不一致。本方案新增校验统一采用 tool-factory 风格（带可用列表，对用户更有用）；settings-controller 存量文案统一另立 issue，不扩本 PR 范围。

## 不兼容更新

无。全部字段可选、行为缺省回退，旧客户端零感知。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| avatar 存哪 | `otters` 表新列（身份属性） | 存 `otter_configs`（配置属性） | modelAlias 是 agent 运行时配置（跟 otter_configs 语义匹配），avatar 是展示身份属性，跟 name/role 同类；且 otter_configs 是 key-value 覆盖式写入，存 avatar 会被 setConfig 链路误覆盖 |
| avatar 存什么值 | 资源名 `otter-03-zhujie` | 完整 URL `/avatars/...` | DB 不绑部署路径；前端统一拼前缀，资产迁移零成本 |
| 血缘/重名解析放哪层 | usecase 层（一处注入） | controller 层（HTTP 入口特有） | 审视反转：血缘与重名都依赖 participants 数据，usecase 注入 ConversationRepository 一处覆盖两需求；controller 只透传 conversationId。repo 接口注入无组装环（create-otter.ts:57 先例） |
| 重名检查放哪 | 前端预检 + usecase 兜底 | 仅前端 | 前端防呆省一次 409 往返，usecase 兜底防绕过 UI 的直接 API 调用 |
| mockSkills 控件 | 删除 | 保留并接真数据 | skill 勾选 → prompt 注入是独立特性（涉及 skill 元数据 API 化），本次不做半吊子；摆设控件误导用户，删 |
| modelAlias 校验层 | controller（400）+ 工具层原有校验 | 仅 usecase | 与 settings-controller hasModel 同层；usecase 不依赖 modelPool 端口（保持纯领域层） |
| prompt 生成 | 前端生成后作为 systemPrompt 提交 | 服务端按 role 字段组装 | 前端生成让用户在「高级编辑」里看到并修改最终 prompt，所见即所得；服务端组装会把编辑自由度藏起来 |

## 验证

- **契约单测**（vitest，src 侧）：controller create() 透传 modelAlias/avatar/conversationId；非法 modelAlias 400（含可用列表）；非法 avatar 400；usecase 层血缘解析（单大獭/双大獭取最早/无大獭）；前端传 parentOtterId 被忽略；usecase 重名兜底 409。
- **repo 单测**：createOtter 写 avatar、getById 读回、旧行 avatar NULL。
- **前端单测**（vitest，web 侧）：CreateOtterModal 渲染（随机独立项+3×3 九宫格/模型下拉）；提交 body 组装（含 conversationId、不含 parentOtterId）；重名预检 toast；prompt 引导生成模板结构断言；高级切换语义（开高级预填生成内容、关高级编辑保留不生效）。
- **手工验收**：UI 创建一只带模型+头像的小獭 → 右侧面板/头像面板显示所选头像与模型 → dissolve 后 hash 池不受污染。
- **回归**：大獭 create_otter 创建小獭（不传新字段）行为不变；旧库启动 ALTER 幂等。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `api-contract/api/otter.ts` | 修改 | CreateOtterRequestDTO + modelAlias?/avatar?；OtterDTO + avatar?；九款池共享常量 |
| `src/usecases/otter/create-otter.ts` | 修改 | input + avatar/conversationId；注入 ConversationRepository（重名兜底+血缘解析，审视发现 1/2）；bootstrap/usecases.ts 装配同步 |
| `src/interface-adapters/http/controllers/otter-controller.ts` | 修改 | 透传 conversationId + modelAlias/avatar 校验（不新增注入） |
| `src/entities/otter/otter.ts` | 修改 | Otter + avatar?: string \| null |
| `src/frameworks/db/schema.ts` | 修改 | otters 表幂等 ALTER 加 avatar 列；头注释「禁止 ALTER TABLE」更新为「禁止破坏性 ALTER；新增列走幂等 ALTER+try/catch（F20260824ax376 先例）」——healing_events 先例已破例在先，注释失实（审视发现 3） |
| `src/frameworks/db/otter/sqlite-otter-repository.ts` | 修改 | avatar 读写 |
| `src/interface-adapters/http/dto/otter-dto.ts` | 修改 | toOtterDTO 透传 avatar |
| `web/src/api/client.ts` | 修改 | CreateOtterRequestDTO 引用（@contract 同步即得） |
| `web/src/lib/otter-avatars.ts` | 修改 | getOtterAvatar 第三参 avatar?；池常量改从 @contract import |
| `web/src/lib/mappers.ts` | 修改 | avatar 透传 |
| `web/src/pages/conversation/Modals.tsx` | 重做 | CreateOtterModal（T3 字段结构）；ModalsProps.onConfirmCreateOtter 签名改为表单对象（审视发现 6） |
| `web/src/pages/conversation/index.tsx` | 修改 | confirmCreateOtter 重写 |
| `web/src/lib/build-otter-prompt.ts` | 新增 | prompt 引导生成模板纯函数 |
