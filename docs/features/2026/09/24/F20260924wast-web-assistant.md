---
id: F20260924wast
title: web 助理（浮动獭）——web 侧常驻随问入口
summary: 在 web 全局布局挂载浮动獭 + 浮层对话面板，提供全局唯一的 web 助理型对话（超时自动换 session，设计模式同 IM 助理但两者独立无关）；一期不做跨对话协作。
change_type: feature
capability_test: "n/a: 纯 web UI 与消息通道特性，无 prompt/能力行为变更，由 vitest 组件测试 + playwright e2e 覆盖"
created_in_conversation: 480589fd-5813-400a-9b07-8e7d5707fb34
created_at: 2026-09-24T16:09:00+08:00
doc_type: feature
tags: [web-assistant, floating-ui, assistant-line]
modules: [web/src/components/FloatingAssistant, web/src/components/AppLayout, src/frameworks/config-service]
---

# web 助理（浮动獭）——web 侧常驻随问入口

## 背景（引用原话 / 识别的事实）

对话 480589fd-5813-400a-9b07-8e7d5707fb34（2026-09-24），搭档原话锚点：

1. 「我想固定一个对话，这个对话，类似于现在im助理的对话方式，就是session几个钟头会自动重置。这个对话的定位，就是我日常随口问一些小问题用的……以及，我能显式授权 海獭 去那个对话中去说句话来推进进度（这个功能，也是我想给im助理 也加上的，跨对话的协作！）」
2. 「问题1/2其实不用问的，我要加的这个对话底层也是一个"助理"，只不过是web侧的嘛，所以按照现有im助理设计即可。跨对话协作……这一点二期再说。咱们先加一个 web助理吧，但这个助理的ui交互形式，你需要深入扩散思考设计下，如果还只是一个左侧栏的对话，那我感觉，我会有点不太想用。你觉得是否做成上层浮动的一只獭？」
3. 原型 v0.2（浮动獭 + 浮层面板 + ⌘J）验证后：「ok，现在好多了」
4. ⚠️ **核心纠正（16:34，推翻本方案初稿的共享设计）**：「等等！web助理是web助理！全局一个！im助理是支持多个！这两个没有关系啊！不是共享一个对话关系！我一开始说的是，功能定位是类似的！都是助理型对话（会超时自动重置session）！」
   ——正确理解：web 助理是**全局唯一、独立于 IM 助理**的助理对话；「按照现有 im 助理设计」指**设计模式类似**（助理型对话 + 超时自动换 session），不是共享对话实体。初稿误读为「共享同一助理对话」，本版已重写（T2/取舍 1/M3/M4/D3/D4 等）
5. **砍除决策（17:01）**：上下文感知（T4 context 注入）搭档否决——「那没必要了，我感觉不会有这种场景，我都点开对话了，那我直接在对话里问不就行了」。理由成立：需要上下文的问题在原对话里问更自然（上下文天然完整），浮动獭的定位恰是「脱离当前上下文的随手问」。原 T4 及 context 注入机制整体砍除，机制预算相应减一项

需求定义状态：需求经两轮产品迭代已明确（产品定位与伪需求判断 → UI 交互形态扩散与原型验证），结晶门 C1-C5 在产品议题卡中覆盖并经搭档反馈收敛，无需再次逐项确认。

事实底（本 session 实测）：
- `web/` 是 Vite + React 19 + react-router-dom 7 的 SPA（非早期方案中的 Hono MPA），全局布局为 `web/src/components/AppLayout.tsx`，挂载即全页面常驻
- 头像/视觉资产现成：`web/src/components/OtterAvatar.tsx`、`web/src/lib/otter-avatars.ts`、`otter-visual.ts`（含 datu.svg 像素头像，F20260826avtr）
- 流式与轮询设施现成：`web/src/hooks/use-message-stream.ts`（message-stream）、`use-conversation-list-polling.ts`（现挂在对话列表页，需提升全局单例，见 M2 处置）
- ⚠️ 检视更正（S2）：`web/src/lib/build-otter-prompt.ts` 是「创建小獭 UI 的 systemPrompt 生成模板」（F20260827ucrt），**与助理消息注入无关**；web 发消息请求体无 prompt 组装环节，上下文注入是净新增机制（见方案 T4）
- ⚠️ 检视更正（S1）：F20260920imax 的 8h 静默换 session（`maybeRestartIdleSession`）**仅挂在 IM 入站链**（`ensureAssistantConversation` 内，调用方 `src/app.ts:545`、`feishu/message-processor.ts:110`），HTTP sendMessage 链无 session 检查——纯 web 使用场景 session 永不轮换，需补链（见方案 T2）
- 消息通道是现有 API 复用（M1）：HTTP sendMessage 已硬编码 `source: "web"`（`message-controller.ts:196`），非净新增

