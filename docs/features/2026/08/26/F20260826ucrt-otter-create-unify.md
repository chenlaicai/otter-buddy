---
id: F20260826ucrt
title: otter-create-unify
doc_type: feature

# 记忆索引
summary: |
  统一小獭创建双入口（第 2 轮修订）：UI 弹窗与大獭 create_otter 底层同走 CreateOtter usecase，
  但 UI 入口停在 mock 时代——模型选择断在 HTTP 契约层（DTO 缺 modelAlias）、parentOtterId 前端瞎猜、
  能力/上下文控件是摆设。第 2 轮审视（复核獭 kimi）后收缩：契约只补 modelAlias（controller 校验+透传）；
  parentOtterId 诚实落 null（UI 创建无獭召唤者，不伪造血缘，controller 停透传）；
  头像自选降为纯前端 localStorage override（不落库）；表单重做 + 前端重名预检照做。
  13 文件 → 7 文件，src 侧仅改 1 个 controller，大獭工具链零文件改动（静态事实）。

# 因果链路
causal_links:
  from: []
  to: []

# 元数据
status: draft   # 第 2 轮修订版，待复核獭 delta 复核
change_type: feature
capability_test: "n/a: HTTP 契约与 UI 表单变更为主，无 LLM 行为变更；验证走 vitest 单测（契约透传/血缘忽略/头像 override/UI 交互）"
tags: [otter-creation, api-contract, web-ui, model-routing]
modules: [api-contract, src/interface-adapters/http, web/src]

# 时间
created_at: 2026-08-26
created_in_conversation: 60a89cc6-f61e-4e5c-a034-bb0570bf4735
---

# 统一小獭创建双入口（UI 与大獭工具链对齐）——第 2 轮修订版

## 背景

搭档原话（意图锚）：

> 「新建小獭中有几个问题，感觉没随着功能更新呀，比如说，选择模型、选择头像 等等，我觉得ui用户创建 和 大獭创建 只是 入口不同而已吧，底层应该是同一个功能」
> （核对差距清单后）「全做」
> （第 2 轮审视后）「有bug就修」——方案级取舍授权技术侧自行决策

事实核查结论（2026-08-26，第 1 轮）：

- 底层同源：UI `POST /api/otters` 与大獭 `create_otter` 工具最终都进 `CreateOtter.execute()`（`src/usecases/otter/create-otter.ts`）。
- 两条入口能力演进不对称：

| 维度 | 大獭工具链 | UI 弹窗（现状） | 本轮处置 |
|------|-----------|----------------|----------|
| 模型选择 | `modelAlias` + 校验 | 契约层断裂（DTO 缺字段） | **修**（T1） |
| systemPrompt | 大獭精心编写 | 一句话玩具模板 | **修**（T3） |
| 能力/skill 选择 | 按 prompt 承载 | mockSkills 假 checkbox | **删摆设**（T3） |
| 上下文注入 | 大獭检索后注入 | 摆设 textarea | **删摆设**（T3） |
| 重名检查 | 在场同名拒绝 | 无，吃服务端 500 | **前端预检**（T5） |
| 头像 | hash 池自动分配 | 同左，无自选 | **前端自选**（T3，localStorage） |
| 父獭血缘 | 系统注入（不可伪造） | 前端猜 `convOtters[0]` | **诚实落 null**（T4 修订） |

## 第 2 轮修订说明（为什么收缩）

第 1 轮方案（13 文件）过复核獭（kimi）对抗审视，两条严重发现触发架构反转：

1. **伪血缘**：原方案「服务端解析对话内大獭作 parentOtterId」仍是伪造——血缘域语义是「谁召唤了这只獭」，UI 场景召唤者是用户而非任何獭。`identity-builder.ts:116` 的 `buildSummonerIdentity` 是血缘的真实消费方（把 parentOtterId 对应獭的身份注进小獭 system prompt），伪血缘 = 小獭终身顶着假召唤者。且血缘落库后**事后无法区分真召唤与填空**。修正：UI 创建血缘落 null，展示层未来如需归属显示「由搭档创建」，不污染血缘字段。
2. **性价比**：头像落库（T2 原案）单独吃掉约 40% 改动量（实体/DB/repo/DTO/mapper/签名扩散），而这是单人本地系统，跨设备头像持久化是伪刚需。降为纯前端 localStorage override。

反转的连带收益：血缘不上收 usecase → `ConversationRepository` 注入整个砍掉 → `CreateOtter` 构造零改动 → 「大獭工具链零改动」从「靠测试守住」变成**静态事实**（src 侧唯一改动是 otter-controller.ts，不在工具链路径上）。

## 目标（修订版）

- T1: HTTP 契约补齐——`CreateOtterRequestDTO` 增加 `modelAlias?` 可选字段；controller 校验（非法 alias 400 附可用列表）+ 透传。
- T3: UI 表单重做——模型下拉（`GET /api/settings` 的 `models[]` + `defaultModelAlias`）、头像九宫格自选（「随机」默认 + 3×3 九宫格，选择存 localStorage）、删除 mockSkills 与上下文注入两个摆设控件、systemPrompt 双档（引导生成/高级编辑）。
- T4（修订）: 血缘诚实化——controller 停止透传 `body.parentOtterId`（一律忽略），UI 创建的小獭 `parentOtterId = null`；前端不再猜测。
- T5: 重名预检——UI 提交前调 `GET /api/conversations/:id/participants` 预检，同名在场 toast 阻断。

## 非目标

- 不改大獭 `create_otter` 工具行为（src 侧不在工具链路径上改动，零文件）。
- **不做头像持久化**（第 2 轮砍除）——localStorage 是 per-browser 的，换设备回 hash 池；跨设备持久化另立 issue，真有刚需再做。
- **不做血缘服务端解析**（第 2 轮砍除）——UI 创建无獭召唤者，血缘诚实为空。
- **不做服务端重名兜底**（连带砍除）——usecase 不注入 ConversationRepository；单用户本地系统，前端预检足够防呆，直接 API 调用绕过预检属可接受边界（原行为是 500，不劣化）。
- 不做 skill 真接线、不做头像上传/自定义绘制（九款池资产不变）。
- 不改 `otter_configs` 表——modelAlias 真相源已在其中。

## 方案设计

### 模块总览

```
api-contract/api/otter.ts           T1: CreateOtterRequestDTO + modelAlias?
src/interface-adapters/http/
  controllers/otter-controller.ts   T1/T4: modelAlias 校验+透传；停透传 parentOtterId
web/src/api/client.ts               T1: 类型随 @contract 同步
web/src/lib/otter-avatars.ts        T3: localStorage override 层（读写 API + getOtterAvatar 优先 override）
web/src/lib/build-otter-prompt.ts   T3: prompt 引导生成模板纯函数（新增）
web/src/pages/conversation/
  Modals.tsx                        T3: CreateOtterModal 重做
  index.tsx                         T3/T4/T5: confirmCreateOtter 重写
```

### A. 契约补齐（T1）

`CreateOtterRequestDTO`（`api-contract/api/otter.ts`）新增：

```ts
/** 模型别名（可选，须为 config.yaml models[] 合法 alias；缺省用默认模型） */
modelAlias?: string;
```

controller `create()`：`body.modelAlias → input.modelAlias`，校验用既有 `modelPool.hasModel`（settings-controller:53 同层先例），非法返回 400 并附可用列表（`modelPool.describeModels()`），措辞与工具链（`tool-factory.ts:236`）同风格「[错误] 未知的模型别名」。

**不新增** `avatar`/`parentOtterId`/`conversationId` 字段——头像不出浏览器（见 B），血缘不透传（见 C）。

### B. 头像自选（T3，纯前端）

- `web/src/lib/otter-avatars.ts` 增 override 层：`setOtterAvatarOverride(otterId, avatarName | null)` 写 localStorage（key 形如 `otter-avatar:{otterId}`）；`getOtterAvatar(otterId, type)` 读取时先查 override，命中用之，未命中走既有 hash 池——**旧獭/未选獭路径零变化**。
- DB 不加列、实体/repo/DTO/mapper 零改动。
- 九宫格选中即时写 override + 本地 state 刷新 UI；「随机」= 清除 override（回 hash 池）。
- 局限（显式声明）：localStorage 是 per-browser，换设备/清缓存回 hash 池。单用户本地系统可接受。

### C. 血缘诚实化（T4 修订）

- `otter-controller.ts` `create()` 删除 `parentOtterId: body.parentOtterId` 透传（现 `otter-controller.ts:49`）——input.parentOtterId 恒 undefined → usecase `params.parentOtterId ?? null`（`create-otter.ts:37` 既有逻辑）→ 落 null。
- 前端 `confirmCreateOtter` 不再组 parentOtterId（删 `index.tsx:1160` 的 `convOtters[0]?.id` 猜测）。
- 工具链路径（tool-factory.ts:250 系统注入 `ctx.otterId`）不经过 controller，不受影响。
- **不注入** `ConversationRepository`，`CreateOtter` 构造零改动，usecase 层零改动。

### D. UI 表单重做（T3）

`CreateOtterModal` 字段结构：