## 目标

- **T1**：web 任意页面可随口问——浮动獭（点击/⌘J/hover）唤起浮层对话面板，不跳页、不打断当前上下文
- **T2**：web 助理是**全局唯一、独立的助理型对话**（与 IM 助理零关联——IM 助理 per-connection 各自独立、支持多个，web 助理全局一个；两者仅设计模式类似）。继承「助理型对话」语义：**超时自动换 session**（8h 静默，F20260920imax 同款设计）。**实现含 S1 修复**：web 助理的 session 轮换完全依赖 HTTP 链（IM 入站链永不会碰它）——sendMessage 对该对话补 `maybeRestartIdleSession` 调用（precheck 后、sendEntry 前；该方法现为 private，需暴露或在 usecase 层加公开入口，注意幂等）
- **T2b（开户）**：web 助理对话无则**首次唤起时创建**（复用 ManageConversation.create 现有 HTTP API；modelAlias 用 assistant.modelAlias；**人设 prompt 创建时后端注入**（N2 拍板）：前端只传 kind，后端 create 链按 kind=web-assistant 选用 IM 助理同款模板适配 web 场景——与 IM 助理「构建一次全链共用」模式一致（`assistant-session.ts:161` 同款语义）
- **T3**：獭即状态——浮动獭三态（😴 睡觉=全空闲 / 👀 张望=有活跃任务 / 🔴 冒泡=有未读）反映全局大概状态
- **T4（已砍，17:01）**：原「上下文感知」目标整体移除，见非目标。S2 检视发现（build-otter-prompt 引用错误）的最终处置=功能砍除（引正→ context 方案→ 评审后认定场景不成立）

## 非目标

- **上下文感知/引用**（17:01 搭档砍）：唤起时带「当前对话」context 注入——场景不成立（已在某对话里时直接在该对话里问更自然）
- **跨对话感知 + 授权递话**（二期，已拍板）：全局态势查询、跳转导引、relay_message 三道授权闸
- 驾驶舱 dashboard 页面
- 浮层面板内的富内容渲染（html-card 等）——一期纯文本 + 跳转链接
- hover 轻问答气泡（方案矩阵 E，二期看数据）

## 未决问题

1. session 状态展示（「session 剩 Xh」）的取数：IM 助理线是否已有暴露 session 状态的 API/接口？若无，一期可先展示轮换提示文案，剩余时长二期补（实现时确认）
2. ⌘J 在部分浏览器/插件下的键位冲突细节——一期做可配置 + 点击兜底，冲突表实测补充
4. （D4，16:34 纠正后变形）**web 助理的 systemPrompt/人设来源**——原「同一脑子跨链路」问题已解除（独立对话）；新问题：开户时的人设 prompt 从 IM 助理模板适配的具体形态（T2b 已定方向，模板细节实现时定）
5. （D3，16:34 纠正后变形）web 助理开户路径——**已定：首次唤起时创建**（复用 ManageConversation.create 现有 HTTP API，T2b）；开户失败的回退体验（提示重试）实现时定

## 实现注记（delta 复核沉淀，进 code-implementation 消化）

- （D1）restart 并发防重仍需要（同一 web 助理对话双 tab 同 tick 触发 restart 的 race）：restart 加防重（进行中标记或原子条件更新），单测覆盖并发触发。注：初稿的「双入口幂等」语境（IM+web 共享）已随 16:34 纠正消失，但单对话并发仍在
- （D2）SSE 时序：restart 不中断进行中的 dispatch/流式输出，新消息落新 session——实现时写明/验证此边界
- （N3）首唤创建幂等：双 tab 并发首唤可能建两条——创建前按 kind=web-assistant 查询 + 并发收敛规则（发现多条取最早创建并提示清理），e2e 加双 tab 断言

## 方案设计

### 交互三原则（设计约束，实现必须满足）

1. **召唤才出现**：默认安静趴在角落，绝不主动跳出来搭话（Clippy 反面教材）
2. **獭即状态**：形象本身是全局状态指示器，不问也知道大概
3. **浮层不跳页**：问完留在原地，上下文零割裂；「完整对话 ↗」才跳去助理对话页

### 前端（web/src/）

- **新增 `components/FloatingAssistant/`**：
  - `FloatingOtter.tsx`——浮动獭本体：datu 像素头像（复用 OtterAvatar/otter-avatars）、三态动效（只加装饰不动脸：睡觉=呼吸+zZ、张望=左右探头、冒泡=红点+轻跳）、拖动（localStorage 记忆位置）、hover 快捷气泡（2-3 个**静态**快捷问句（SG3）+ 打开面板）
  - `AssistantPanel.tsx`——浮层对话面板（380×520）：消息流（复用 conversation API + use-message-stream 流式）、输入框、上下文 chip、session 状态、「完整对话 ↗」跳转
  - `use-floating-otter.ts`——唤起/收起（点击、⌘J、Esc、点外）、三态数据源 hook
- **挂载点**：`AppLayout.tsx` 根布局——SPA 全页面常驻
- **助理对话指向规则**（M3 重写，N2 定稿）：web 助理=**固定全局唯一**，识别机制拍板：**新增 kind 枚举值 `web-assistant`**（不用「复用 kind='assistant'+metadata」）——识别逻辑收敛一处，session 触发范围/侧栏分组/人设识别三个下游歧义全部消失；无则首次唤起时创建（T2b）。侧栏新增 web 助理分组（降级入口可见性）
- **三态数据源**（一期，M2 处置；**K1 delta 改口**：实现落点为新建 global-conversation-store 全局轮询单例，旧 use-conversation-list-polling 未动——一期两份 5s 轮询并存（对话页停留时双请求，可接受），「列表页改吃全局 store」需评估 merge-conversations 未读兑底语义，列 issue 二期）：三态由全局轮询单例推断，**优先级写死：冒泡 > 张望 > 睡觉**（SG1）：有未读回复→冒泡（per-conversation unreadCount 前端 any() 聚合）；有活跃对话→张望（per-conversation activityStatus 前端 any() 聚合）；否则睡觉。不新增后端状态接口。已知失真：①「运行中」语义粗（正在打字≠跑任务）②无人值守的定时任务也张望——由「大概状态」产品语义认领（原「跨入口已读不同步」项已随 16:34 纠正删除：独立对话下 web 前端自知未读状态，反而更准）
- **上下文 chip**：已随 T4 砍除（17:01），面板不再带「📍 当前」标签
- **设置开关**：settings 页加「浮动獭」开关；关闭后退回左侧栏助理对话页（助理对话本就是一条 conversation，天然存在降级入口）。**生效语义**（M5）：遵循现有 config DI 模式，改配置需重启进程生效。**K4 delta 补盲点**：「天然存在降级入口」的前提是已开户——「开关关闭+从未开户」时侧栏空分组无对话可达，已在侧栏 web 助理空分组加「创建」入口兑底
- **快捷键**：⌘J / Ctrl+J 唤起面板，可配置；点击兜底

### 后端（src/）