```
名称*          input（必填，占位「如：分析獭」）
角色名称        input（可选，占位「如：审查獭」）
头像           「随机」独立选项（默认选中）置于网格上方一行；
               下方 3×3 九宫格（九款像素 SVG，选中预览放大 + 意象名标注：
               獭祭鱼/竹笠/朱结/眠月/抱贝/衔竹/墨痕/莲叶/葫芦）
模型           select，数据源 GET /api/settings → models[]（显示 alias + description 摘要），
               默认选中 defaultModelAlias
职责           textarea（每行一条，可选）——替代 mockSkills 与「上下文注入」摆设控件
系统提示词      双档：
               - 「引导生成」：名称+角色+职责自动组装（三段式骨架：身份/职责/协作约定），折叠展示
               - 「高级」开关：自由编辑。切换语义（第 1 轮审视定义）：
                 开启高级预填当前生成内容；关闭高级编辑保留在 state 不生效；
                 引导档始终展示基于当前表单的最新生成
```

- 提交逻辑（`confirmCreateOtter` 重写）：
  - 预检：`GET /api/conversations/:id/participants` 查在场同名 → 命中 toast 阻断不请求
  - 创建成功拿到 otterId 后：若用户选了头像 → `setOtterAvatarOverride(otterId, name)`（未选/随机不写）
  - POST body：`{ name, type: 'small', role, modelAlias?, systemPrompt }`——**不含 parentOtterId/avatar**
- `onConfirmCreateOtter` 签名改为表单对象 `{ name, roleName, responsibilities, modelAlias?, avatarName?, systemPrompt }`（avatarName 仅用于前端 override 写入，不进 POST），`ModalsProps` 与 `index.tsx` 消费端同步。

**prompt 引导生成模板**（落 `build-otter-prompt.ts` 纯函数）：

```
你是{name}，{角色名}。
职责：
- {每条职责}

协作约定：
- 完成子任务后把行动权交回召唤者或工作流下一步
- 不确定的事如实说明，不编造
- 汇报时先结论后细节
```

（文案实现时细化，测试断言只锁结构不锁措辞。）

### 数据流（改后）

```
UI Modal ──POST /api/otters {name, type, role?, modelAlias?, systemPrompt}──▶
controller：校验 modelAlias（modelPool）+ 透传（parentOtterId 不透传）──▶
CreateOtter.execute()：repo.createOtter（parentOtterId=null）→ agentGateway.create（modelAlias）→ 首世 session
UI 拿到响应 →（可选）setOtterAvatarOverride(otterId, 头像名)  [纯前端，不过服务端]
```

## 影响范围

| 影响点 | 说明 | 风险 |
|--------|------|------|
| `POST /api/otters` 请求体 | 新增可选 modelAlias；**parentOtterId 从「透传」变「忽略」** | 唯一现有调用方是 web UI（同步改），无第三方 |
| UI 创建弹窗 | 全量重做 | 摆设控件移除是用户可见变化 |
| 头像 | localStorage override，hash 池兼容回退 | 换设备丢自选（显式接受） |
| 大獭 create_otter 工具 | **零文件改动** | 无（静态事实：src 侧唯一改动 controller 不在工具链路径） |

## 风险与约束

- **modelAlias 缺省语义**：不传 = 默认模型（与工具链一致）。
- **localStorage override 与 hash 池的一致性**：override 只在用户显式选择时写入；「随机」清除 override。未选路径行为与现状逐位一致（单测锁死）。
- **服务端无重名兜底**：绕过 UI 直接 POST 同名仍 500（现状不变，非劣化）。单用户系统接受。
- **prompt 模板质量**：引导生成无法穷尽用户意图，「高级编辑」兜底。
- **存量措辞不一致**（第 1 轮发现 7 维持）：settings-controller:53 存量文案统一另立 issue，不扩范围。

## 不兼容更新

对 web UI：parentOtterId 不再透传（UI 同步改，用户无感）。对外部：无第三方调用方。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| UI 血缘 | 落 null（诚实空） | 服务端解析大獭挂靠（第 1 轮）/前端继续猜 | 血缘语义=「谁召唤」，UI 场景无獭召唤者；identity-builder 是真实消费方，伪血缘终身污染且不可逆区分。第 2 轮发现 1 采纳 |
| 头像持久化 | localStorage（前端） | otters 表落列（第 1 轮） | 单人本地系统跨设备持久化是伪刚需；落库吃 40% 改动量（实体/DB/repo/DTO/mapper/签名扩散）。第 2 轮发现 5 采纳，跨设备另立 issue |
| usecase 注入 | 不注入 ConversationRepository | 注入做血缘+重名兜底（第 1 轮） | 血缘砍除后无消费方；重名前端预检足够；工具链零改动从测试承诺升级为静态事实。第 2 轮发现 3 采纳 |
| 重名检查 | 仅前端预检 | 前端+usecase 兜底 | 服务端兜底需注入（见上行）；绕过 UI 直接 POST 是单用户系统可接受边界 |
| mockSkills 控件 | 删除 | 保留接真数据 | skill 接线是独立特性，摆设比缺控件更误导 |
| modelAlias 校验层 | controller（400） | usecase | 与 settings-controller hasModel 同层；usecase 保持纯领域不依赖 modelPool |
| prompt 生成 | 前端生成提交 | 服务端组装 | 用户在高级档看到并改最终 prompt，所见即所得 |