- **消息通道**：web 入口消息走**现有** HTTP conversation API 进 web 助理对话（M1 处置：复用项非净新增，`source: "web"` 已硬编码于 message-controller）
- **session 轮换语义**（S1 处置，本版下更关键）：web 助理对话的 8h 静默换 session 按对话最后活跃计时——**需补链**：HTTP sendMessage 触发 `maybeRestartIdleSession`（见 T2）。原初稿设想的「双入口共享计时」不适用（两对话独立各自计时）
- **上下文注入**（S2 处置终态）：已随 T4 砍除——sendMessage 不加 context 字段，后端无 prompt 注入改动
- **配置**：`assistant.web.enabled`（浮动獭总开关，全局一致，启动注入重启生效）；`assistant.modelAlias` **共用配置值、对话实例各自独立**（N4：IM 侧改配置值，web 助理下个 session 生效新值）

## 影响范围

- 新增 FloatingAssistant 组件族，AppLayout 挂载——不影响现有对话/记忆/skills 页面功能（侧栏分组适配见下）
- **IM 助理零影响**（web 助理独立对话，两者无关联——初稿设想的「IM 历史混流/实时推送」不存在）
- **契约变更已认领**（N2）：ConversationDTO kind 联合类型扩枚举值 `web-assistant` + 前端 mapper/侧栏分组适配（无存储 schema 结构性变更，kind 字段加枚举值）；session 检查严格限定 kind=web-assistant 对话（不触发 IM 助理对话）
- 后端仅配置新增 + HTTP 链 session 检查 + 开户人设注入，无新定时任务、无新信号类型（context 注入已随 17:01 砍除决策移除）

## 风险与约束

- **遮挡与打扰**：右下角安全区 + 可拖动 + 可收起 + 总开关（降级路径永远存在）
- **三态不精确**（M2 补，N1 清理旧模型残留后）：①轮询推断的「运行中」语义粗（正在打字≠跑任务）②无人值守定时任务也张望③多页面场景需全局单例轮询（已提升，避免多请求）——误差由产品语义「大概状态」承担（见取舍 2 认领）
- **S1 缺口若不修复的代价**（供 delta 复核确认已消除）：web 助理永不换 session、上下文无限膨胀——本方案已采纳修复①（HTTP 链补检查），此条转为实现验收项
- **⌘J 键位冲突**：可配置 + 点击兜底

## 不兼容更新

无（纯新增入口；不改现有 API 语义与数据结构）。

## 设计取舍（方案 / 替代方案 / 为什么 / 反对意见 / 风险 / 降级路径）

| # | 采纳 | 替代 | 为什么 | 反对意见 | 风险 | 降级路径 |
|---|---|---|---|---|---|---|
| 1 | **web 助理独立全局唯一**（与 IM 助理零关联） | 共享同一助理对话（初稿方案，搭档 16:34 明确否决） | 定位不同：web 助理=全局随问入口（一个），IM 助理=per-connection 支持多个；两者仅设计模式类似（助理型对话+超时换 session） | 独立对话无跨入口连续性（IM 问一半不能 web 接着问）——不在目标内，无代价 | 无 | 独立对话本身就是隔离 |
| 2 | **三态用会话轮询推断**（提升全局单例，M2） | 新增全局任务状态后端接口 | 一期省一个后端接口；三态产品语义就是「大概」，精度要求低（已知失真清单见风险节） | 「运行中」推断不精确、跨入口已读不同步 | 状态偶发失真 | 失真可接受；二期做全局态势时升级为精确源 |
| 3 | **浮动獭挂 AppLayout** | 独立路由页 / 侧栏对话 | 全局常驻是核心价值；SPA 根布局一处挂载 | 组件常驻有性能与遮挡顾虑 | 遮挡内容 | 可拖动 + 可收起 + 总开关 |
| 4 | **上下文感知整体砍除**（17:01 搭档否决） | context metadata 注入 / body 前缀 / build-otter-prompt（S2 已证伪） | 场景不成立：需要上下文的问题在原对话里问更自然，浮动獭定位=脱离当前上下文的随手问 | 问「这个是啥」时需手动粘上下文——发生频率低，接受 | 无 | 真需要时二期重估（届时直接做「引用具体消息」而非「引用对话」） |
| 5 | **⌘J 主快捷键，可配置** | ⌘K / 其他 | ⌘J 浏览器占用少；与方案矩阵 A+C 混合形态一致 | 部分插件占用 | 键位冲突 | 点击獭兜底 + 可改键 |

## 机制预算（机制识别命中，四问必答）

净新增机制（17:01 砍除 context 后重算）：①新增配置字段/开关（`assistant.web.enabled`、快捷键配置）②**HTTP 链 session 检查路径**（sendMessage → `maybeRestartIdleSession`）。web 消息通道、web 助理开户均为复用现有 API（M1/T2b），不计；context 注入已随 T4 砍除，不计。

① **谁需要它**：开关的主人是「不喜欢浮动元素/键位冲突的用户」；HTTP 链 session 检查的主人是「web 助理超时自动重置」（产品定位语义本体）。
② **失败后果**：开关失效→浮动元素关不掉（用户可感知）；session 检查失效→web 助理永不换 session、上下文膨胀直至 token 溢出（产品定位失败）。
③ **后续机制**：web 助理与 IM 助理各自独立换 session（互不影响）；无其他新状态。
④ **退役条件**：web 助理月活≈0→删 FloatingAssistant 与 web 助理对话；session 检查不可退役（是「超时自动重置」产品语义的组成部分）。

省事声明：三态省掉「新增全局任务状态后端接口」，省掉之物的主人是产品精度要求（三态=大概状态，精度损失已被产品语义认领）；三态轮询提升全局单例的成本（一处 5s 轮询多消费者）由 M2 处置吸收；web 助理开户复用 ManageConversation.create（无新 API），省掉之物=HTTP 开户接口的复杂度，主人已认领（首唤即建的体验）。

## 验证

- **单测**（vitest）：FloatingOtter 交互（点击展开、⌘J、拖动位移<6px 判点击、三态切换与优先级）、AssistantPanel 消息流
- **e2e**（playwright）：全页面常驻（conversation/memory/skills/settings 页均可见獭）、发消息流式回复、设置开关关闭后獭消失且侧栏入口可用、**首次唤起自动创建 web 助理对话**（T2b）、**web 助理活跃跨 8h 后新消息触发 session 重启**（SG2，S1 修复的防回归关键断言）
- **手动验收**：对照原型 v0.2（工作区 web-assistant-ui/prototype.html）逐项核对交互

## 改动范围

（delta K3 补全：初版仅列 10 项，与实际 37 文件 diff 不符；下表为实拍清单）