## 验证

- **契约单测**（src/controller）：modelAlias 透传 input；非法 alias 400 含可用列表；`body.parentOtterId` 被忽略（input.parentOtterId undefined）。
- **前端单测**（web）：
  - Modal 渲染：模型下拉（settings 数据源）、「随机」+3×3 九宫格、mockSkills/上下文控件不存在
  - 提交组装：body 含 modelAlias、**不含 parentOtterId/avatar**
  - 重名预检：同名在场 toast 阻断、不发 POST
  - prompt 模板：结构断言（身份/职责/协作约定三段）
  - 高级切换：开高级预填生成内容、关高级编辑保留不生效、引导档展示最新生成
  - **头像 override 回归**（第 2 轮发现 2 精神）：无 override → hash 池分配结果与改前逐位一致；有 override → 用 override；「随机」→ 清除后回 hash 池
- **回归**：大獭 create_otter 零文件改动（静态事实）；usecase 单测零改动全绿。
- **手工验收**：UI 选模型+头像创建小獭 → 模型生效 + 头像显示所选；刷新页面头像仍在（localStorage）；「随机」创建 → hash 池分配。

## 改动范围（7 文件）

| 文件 | 操作 | 说明 |
|------|------|------|
| `api-contract/api/otter.ts` | 修改 | CreateOtterRequestDTO + modelAlias? |
| `src/interface-adapters/http/controllers/otter-controller.ts` | 修改 | modelAlias 校验+透传；删 parentOtterId 透传（:49） |
| `web/src/api/client.ts` | 修改 | 类型随 @contract 同步 |
| `web/src/lib/otter-avatars.ts` | 修改 | localStorage override 层（set/get） |
| `web/src/lib/build-otter-prompt.ts` | 新增 | prompt 引导生成模板纯函数 |
| `web/src/pages/conversation/Modals.tsx` | 重做 | CreateOtterModal（T3 字段结构）；ModalsProps 签名改表单对象 |
| `web/src/pages/conversation/index.tsx` | 修改 | confirmCreateOtter 重写（预检+override 写入+body 组装） |

## 审视历史

### 第 1 轮（检视獭 mimo，7 条全处置，delta 通过）

数据通路补齐（注入 ConversationRepository）、schema 注释同步、高级切换语义定义、九宫格两层结构、回调签名改表单对象、存量措辞另立 issue——其中「血缘上收 usecase」的取舍在第 2 轮被整体反转。

### 第 2 轮（复核獭 kimi，6 条处置）

| # | 发现 | 级别 | 处置 |
|---|------|------|------|
| 1 | 伪血缘：服务端挂靠大獭 = 伪造召唤关系，identity-builder 是真实消费方 | 严重 | **采纳**——血缘落 null，反转第 1 轮取舍 |
| 2 | 「零迁移」读取路径未验证（null/undefined 岔路致旧头像跳变） | 严重 | **因砍除化解+采纳精神**——无 DB 改动后风险面消失；仍补「无 override → hash 池逐位一致」回归断言 |
| 3 | ConversationRepository 注入性价比倒挂 | 建议 | **采纳**——随发现 1 整个砍除，构造零改动 |
| 4 | api-contract 运行时常量前提未验证 | 建议 | **事实核查后化解**——`tool-helpers.ts:9` 已有 src 侧运行时 import @contract 先例（CARD_MAX_PER_MESSAGE）；且砍除后本方案不再需要共享常量 |
| 5 | T2 落库收益可由前端方案拿 80%，属产品决策被默认 | 建议 | **采纳**——降为 localStorage；跨设备持久化另立 issue（单人系统暂无刚需） |
| 6 | 验证清单缺「工具链零改动」回归 | 建议 | **采纳并升级**——砍除后 src 侧零 usecase 改动，「零改动」成静态事实（改动文件清单可证），仍保留现有 usecase 单测全绿作为回归线 |

决策记录：发现 5 的产品取舍由技术侧（大獭，架构决策权）拍板砍除——依据：单人本地系统 + 搭档「有bug就修，你在问我啥」的授权语境（方案级取舍不逐条上报）。跨设备头像持久化记 issue 追踪。