| 文件/目录 | 操作 | 说明 |
|---|---|---|
| web/src/components/FloatingAssistant/ | 新增 | FloatingOtter / AssistantPanel / use-floating-otter / global-conversation-store / FloatingAssistant 宿主 + 单测 |
| web/src/components/AppLayout.tsx | 修改 | 挂载 FloatingAssistant + 全局轮询组件 + settings 开关拉取（mock 同步更新 AppLayout.test） |
| web/src/hooks/use-conversation-list-polling.ts | **未改** | K1 改口：一期两份轮询并存（见设计取舍 M2 补记），真共用列 issue 二期 |
| web/src/pages/conversation/LeftPanel.tsx | 修改 | 「web 助理」独立分组 + 空组创建入口（K4） |
| web/src/pages/settings/index.tsx | 修改 | 浮动獭开关只读展示 + 快捷键配置 |
| web/src/lib/mappers.ts | 修改 | kind 扩枚举适配 |
| web/src/api/client.ts | 修改 | createConversation 返回类型改列表项 DTO（K9） |
| web/src/styles/globals.css | 修改 | otter 三态/pop 动画 + prefers-reduced-motion |
| web/e2e/floating-assistant*.spec.ts | 新增×2 | 常驻/首唤/双 tab 收敛/降级 mock e2e |
| web/pnpm-lock.yaml | 修改 | 基线失同步补齐（router-dom/playwright 未收录，不修 CI npm ci 挂） |
| api-contract/api/conversation.ts | 修改 | kind 扩枚举 + CreateConversationRequestDTO.kind + title 保持必填（K9 落法：前端占位传参，不破坏空 title 透传既有语义） |
| api-contract/api/settings.ts | 修改 | SettingsDTO.assistantWebEnabled 只读下发 |
| src/entities/conversation/conversation.ts | 修改 | ConversationKind 联合类型化 |
| src/usecases/im/assistant-session.ts | 修改 | checkIdleAndRestartSession 公开入口 + restarting 防重（S1/D1） |
| src/usecases/conversation/web-assistant-provisioner.ts | 新增 | 幂等开户 + 人设注入（T2b/N3） |
| src/usecases/conversation/conversation-repository.ts | 修改 | kind 类型扩枚举 |
| src/interface-adapters/http/controllers/conversation-controller.ts | 修改 | create 收 kind=web-assistant 走 provisioner（新增 API 分支）；title 校验在 usecase 层 manage-conversation.ts:34，controller 无校验 |
| src/interface-adapters/http/controllers/message-controller.ts | 修改 | sendMessage 链 session 检查（S1） |
| src/interface-adapters/http/controllers/settings-controller.ts | 修改 | SettingsConfig.assistantWebEnabled |
| src/interface-adapters/http/dto/conversation-dto.ts | 修改 | kind 透传非 normal 值 |
| src/frameworks/config-service.ts | 修改 | im.assistant.web.enabled 配置段 |
| src/bootstrap/usecases.ts / types.ts / controllers.ts | 修改 | WebAssistantProvisioner 装配 + 双 controller 注入 |
| config/config.yaml.example | 修改 | 配置段示例 |
| tests/usecases/conversation/web-assistant-provisioner.test.ts | 新增 | 开户幂等 5 例 |
| tests/usecases/im/web-assistant-session-entry.test.ts | 新增 | session 入口/防重 5 例 |
| tests/interface-adapters/http/web-assistant-session-check.test.ts | 新增 | controller S1 4 例 |
| tests/api/helpers.ts / settings.test.ts | 修改 | SettingsConfig 新字段测试基线 |
| docs/features/2026/09/24/F20260924wast-web-assistant.md | 新增 | 本特性文档 |

## 实现纪要（2026-09-25，实现獭落盘）

### 落地文件清单

后端：
- `src/usecases/im/assistant-session.ts`——S1：`maybeRestartIdleSession` 公开为 `checkIdleAndRestartSession`；D1 并发防重（`restarting` Set 进行中标记，finally 统一清除）
- `src/usecases/conversation/web-assistant-provisioner.ts`（新增）——T2b：开户幂等（kind=web-assistant 查询 + 多条取最早收敛）+ 人设 systemPrompt 后端注入（createOtter 单点，recruiting 同款编排）
- `src/interface-adapters/http/controllers/message-controller.ts`——sendMessage 在 precheck 后、sendEntry 前对 kind=web-assistant 对话调 session 检查（严格限定；失败不阻塞发送）
- `src/interface-adapters/http/controllers/conversation-controller.ts`——POST /api/conversations 收 kind=web-assistant 走 provisioner（201 新建/200 复用）
- `src/frameworks/config-service.ts` + `config/config.yaml.example`——im.assistant.web.enabled（默认 true，DI 启动注入）
- 契约：ConversationDTO kind 扩 `web-assistant`；SettingsDTO 增 `assistantWebEnabled`（只读）；CreateConversationRequestDTO 增可选 kind

前端：
- `web/src/components/FloatingAssistant/`（新增组件族）——FloatingOtter（datu 三态：呼吸/zZ、探头、红点轻跳）、AssistantPanel（380×520 浮层：历史 + 发送 + POST SSE 流式 + 完整对话跳转）、use-floating-otter（点击/⌘J/Esc/点外、拖动 <6px 判点击、localStorage 位置）、global-conversation-store（全局轮询单例 + 三态推断）、FloatingAssistant（宿主：首唤开户 + 面板定位 clamp）
- `web/src/components/AppLayout.tsx`——挂载浮动獭 + 全局轮询（settings.assistantWebEnabled=false 时不挂载）
- `web/src/lib/mappers.ts` + `LeftPanel.tsx`——kind 扩枚举 + 「web 助理」独立分组（降级入口）
- `web/src/pages/settings/index.tsx`——浮动獭开关只读展示 + ⌘J 快捷键可配置（localStorage floating-otter:hotkey）
- `web/src/styles/globals.css`——otter-breathe/peek/hop/zz/pop 动画（prefers-reduced-motion 全覆盖）

### 实现中发现与处置

**delta 处置（2026-09-25，检视獭 4 minor + 5 suggestion，大獭裁决后实现獭执行）**：
- K1 双轮询并存：**改口认领**——一期全局轮询（三态数据源）与列表页轮询（未读兑底/merge 语义）两份并存，每 5s 双请求可接受；真共用（列表页改吃全局 store）需评估 merge-conversations 未读兑底语义变更，列 issue 二期
- K2 全局轮询 limit：对齐侧栏同口径 500（消默认 50 截断）
- K3 改动范围表：补全实拍清单（含 conversation-controller 入口层分支）
- K4 降级路径断裂：侧栏 web 助理空分组加「创建」入口（复用 POST {kind}）；**方案层盲点留痕**——「关闭后天然存在侧栏降级入口」的前提是已开户，原方案与三轮方案审均未抓到（检视獭自领一半），已补实现兑底
- K5 e2e 断言收紧 toBe(1)；K6 错别字；K7 面板历史不自动刷新记此处（一期一次性加载 30 条，另一 tab 问答不入流，二期全局态势一并解）；K8 删 convsRef 死代码；K9 契约 title 保持必填（前端占位传参，保住 tests/api/conversation.test.ts:136 空 title 透传语义）+ api client 显式类型去双重 cast

1. **面板定位 bug（e2e 拦下）**：零尺寸 fixed 容器 + top/right 锚点会让子面板向右溢出视口（x=1256+380 > 1280）——改为定位样式直接挂 AssistantPanel 根元素
2. **呼吸动画 vs playwright stability**：三态动画使元素永不稳定（element is not stable）——e2e 用 `page.emulateMedia({ reducedMotion: 'reduce' })` + CSS 层 prefers-reduced-motion 全覆盖三态与 pop 动画
3. **列表页空态无 LeftPanel（既有行为）**：/conversation 空库时不渲染侧栏——降级 e2e 改为先建一条普通对话再断言分组可见
4. **lockfile 基线失同步（既有问题）**：HEAD 的 web/package.json 含 react-router-dom/@playwright/test 但 pnpm-lock.yaml 未收录（CI `npm ci` 会挂）——本 PR pnpm install 顺带补齐
5. **MessageList hast 类型错误（既有问题，未修）**：`import type { Element } from 'hast'` 但 hast 包不在 dependencies（仅 @types/hast）——基线 `tsc --noEmit` 同样报错，非本 PR 引入，待另行修复
6. **rhi-api trends 测试日期敏感（既有 flaky，未修）**：基线 8dc32200 同样失败（日期序列断言），非本 PR 引入

### 测试自检结果

- 后端 vitest：3979 passed（新增 14：provisioner 5 + session 入口 5 + controller S1 4；rhi-api 1 例既有 flaky 与基线一致失败）
- 前端 vitest：548 passed（新增 14：三态优先级/快捷键/阈值/位置）
- e2e：22 passed（新增 6：全页面常驻、首唤开户、Esc/⌘J、双 tab 收敛、三态 data-mood、开关关闭降级）
- 流式回复：AssistantPanel 接 POST SSE（entry.speak 全量气泡渲染，与主对话页同机制）；真 LLM 流式细节不在 CI e2e（占位端点不可触达），由机制同源保证
- 跨 8h session 重启（SG2）：后端单测 web-assistant-session-entry.test.ts 覆盖（8h 触发/不足不触发/并发防重/不同对话隔离/失败重试）——CI 时间操纵不可靠，单测覆盖是可靠断言面

## 下一步

对抗审视（重对抗门合并同轮）→ 处置发现 → delta 复核 → 呈搭档终审 → 进入 code-implementation。
