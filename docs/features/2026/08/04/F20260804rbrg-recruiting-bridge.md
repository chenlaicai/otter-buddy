---
id: F20260804rbrg
title: recruiting-bridge
doc_type: feature

summary: |
  招聘桥接：让海獭代用户感知 BOSS 直聘上的初步沟通消息（HR 寒暄、要简历、面试邀请、拒信），
  自动分类、起草回复、记录接触过的公司，并在每日定时给摘要。
  架构是双边的：Chrome MV3 扩展跑在用户真实浏览器里扫 BOSS 聊天页 DOM，
  把"新会话 + historyMsg 全文"POST 到 otter-buddy inbound 端点；
  otter-buddy 转入专用"💼 求职助手"对话，注入求职助手角色 systemPrompt 的大獭处理。
  边界明确：只读不写——扩展绝不替用户回写 BOSS，大獭起草的回复只供用户参考。
  桥接状态可观测：扩展把异常（反爬、登录失效、otter 不可达等）也推到同一对话，
  用户在 otter 里就能感知所有问题，不用看扩展后台。

causal_links:
  from:
    - F20260730heal   # self-healing-system：专用对话 + ensureXxx boot pattern + 定时摘要 mirror
    - F20260721x8k9   # scheduled-task：定时摘要任务的底座
    - F20260802hybr   # hybrid-architecture：Web MPA + 对话 SPA，桥接消息通过 Web/SSE 可见

status: reviewed   # 已经过 1 轮对抗审视 + 4 项致命问题拍板 + Spike 6 通过
change_type: feature
tags: [agent, recruiting, boss-zhipin, browser-extension, mv3, observability, inbound]
modules:
  - extensions/boss-zhipin-bridge/
  - src/usecases/recruiting/
  - src/interface-adapters/http/controllers/inbound-controller.ts
  - src/interface-adapters/http/router.ts
  - src/usecases/memory/memory-repository.ts
  - src/usecases/memory/search-memory.ts
  - src/entities/conversation/message.ts
  - src/frameworks/config-service.ts
  - src/main.ts
  - prompts/contexts/RECRUITING_INTAKE.md
  - config/config.yaml.example

created_at: 2026-08-04
---

# F20260804rbrg 招聘桥接（recruiting-bridge）

## 背景

### 问题

用户求职中，痛点：不想频繁打开 BOSS 直聘看初步沟通消息。多数是低信息密度的寒暄和"发个简历看看"——频繁打断注意力，但不看又怕错过真正的面试邀请。

期望：让海獭代为感知、分类、起草回复，用户只看海獭的摘要和起草、自行决定是否回复。

### 关键约束（与用户确认）

- **只读不写**——回写 BOSS 不做。理由：封号风险 + 身份边界（求职沟通是真实的人在说话，AI 全自动代回出错代价是真实 offer）。
- **低频操作**——避免触发 BOSS 反爬。
- **otter 对话是唯一面板**——任何问题都在 otter 求职助手中可见，用户不用打开扩展后台排查。

### 设计目标的演进

最初三版方案：

1. ❌ **otter-buddy 用 Playwright 主动爬 BOSS**：反爬强、登录态难维护、架构重
2. ❌ **扩展后台 service worker 定时 fetch BOSS REST API**：调研否决（详见下方"可行性调研"）
3. ✅ **扩展 content script 寄生 BOSS 聊天页**：接受"聊天页必须打开"的代价，换零反爬压力 + 架构干净

## 可行性调研结论（写在设计前）

调研发现 BOSS 直聘的消息架构不是直觉以为的样子。三条硬事实：

| 事实 | 含义 |
|---|---|
| 会话列表只走 WebSocket（`ws6.zhipin.com`），**没有 REST 端点** | 想"调一个接口拿未读消息列表"——那个接口不存在 |
| `/wapi/` 端点强依赖浏览器会话 cookie | 即使存在 historyMsg REST，也必须在登录态的真实页面上下文里调 |
| MV3 service worker 的 `fetch(credentials:'include')` 拿不到 `SameSite=Lax` 的 cookie（中国站点默认） | 后台 SW 调 BOSS API 这条路被 cookie 隔离堵死 |

来源：[browser-skills.sh BOSS-zhipin skill](https://www.browser-skills.sh/skills/BOSS-zhipin)（2026-05-01 实测）+ [Stack Overflow](https://stackoverflow.com/questions/35542255/fetch-api-not-sending-session-cookies-when-used-inside-a-chrome-extension) + [Chromium Extensions Group](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/RMUtNEhR0R8)。

**推论**：原方案（后台 SW 定时 fetch REST）不可行，pivot 到 **content script 寄生 BOSS 聊天页**——content script 跑在页面真实 origin 里，共享 cookie，无 SameSite 问题；同时把"必须打开聊天页"的代价用 `chrome.windows.create({state:'minimized'})` 自动管理 tab 来兜底。

## Spike 验证结果（2026-08-03 实测）

5 个 Spike 全部通过。关键发现：

| Spike | 验证项 | 结果 |
|---|---|---|
| 1 DOM | `.friend-content` 选择器、字段抽取 | ✅ |
| 1 bossId | 获取路径 | ✅ **webRequest 监听 historyMsg URL 是唯一可靠路径**——DOM data-*/Vue 实例都拿不到 |
| 2 historyMsg | 页面内 REST 调通 | ✅ status=200, 61ms, bodyTypes={1:1, 8:1, 16:1} 齐全 |
| 3 链路 | 扩展 → otter inbound | ✅ HTTP 200 + OPTIONS CORS preflight 通 + 服务端日志确认 |
| 4 角色稳定性 | 5 类消息分类 + 起草 + 记忆 | ✅ 5/5 全对；面试邀请自发加 🔴 高优 + 给确认/调整两版；拒信严格遵守"不起草"边界；薪资类严格遵守"绝不虚构"边界 |
| 5 定时摘要 | search_memory + 汇总 | ✅ 自动 search_memory + 表格化汇总 + 建议处理顺序 |

Spike 4 验证脚本与角色 prompt 草稿保留在 `extensions/spike-4/` 和 `scripts/spike-4-recruit-test.mjs`，作为生产实现的角色稿起点。

## 对抗审视决策（2026-08-04）

设计文档完成后由独立 agent 做对抗审视，发现 3 个致命问题、8 项显著遗漏、5 处术语不一致、6 项 spike 验证不充分。逐项处理后用户拍板如下：

### 致命 1：bossId 冷启动黑洞 → 决策：模拟点击未读会话（Spike 6 已通过 ✅）

**问题**：webRequest 只有用户点过会话、BOSS 调过 historyMsg 才能抓到 bossId。HR 发了新消息但用户从未点开 → bossId 永远拿不到。

**决策**：扩展主动 `element.click()` 未读会话元素，触发 BOSS 自己调 historyMsg。

**Spike 6 验证结果（2026-08-04）**：

| 模式 | 结果 |
|---|---|
| 已开 tab 上 click（baseline） | ✅ 触发 historyMsg |
| 新开 normal 窗口 + click | ✅ 触发 historyMsg |
| 新开 minimized 窗口 + click | ✅ **触发 historyMsg**（命门通过） |

**修通的关键细节**（v1 失败原因 + v2 修复）：
1. 等 **25 秒**让 SPA 完整 bootstrap（v1 等了 15s 不够）
2. 优先 click **非 active/selected** 的会话元素（v1 总点第一个，遇到 BOSS auto-select 已选中导致无状态变化）
3. click 前先发 `mousemove` + `mouseover`（部分框架靠用户姿态激活）

**反爬缓解**（生产实现必须遵守）：click 之间 1-3 秒随机延迟；单周期最多 click 5 个未读会话；触发反爬（about:blank）立即停 + 上报 critical。

### 致命 2：AgentDispatchService 衔接不匹配 → 决策：inbound 用例 bypass resolveUserTargets

**问题**：`AgentDispatchService.resolveFirstTurnTargets` 查 `senderType: "user"` 的消息拿派发目标；inbound 推入的是系统消息不是用户消息，复用走不通。

**决策**：`ProcessInboundRecruit` 用例直接构造消息时**显式设 `talkingStonePassedTo: [bigOtterId]`**（绕过 `resolveUserTargets`），然后直接调 `DispatchChainEngine.executeChain`，不走 `AgentDispatchService`。文档不再说"复用 Feishu 路径"，改为"复用 DispatchChainEngine 底层，跳过 user-target 解析"。

### 致命 3：search_memory 不支持时间范围查询 → 决策：加时间过滤到 SearchEngine

**问题**：`SearchMemory` 是 RRF 相关性排序，spike 5 通过是因为只有 5 条记录。生产环境几百条记录时，"今日新接触"查询准确度未验证。

**决策**：扩展 `SearchEngine` 支持 `createdAfter?: ISO timestamp` 过滤参数，`SearchMemory` 接口加可选时间过滤字段。**这是对 SearchEngine 的通用增强**，不仅服务于本 feature，未来其他场景也能用。

**同时解决"memory 无限增长"**：用户选"不归档，靠检索过滤"。linked_resource 一直留着，但定时摘要靠时间过滤只查当日新增，不依赖归档清理。中长期若检索性能下降再考虑归档。

### 其他审视发现的修正

| 审视发现 | 处理 |
|---|---|
| systemPrompt 注入路径描述错误（"通过 buildIdentityPrefix"） | 修正：实际是通过 `otterConfigProvider` 持久化到 `otter_configs` 表，每次 invoke 时读取拼入 prompt |
| systemPrompt 改了不生效（需 session reset） | **用户决策：接受**。生产部署前把 prompt 打磨到位；后续要改 prompt 时手动 session reset（一次性操作）。文档加风险提示 |
| ManageConversation 改动是抽象泄漏 | 修正：`ensureRecruitingConversation` 自己编排 `createOtter.execute({ systemPrompt }) + repo.create() + createParticipants()`，**不动 ManageConversation**。文档"涉及文件"去掉 manage-conversation.ts |
| InboundController 缺依赖 | 修正：文档"涉及文件"补 ControllerDeps 改动——InboundController 注入 ProcessInboundRecruit + QueryMessage（查重） |
| X-Inbound-Key 安全 | 修正：明确 key 只存在 `chrome.storage.local` + options 页手填，不硬编码；config.yaml 写一次，用户复制到 options 页；轮换靠改 config + 重填 |
| info 事件与"唯一面板"承诺矛盾 | 修正：加"info 异常模式检测"——连续 N 次（默认 48 次=24 小时）`scan-ok-0` 升级为 warning 推送一次；扩展 options 页是"详细可观测面板"，otter 对话是"关键告警面板"，两者职责分明 |
| 术语"mirror"滥用 | 修正：把所有"mirror `ensureHealingConversation`"改为"参考 `ensureHealingConversation` 并扩展（多一步 systemPrompt 注入）" |
| spike 代码已在 main 分支 | 已知。spike 代码（spike-1 扩展、spike-4 角色 prompt、spike-4 测试脚本、spike-3 InboundController 最小版）在生产实现 PR 中清理，路由 `registerInboundRoutes` 替换为正式版 |
| Spike 验证不充分（minimized 模拟点击、批量 historyMsg、长间隔恢复、SW 崩溃恢复） | 补 Spike 6-8 见下方 |

### 补充 Spike 状态

| Spike | 状态 | 备注 |
|---|---|---|
| **6. minimized 模拟点击 + 反爬** | ✅ **已通过**（2026-08-04） | minimized window + click 触发 historyMsg 成功；3 个关键修复点已固化（25s 等待 / 非 active 会话 / mousemove 姿态）。连续 click 反爬验证推迟到生产实现后真实数据上观察 |
| **7. search_memory 时间过滤** | 实现时一并做（不是真命门） | 给 SearchEngine 加 `createdAfter?: ISO timestamp` 通用参数，写代码 + 单测，不需独立 spike |
| **8. 长间隔恢复** | 不在首版必做（已知风险） | 写到风险列表，遇到真实问题再补 |

**Spike 6 通过后的备选退化方案不再需要**：原"Spike 6 失败 → 只用 DOM 预览"备选作废，直接按"模拟点击未读会话"全量实现。

## 架构师审视决策（2026-08-04）

由独立架构师 agent 做第二輪审视（在对抗审视之后），评估设计在 otter-buddy 架构哲学里的契合度。结论：**⚠️ GO WITH CAVEATS**。

**6 维度评分**（1-5）：抽象层级清晰度 3 / 与核心范式契合 4 / 用户原则遵守 4 / 可演进性 3 / 抽象债平衡 4 / 与 healing 对称性 4。

### 必须改（已应用）

**路由名去领域化**：`POST /api/inbound/recruit` → `POST /api/inbound/events`。

**理由**：路由是通用基础设施层，不应该焊死领域名。文档自己在"不在本设计范围"和 causal_links 里都提到了多平台和多来源演进。`/recruit` 这个 URL 在第二个外部桥接（GitHub webhook、日历同步等）出现时，要么并列加 `/api/inbound/github`（每个都焊死），要么改名（破坏性 API 变更）。

**修正**：路由 `/api/inbound/events`，body 加 `source` 字段标识来源（"boss-zhipin-bridge"），`InboundController` 按 `source` 分发到对应 use case。领域逻辑下沉到 use case 层（`ProcessInboundRecruit` 这个类名在 recruiting use case 目录里是正确的）。

### 建议改（已应用）

在"风险与已知问题"表里补两条抽象债记录：

1. **`ManageConversation.create` 不接受 systemPrompt**：逼出 `ensureRecruitingConversation` 手动编排 createOtter + repo + participants，与 `ensureHealingConversation` 存在逻辑重复。触发重构条件：第三个专用对话出现时。
2. **定时任务 body 策略不统一**：healing 用动态注入、recruiting 用固定文本，两种模式并存合理但选型规则未沉淀为架构约束。

### 架构师确认正确的决策（不动）

- **bypass AgentDispatchService 直接调 DispatchChainEngine**：ADS 的 user-target 解析对系统消息场景语义不匹配，硬塞会污染 ADS 职责。bypass 是正确的分层选择。
- **桥接状态走 memory 而非独立表**：当前数据量（单用户、低频）下 YAGNI 正确。未来数据量增长再考虑 `bridge_events` 表。
- **两种定时任务 body 策略并存**：当前最小复杂度方案，合理。
- **求职助手角色 prompt 走 otterConfigProvider 持久化**：身份层 prompt 走持久化配置（和 healing 协议走 speak tool description）的信道选择都正确，性质不同不冲突。

### 已识别但不做的架构机会（YAGNI）

- **inbound 端点泛化为通用事件入口**：已通过路由改名部分实现（机会 1）；完全泛化（多 source 多 use case 路由）等第二个来源出现时再做。
- **`bridge_events` 表作为一等可观测实体**：当前数据量下 memory 够用。
- **webRequest 抓取模式抽象为"平台适配器"**：首版只做一个平台，过早抽象是 YAGNI。在扩展 README 里画"哪些是 BOSS 特有 / 哪些是通用桥接骨架"的分隔线即可。

## 第三轮运维审视决策（2026-08-04）

由独立 SRE agent 做第三轮审视（场景推演视角），用户（架构师）逐题拍板。审视找了 12 个场景 + 6 个可观测盲区 + 退场机制缺失。**用户驳回 3 项误判**，**接受 4 项真发现**。

### 驳回的误判（不写进风险表）

| 审视声称 | 驳回理由 |
|---|---|
| 对话历史无限膨胀致 token 爆炸 | 这是 otter-buddy 通用对话机制问题（Pi SDK 的 context 管理责任），不是 recruiting-bridge 该解决 |
| 定时摘要任务静默死亡 | 误读——"今日无新消息"是**正常**回复不算失败；SchedulerService 的"连续失败 3 次"指 LLM 技术失败，与本 feature 设计无关 |
| Hallucination 混入其他公司信息 | 如果大獭检索到混杂内容，那是 memory 系统的检索缺陷，不是本 feature 设计问题。归 memory 系统 |

### 接受的真发现（已应用到设计）

#### 1. 一次扫描 = 一次大獭 invoke（设计层面修改）

**问题**：原设计每条 HR 消息触发一次大獭 invoke。一次扫描 5 个未读 → 大獭被 invoke 5 次，成本高、失去跨消息关联能力。

**修正**：扩展端把一次扫描的所有新消息打包成**一次** POST（`messages` 数组）；服务端 `ProcessInboundRecruit` 把整批组装成**一条**系统消息插入专用对话（`[招聘消息批次·BOSS直聘·扫描时间 ...]`），大獭一次 invoke 处理整批——可以跨公司排序（面试邀请排首位）、去重、给整体摘要开篇。

应用位置：变更 6 重写 + 变更 3c 新增 + 角色 prompt 加"批量招聘消息处理"段。

#### 2. 扩展端水位线（实现细节，但必须设计上明确）

**问题**：模拟点击未读会话后，`historyMsg` 返回**完整对话历史**。首次扫描若不防，会把用户早就处理过的旧消息当新消息推送。

**修正**：扩展端为每个 bossId 维护 `lastSeenMessageTime`。首次扫描新 bossId 时**只设水位线、不推任何消息**（都是历史）；后续扫描只推水位线之后的新消息。即使首次扫描拿到 50 条历史，扩展端推送 0 条。配合变更 3c 的批量打包，水位线之后哪怕只有 1 条新消息也是一次大獭 invoke。

应用位置：变更 3b 新增。

#### 3. 角色 prompt 补"用户直接搭话"段

**问题**：角色 prompt 只描述 `[招聘消息]` 和 `[桥接状态]` 前缀消息的处理，没覆盖用户在飞书/Web 直接搭话的场景（"今天有谁找我"、"今天天气"等），大獭行为不可预期。

**修正**：角色 prompt 加第 0 节"用户直接搭话"——求职相关正常发挥、非求职简短回应并提醒角色边界。不机械拒绝，大獭依然是那个有温度的大獭，只是在这个对话里聚焦求职。

应用位置：`extensions/spike-4/RECRUITING_INTAKE.md` 加第 0 节。

#### 4. 半失效升级规则

**问题**：连续多次 `scan-zero-unexpected` warning 会被 30 分钟去重压制，用户看到偶尔的 warning 以为"正常"，实际可能是 BOSS 改版。

**修正**：连续 3 次 `scan-zero-unexpected`（约 90 分钟）自动升级为 critical，触发 critical 推送（"可能 BOSS 改版，需要重新校准选择器"）。和现有 `scan-ok-0` 连续 48 次升级规则同类。

应用位置：变更 8 事件目录的 `scan-zero-unexpected` 升级规则。

### 其他应处理项（已应用，架构师决策）

- **首次安装测试连接按钮**：options 页加，主动验证 otter 可达。`extension-installed` 事件首次成功连接 otter 后才上报，避免误报 `otter-unreachable`
- **半失效升级规则**：见上方 #4
- **退场机制**：用户自行控制（卸载扩展 + 手动停定时任务 + 手动归档对话）。**不在本 PR 范围**——用户明确说"我会自行控制这个对话及其定时任务的"。F 文档不加退场机制设计

### 不在范围但值得记的（场景推演里识别的）

- 可观测性盲区 6 项中，部分场景（content script 注入失败、historyMsg 返回错误码、用户手动关 minimized window 等）首版暂不覆盖，作为已知盲区写到扩展 README "故障排查"节，遇到时再补
- 多设备扩展并存：服务端 `externalId` 查重已兜底，首版不处理并发
- session restore tab 状态识别：扩展端用 `chrome.tabs` 标记自己创建的 tab，不依赖 pinned 状态推断

## 实现就绪度审视决策（2026-08-04）

由独立工程师 agent 做"冷读"审视，找出 6 个 BLOCKER + 多项隐含决策。这轮的价值是**让设计真正可被实现**——前几轮评估设计好不好，这一轮发现"设计虽然对但没说清怎么写代码"。

### 6 个 BLOCKER 决策（已应用）

#### Blocker 1：`sendMessage.send()` vs `sendSystem()` → 用 `send()` 显式指定 system + target

**问题**：文档说"构造系统消息时设 `talkingStonePassedTo`"，但 `sendSystem()` 硬编码 `talkingStonePassedTo: []`。实现者不知道用哪个 API。

**决策**：`ProcessInboundRecruit` 调 `sendMessage.send({ conversationId, senderType: "system", senderId: "system", talkingStonePassedTo: [bigOtterId], body })`。理由：定时任务路径（`scheduler-service.ts:207`）已用此模式注入系统消息并触发 dispatch。`sendSystem()` 是不带 target 的便捷方法，不适合需要指定大獭派发的场景。

#### Blocker 2：systemPrompt 注入路径 → 调 `createOtter.execute({ systemPrompt })` 一次到位

**问题**：文档行 136 说"通过 otterConfigProvider 持久化"，行 318 说"createOtter.execute({ systemPrompt })"——两条路径让实现者困惑。

**决策**：`ensureRecruitingConversation` 调 `createOtter.execute({ name: "大獭", type: "big", systemPrompt })` —— **只需这一个 API**。`createOtter.execute` 内部链路：`agentGateway.create(id, { systemPrompt })` → `PiSessionFactory.create()` → `otterConfigProvider.setConfig(...)` 自动持久化到 `otter_configs` 表。后续 invoke 时 PiSessionFactory 自动从 `otter_configs` 读取拼入 prompt。**实现者不需要直接操作 otterConfigProvider**。

文档行 136 的"otterConfigProvider 持久化"是描述内部机制（让读者理解为什么改 prompt 要 session reset），不是要直接调用——表述引起歧义，已修正。

#### Blocker 3：`ProcessInboundRecruit` 依赖列表 → 明确 7 个注入

**决策**：构造函数注入：

```typescript
{
  conversationRepo: ConversationRepository,       // 查专用对话
  queryMessage: QueryMessage,                     // externalId 查重
  sendMessage: SendMessage,                       // 插入系统消息
  dispatchChainEngine: DispatchChainEngine,        // 触发派发
  agentInvokePort: AgentInvokePort,               // 构造 invokeFn
  settingsRepo: SettingsRepository,               // 拿 bigOtterId
  logger: Logger,
}
```

invokeFn 内部构造（mirror `AgentDispatchService.dispatch` 行 36-51 那段）：

```typescript
const invokeFn = async ({ otterId, conversationId, userMessageContent, senderId }) =>
  agentInvokePort.invokeConversation({ otterId, conversationId, userMessageContent, senderId });
```

#### Blocker 4：externalId 格式 + 查重路径

**格式**：`boss:{bossId}:{mid}`（bossId 来自 webRequest，mid 来自 historyMsg 返回的 `messages[].mid`）。

**查重路径**：Message 实体加可选 `metadata?: { externalId?: string }` 字段，`messages` 表加 `metadata` JSON 列 + 在 `messages_fts` 之外建普通索引。`QueryMessage` 加 `findByExternalId(externalId): Promise<boolean>` 方法。`ProcessInboundRecruit` 入库前调此方法，已存在则跳过。

#### Blocker 5：info 事件路径矛盾 → info 根本不推 otter

**问题**：文档自相矛盾——一边说"info 默认不推送到 otter"，一边在角色 prompt 写"info 静默入 memory 不打扰"。

**决策**：info 事件**完全不进入 otter 系统**——扩展端不 POST info 事件到 otter，只存在扩展 `chrome.storage.local` + options 页可见。角色 prompt 的"info 静默入 memory"是错误描述，已删除。修正后：
- `info` → 扩展端本地存 + options 页可见，不 POST
- `warning` / `critical` → POST 到 otter，进入专用对话，大獭按 severity 处理

#### Blocker 6：SearchEngine vs SearchFilters → 改 SearchFilters + MemoryRepository + search_memory 工具

**问题**：文档说"扩展 SearchEngine 支持 createdAfter"，但 SearchEngine 是 rerank 算法层，不接触 DB。时间过滤应该在 SQL 层。

**决策**：
- `SearchFilters` 接口加 `createdAfter?: string`（ISO timestamp）
- `MemoryRepository` 的 FTS/Vec 查询 SQL WHERE 子句加 `AND created_at >= ?`
- `search_memory` 工具 parameters 加 `created_after?: string`，让大獭定时摘要时能传"今天"
- `SearchEngine` 类**不动**（rerank 层不归它管时间过滤）

涉及文件表已修正：把 `search-engine.ts` 去掉，加 `memory-repository.ts` + `tool-factory.ts`（search_memory 工具）。

### 非阻塞决策（已应用）

| 项 | 决策 |
|---|---|
| Settings key 命名 | `__recruiting_conversation_id__` + `__recruiting_big_otter_id__`（mirror healing） |
| 状态事件 30 分钟去重位置 + key | **扩展端**做（`info` 不 POST，`warning`/`critical` 才 POST），去重 key = `type`（同 type 不同 detail 也算重复，避免刷屏；detail 区分度不够时升级到 `type+detail`） |
| 连续异常升级计数器 | **扩展端** `chrome.storage.local` 存 |
| 定时摘要任务 body 完整文本 | `"请汇总今日（{今天日期}）新收到的招聘消息：哪些公司/HR、哪些是面试邀请（高优）、哪些待你回复。用 search_memory 工具加 created_after 参数查今日新接触记录。"` |
| 定时摘要任务 name + senderId | `name: "recruiting-daily-summary"`, `senderId: "system"` |
| 定时摘要 cron | `"7 9 * * *"`（5 字段标准 cron，mirror healing 的 `"0 10 * * *"` 格式） |
| search_memory 工具加 created_after 参数 | 加。类型 string，可选，ISO date。让大獭定时摘要能精确查"今天" |
| 角色 prompt 路径 | `prompts/contexts/RECRUITING_INTAKE.md`（正确拼写 RECRUITING） |
| bossId 缓存 key 结构（扩展端） | `chrome.storage.local` 里：`bossIds: { [bossId]: { firstSeen, lastSeen, hrName, company } }` |
| 水位线 timestamp 格式 | 复用 BOSS historyMsg 返回的 `time` 字段原值（unix ms）。historyMsg 响应解析时直接存原值，过滤用 `> lastSeen` |

### HTTP 契约明确（扩展端 ↔ otter 服务端）

**`POST /api/inbound/events`** 请求：

```typescript
// recruit kind
{
  source: "boss-zhipin-bridge",
  kind: "recruit",
  payload: {
    messages: [{
      externalId: "boss:XXX:YYY",      // bossId:mid
      bossId: "XXX",
      mid: "YYY",                       // BOSS message id
      hrName: "王女士",
      hrTitle: "招聘专家",               // 可选，DOM 抽不到则缺
      company: "字节跳动",
      position: "高级前端工程师",
      content: "你好，看了你的简历...",
      time: 1785554815000               // unix ms，BOSS 原值
    }]
  }
}

// status kind
{
  source: "boss-zhipin-bridge",
  kind: "status",
  payload: {
    events: [{
      type: "anti-bot-detected",
      severity: "critical",             // "warning" | "critical"，info 不 POST
      detail: "BOSS 页面重定向到 about:blank",
      at: "2026-08-04T10:30:00Z"        // ISO string
    }]
  }
}
```

**响应**：

- 成功：`200 { ok: true, accepted: <number>, deduplicated: <number> }`
- 鉴权失败：`401 { ok: false, error: "invalid X-Inbound-Key" }`
- body 校验失败：`400 { ok: false, error: "<reason>" }`
- 服务端 boot 未完成（专用对话未就绪）：`503 { ok: false, error: "service not ready" }`——扩展端对 503 用更长退避重试（区别于 ECONNREFUSED）

## 变更

### 1. 双边架构：Chrome 扩展 + otter-buddy inbound

扩展（`extensions/boss-zhipin-bridge/`）和 otter-buddy 服务**完全分离**，通过 HTTP 协议解耦。扩展用 MV3 + content script + background SW；otter-buddy 加一个 inbound 端点接收推送。两边都不背对方的依赖（otter-buddy 不引入浏览器自动化库；扩展不引入 otter-buddy 的 npm 包）。

**为什么不做单边**：让 otter-buddy 直接用 Playwright 爬 BOSS——反爬脆弱、登录态维护成本高、把浏览器栈塞进轻量 Hono 服务改变系统运维形态。让扩展自己分类起草——重复 otter 的能力（memory、agent dispatch），浪费。双边各做擅长的事最干净。

### 2. 扩展侧：感知层用 DOM，不用 WebSocket hook

BOSS 的会话列表只走 WebSocket。两种拿法：

- **DOM 扫描**：扫 `.friend-content` 元素，从 Vue 渲染产物里读字段。BOSS 改版时 DOM 结构比 WS 协议稳定。
- **WebSocket hook**（劫持 `window.WebSocket`）：能拿实时推送，但 WS 帧格式未公开、易碎、BOSS 改协议就坏。

**决策**：DOM 扫描为主，alarm 触发；如果未来 WS 帧被逆向且稳定，再升级。

### 3. 扩展侧：bossId 用 webRequest 抓 URL，不用 DOM

> ✅ Spike 6 已通过（2026-08-04）：minimized window + 模拟 click 完整链路验证。详见"对抗审视决策 · 致命 1"。

`historyMsg` REST 必需 `bossId` 参数。spike 验证三种获取路径：

| 路径 | 结果 |
|---|---|
| DOM `data-*` 属性 regex | ❌ 没有 |
| Vue 实例 `__vue__` | ❌ 拿不到 |
| `chrome.webRequest.onBeforeRequest` 监听 `/wapi/zpchat/` URL | ✅ 100% 抓到 |

**决策**：扩展 background SW 注册 webRequest 监听器，捕获所有 `/wapi/zpchat/` 请求的 URL 参数。content script 通过 message passing 向 background 查询 bossId。

### 3b. 扩展侧：水位线机制，只推真正的新消息

**问题**：模拟点击未读会话后，`historyMsg` 返回**完整对话历史**（用户和该 HR 的所有过往消息）。如果首次扫描就把全部历史当"新消息"推，会触发：① 大獭被一次性海量消息淹没；② 用户在 BOSS 上早就处理过的旧消息被重新分类起草（噪音）。

**决策**：扩展端为每个 bossId 维护 `lastSeenMessageTime`（存在 `chrome.storage.local`）：

- **首次扫描新 bossId**：historyMsg 返回的最后一条消息时间设为水位线，**不推送任何消息**（这些都是历史）。仅记录水位线
- **后续扫描**：从 historyMsg 拿到的消息列表里，过滤 `message.time > lastSeenMessageTime` 的部分，更新水位线，**只推过滤后的新消息**
- **水位线丢失**（用户清了扩展 storage 或换设备）：服务端 `externalId` 查重兜底（已设计）

这样首次扫描即使拿到 50 条历史，扩展端不会推任何消息（都是水位线之前的），不会冲击大獭。后续扫描每条真正的新消息才进 batch。

### 3c. 扩展侧：一次扫描批量打包推送

扩展端一次扫描周期可能发现多个 bossId 有新消息（水位线之后）。**不逐条 POST**，而是把所有新消息打包成**一次** POST（`kind: "recruit"` 的 `messages` 数组），otter 侧 `ProcessInboundRecruit` 把整批组装成**一条**系统消息（见变更 6）。

**为什么这样**：
- 一次扫描 = 一次大獭 invoke（成本/延迟最优）
- 大獭一次看到一批，可以跨公司排序、去重、关联（比逐条处理质量高）
- 和定时摘要的"批量处理"模式一致

### 4. 扩展侧：minimized window 自动管理 tab

BOSS 反爬会跳 `about:blank`，频繁开/关 tab 风险高。采用 **"开一次，长驻，空闲关"** 模式：

| 策略 | 作用 |
|---|---|
| 首次 alarm 自动开 `chrome.windows.create({state:'minimized', focused:false})` | 用户基本无感，比 `chrome.tabs.create({active:false})` 更隐蔽（taskbar/dock 不可见） |
| 后续 alarm 复用已开 tab | 不重复 open/close，降低 churn |
| 空闲 2h 无成功扫描才关 | 模拟"用户离开后关掉" |
| alarm 间隔 30min ± 5min 抖动 | 避免固定周期被识别为机器人 |
| 扫描 dwell time 15-20s | 像真人浏览，不是 hit-and-run |
| 检测到 about:blank 重定向 | 立即上报 critical 状态事件，不自愈 |
| 用户主动 pin tab 时跳过自动管理 | 已开了就别再开第二个 |

### 5. otter 侧：专用"💼 求职助手"对话 + systemPrompt 注入

参考 F20260730heal 的 `ensureHealingConversation` 模式并扩展：boot 时幂等创建一个专用对话（settings 表存 ID 避免重复创建），大獭在其中扮演"招聘消息处理专员"角色。

**与 healing 对话的关键差异**：healing 对话的大獭没有 systemPrompt；recruiting 需要。所以 `ensureRecruitingConversation` 不能照抄，必须自己编排 `createOtter.execute({ systemPrompt }) + repo.create() + repo.createParticipants()`，**不动 `ManageConversation.create`**（避免抽象层级泄漏——通用 conversation 创建 API 不应该看到 recruiting 特定的 systemPrompt 字段）。

**systemPrompt 注入路径**：调 `createOtter.execute({ name, type: "big", systemPrompt })` 一次即可。内部链路：`createOtter` → `agentGateway.create` → `PiSessionFactory.create` → 自动调 `otterConfigProvider.setConfig` 持久化到 `otter_configs` 表。后续 invoke 时 PiSessionFactory 从 `otter_configs` 读取拼入 prompt。**实现者只需调 createOtter 一行**，不需要直接操作 otterConfigProvider。

**为什么用专用对话 + systemPrompt 注入**：

- 专用对话避免污染用户主对话（求职是临时上下文）
- systemPrompt 持久注入比"对话首消息注入"更稳——spike 4 实测发现，"首消息注入"在角色确认这一步大獭偶尔只输出文本不调 speak 工具（系统提示"未调用 speak 工具结束发言"）。systemPrompt 注入从源头避免这个瑕疵。

**已知限制**（用户已接受）：systemPrompt 注入后写入 `otter_configs`，后续修改 prompt 不生效（除非 session reset）。生产部署前把 prompt 打磨到位；后续要改 prompt 时手动 session reset（一次性操作）。

### 6. otter 侧：通用 inbound 端点按 source + kind 分流 + **一次扫描一次 invoke**

新端点 `POST /api/inbound/events`，body 带 `source`（哪个外部桥接）+ `kind`（什么类型的事件）：

```json
{
  "source": "boss-zhipin-bridge",
  "kind": "recruit",
  "payload": { "messages": [...] }
}
```

```json
{
  "source": "boss-zhipin-bridge",
  "kind": "status",
  "payload": { "events": [...] }
}
```

`InboundController` 按 `source` 路由到对应 use case（当前只有 `ProcessInboundRecruit`，未来可加 GitHub webhook、日历同步等），use case 内部按 `kind` 分流。

**关键设计：一次扫描 = 一条系统消息 = 一次大獭 invoke**

扩展端一次扫描可能发现 N 条新 HR 消息（多个会话）。**不是**逐条推送触发 N 次 invoke（成本高、大獭失去跨会话关联能力），**而是**把一次扫描的所有新消息打包成一条系统消息插入专用对话：

```
[招聘消息批次·BOSS直聘·扫描时间 2026-08-04 10:32]
共 3 条新消息：

▌消息 1 / HR：王女士 / 公司：字节跳动 / 职位：高级前端工程师
时间：2026-08-04 10:15
你好，看了你的简历...

▌消息 2 / HR：李先生 / 公司：美团 / 职位：资深产品经理
时间：2026-08-04 10:32
您好，您的经历和我们正在招的岗位很匹配...

▌消息 3 / HR：张经理 / 公司：腾讯 / 职位：后端工程师
时间：2026-08-04 11:02
您好，初次沟通后我们想邀请您参加面试...
```

大獭一次 invoke 处理整批——可以跨公司排序（面试邀请排首位）、跨消息去重、给统一的处理建议。这比逐条 invoke 更省成本、质量更高，也和定时摘要的"批量处理"模式一致。

**派发链路**：`ProcessInboundRecruit` 用例构造这条系统消息时**显式设 `talkingStonePassedTo: [bigOtterId]`**（不依赖 `resolveUserTargets`），然后直接调 `DispatchChainEngine.executeChain`，**不走 `AgentDispatchService`**（因为 `resolveFirstTurnTargets` 查 `senderType: "user"` 的最近消息，而 inbound 插入的是系统消息，复用走不通）。

**为什么是 `/events` 而不是 `/recruit`**：路由是通用基础设施层，不焊死领域名（架构师审视决策）。多来源/多平台演进时只需扩 `source`/`kind` 枚举 + 新 use case，不改路由表。

**为什么用单端点 + source + kind 而不是多端点**：所有外部推送共享同一个共享密钥、同一套 CORS、同一套去重逻辑。

### 7. otter 侧：定时摘要任务

参考 F20260730heal 的 `ensureHealingScheduler` 模式：boot 时幂等创建一个每日 9:07（off-minute，避开 :00）触发的 scheduled task，target 是专用对话的大獭。

**任务定义**：
- `name`: `"recruiting-daily-summary"`
- `cron`: `"7 9 * * *"`，`timezone`: `"Asia/Shanghai"`
- `senderId`: `"system"`
- `body`: `"请汇总今日（{今天日期}）新收到的招聘消息：哪些公司/HR、哪些是面试邀请（高优）、哪些待你回复。用 search_memory 工具加 created_after 参数查今日新接触记录。"`

大獭用 `search_memory`（带新的 `created_after` 参数）查当日新接触记录，输出表格 + 建议处理顺序。

**前置依赖**：`SearchFilters` 加 `createdAfter?: ISO timestamp` + `MemoryRepository` 的 SQL WHERE 子句加时间过滤 + `search_memory` 工具加 `created_after` 参数（见审视致命 3 修正）。否则 spike 5 通过的原因是数据少，生产环境几百条记录时无法准确过滤当日新增。

**为什么不用 scheduler-service 里硬编码的 `[self-healing-analysis]` 拦截机制**：那个机制和 healingRepo 强耦合，扩展到本场景需要泛化 body-builder hook。固定 body 文本简单稳定，大獭 prompt 已能驱动它主动 search_memory（spike 5 实测）。

### 8. otter 侧：桥接状态可观测性

扩展不只是推招聘消息，还推**自己的健康状态**——让用户在 otter 对话里就能感知所有问题。

**三级 severity + 大獭响应策略**：

| severity | 大獭行为 | 例子 |
|---|---|---|
| `info` | **静默**（入 memory 不打扰） | 扩展启动、扫描 0 新消息、tab 自动开关 |
| `warning` | **简短确认**（"⚠️ X 异常，已记录"） | DOM 选择器扫到 0 条意外、historyMsg 单次失败 |
| `critical` | **🔴 高优通知 + 行动建议** | 反爬 about:blank、登录失效、otter 不可达 |

**事件目录**（扩展端必须上报的）：

| type | 默认 severity |
|---|---|
| `extension-installed` | info |
| `scan-ok` | info |
| `scan-zero-unexpected` | warning |
| `scan-failed` | warning |
| `forward-failed` | warning→critical（重试耗尽升级） |
| `history-failed` | warning |
| `anti-bot-detected` | **critical** |
| `login-expired` | **critical** |
| `otter-unreachable` | **critical** |

**降噪与升级规则**：
- `info` 默认不推送到 otter（只在扩展 options 页可见）
- 同类型 `warning`/`critical` 在 30 分钟内去重；`critical` 至少推送一次
- **连续异常升级**：
  - 连续 48 次（24 小时）`scan-ok` 且 0 新消息 → 升级为 warning 推一次（可能 BOSS 消息系统异常或网络断了）
  - 连续 3 次（约 90 分钟）`scan-zero-unexpected` → 升级为 critical（可能 BOSS 改版，需要重新校准选择器）
  - 连续 N 次（默认 3）`forward-failed` → 升级为 critical `otter-unreachable`

**otter 不可达时的兜底**（鸡生蛋问题）：

1. 扩展图标 badge 显示红色"!" + 未送达事件数
2. 调用 `chrome.notifications` API 弹系统级通知（critical 才弹）
3. 本地 `chrome.storage.local` 缓冲事件，otter 恢复后批量补发

## 设计决策

1. **content script 路而非 service worker fetch**：MV3 SW 的 `fetch(credentials:'include')` 在跨域场景下拿不到 `SameSite=Lax` 的 cookie（中国站点默认），但 content script 跑在页面真实 origin 里没这个问题。代价是必须有 BOSS 聊天页打开，用 minimized window 自动管理 tab 兜底。

2. **DOM 扫描而非 WebSocket hook**：DOM 结构（Vue 渲染产物）比未公开的 WS 帧协议稳定。BOSS 改版时 DOM 选择器坏了用 DevTools 重找即可；WS 帧格式变了要逆向重写。

3. **bossId 用 webRequest 而非 DOM/Vue + 模拟点击触发 historyMsg**：spike 实测前两条路径（DOM data-*/Vue 实例）都拿不到。webRequest 监听 `/wapi/zpchat/` URL 参数是唯一可靠路径。代价是依赖 BOSS 自己调过 historyMsg——冷启动时 content script 主动 `.click()` 未读会话元素触发。**Spike 6 已验证可行**（包括 minimized window 状态），但必须遵守三个细节：等 25s SPA bootstrap、点非 active 会话、先发 mousemove。反爬缓解：click 间隔 1-3s 随机、单周期最多 5 个、触发 about:blank 立即停。

4. **专用对话而非主对话**：求职是临时上下文，不应污染用户日常主对话。专用对话 + systemPrompt 注入让大獭行为可预期且边界清晰。

5. **systemPrompt 注入而非首消息注入**：spike 4 实测，首消息注入在"角色确认"这一步大獭偶尔只输出文本不调 speak 工具，导致消息卡在 speaking 状态。systemPrompt 通过 `otterConfigProvider` 持久化到 `otter_configs` 表，每次 invoke 时读取拼入 prompt，从源头避免这个瑕疵。**已知限制**：prompt 改了不生效（除非 session reset），用户已接受。

6. **单端点 + source + kind 字段而非多端点**：所有外部推送共享同一套共享密钥/CORS/去重逻辑。`source` 标识哪个外部桥接（boss-zhipin-bridge 等），`kind` 标识事件类型（recruit/status 等）。新增来源/类型只需扩枚举 + 新 use case，不改路由表。路由 `/api/inbound/events` 是通用基础设施，不焊死领域名（架构师审视决策）。

7. **降噪策略：info 不推 otter**：如果每 30 分钟的 alarm 心跳都推到 otter，一天 48 条噪音。`info` 类只在扩展 options 页可见，otter 对话保持信号纯净。

8. **otter 不可达时的兜底三件套**：badge + Chrome 系统通知 + 本地缓冲补发。任何单独一项都不够（badge 太 passive、系统通知易被忽略、本地缓冲用户无感），组合起来才稳。

9. **回写 BOSS 明确不做**：扩展绝不调任何修改 BOSS 状态的 API（发消息、标已读、接受好友等）。理由：封号风险 + 身份边界（求职沟通出错代价是真实 offer）。起草回复给用户参考，用户自己复制粘贴。

10. **不需要 feature flag**：扩展是独立子目录（`extensions/boss-zhipin-bridge/`），不进 otter-buddy npm 构建。otter-buddy 侧的 inbound 端点 + recruiting use cases + systemPrompt 注入，配置（`inbound.recruiting.apiKey`）不存在时自动跳过 boot 初始化，类似 feishu 配置缺失的处理。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `extensions/boss-zhipin-bridge/manifest.json` | 新增：MV3 manifest，permissions 含 storage/activeTab/webRequest/notifications/alarms，host_permissions 含 zhipin.com + otter URL |
| `extensions/boss-zhipin-bridge/background.js` | 新增：alarm 调度、tab 自动管理、webRequest 监听、状态事件派发、otter 不可达兜底 |
| `extensions/boss-zhipin-bridge/content.js` | 新增：DOM 扫描、historyMsg fetch（页面上下文）、与 background message passing |
| `extensions/boss-zhipin-bridge/options.{html,js}` | 新增：配置 URL/key、状态可视化、调试触发器 |
| `extensions/boss-zhipin-bridge/README.md` | 新增：安装、配置（如何从 DevTools 找 BOSS API endpoint）、使用、故障排查 |
| `src/usecases/recruiting/ensure-recruiting-conversation.ts` | 新增：boot 时幂等创建专用对话，参考 `ensure-healing-conversation.ts` 并扩展（自己编排 Otter/Repo/Participants，注入 systemPrompt） |
| `src/usecases/recruiting/ensure-recruiting-scheduler.ts` | 新增：boot 时幂等创建定时摘要任务，参考 `ensure-healing-scheduler.ts` |
| `src/usecases/recruiting/process-inbound-recruit.ts` | 新增：核心用例，注入 7 个依赖（conversationRepo/queryMessage/sendMessage/dispatchChainEngine/agentInvokePort/settingsRepo/logger），按 kind 分流、查重、格式化批量系统消息、**直接调 DispatchChainEngine（不走 AgentDispatchService）** |
| `src/interface-adapters/http/controllers/inbound-controller.ts` | 修改：从 Spike 3 最小版升级——通用 inbound 入口，按 `source` 分发到不同 use case + 校验 X-Inbound-Key + CORS |
| `src/interface-adapters/http/dto/inbound-dto.ts` | 新增：请求 DTO（含 source/kind/payload）+ 校验 |
| `src/interface-adapters/http/router.ts` | 修改：注册 `/api/inbound/events` 路由（替换 Spike 3 的 `/api/inbound/recruit`）+ Controllers 接口加 inbound 字段 |
| `src/main.ts` | 修改：ControllerDeps 扩展、InboundController 依赖装配、boot 时 ensure 链 |
| `src/usecases/memory/memory-repository.ts` + `src/usecases/memory/search-memory.ts` | 修改：`SearchFilters` 加 `createdAfter?: ISO timestamp`，`MemoryRepository` 的 FTS/Vec SQL WHERE 子句加 `AND created_at >= ?`，`search_memory` 工具 parameters 加 `created_after` 暴露给 LLM |
| `src/entities/conversation/message.ts` + DB schema | 修改：Message 加可选 `metadata?: { externalId?: string }`，messages 表加 `metadata` JSON 列 + 索引；`QueryMessage` 加 `findByExternalId` 方法 |
| `prompts/contexts/RECRUITING_INTAKE.md` | 新增：求职助手角色 prompt（正确拼写 RECRUITING，含三类消息处理 + 五类招聘分类 + 桥接状态处理） |
| `src/frameworks/config-service.ts` | 修改：新增 `inbound.recruiting.apiKey` 配置段，参考 `buildFeishuConfig` |
| `config/config.yaml.example` | 修改：新增 `inbound:` 示例段 |
| `extensions/spike-1/`, `extensions/spike-4/`, `scripts/spike-*.mjs` | 删除：spike 阶段 throwaway 代码，正式实现后清理 |

## 测试

### 单元测试（otter-buddy 侧）

- `tests/usecases/recruiting/process-inbound-recruit.test.ts`：覆盖 kind 分流、查重（externalId via findByExternalId）、批量消息格式化、空数组、超大数组、apiKey 校验失败、body 校验失败、executeChain 被正确调用
- `tests/interface-adapters/http/inbound-controller.test.ts`：CORS preflight、auth 失败、合法 POST、source 路由分发、503 service not ready
- `tests/usecases/recruiting/ensure-recruiting-conversation.test.ts`：幂等性、settings 修复、createOtter 收到 systemPrompt 参数
- `tests/usecases/recruiting/ensure-recruiting-scheduler.test.ts`：幂等性、任务 name/cron/senderId 正确
- `tests/usecases/memory/memory-repository.test.ts`：createdAfter 在 SQL WHERE 中正确应用（FTS + Vec 两条路径）
- `tests/usecases/conversation/query-message.test.ts`：findByExternalId 方法（含空 metadata 兼容旧消息）
- `tests/frameworks/config-service.test.ts`：inbound.recruiting 配置段解析 + 缺失时返回 undefined
- 现有测试不应被破坏（ManageConversation 不改动，原测试保持不变）

### 扩展侧手动验证

由于扩展跑在浏览器，自动化受限。`extensions/boss-zhipin-bridge/README.md` 提供：

- 安装步骤（含如何从 DevTools 找 BOSS API endpoint）
- 五个手动验证场景：扫描成功、扫描零消息异常、反爬触发、otter 不可达、登录失效
- 每个 scenario 的预期表现（在扩展 options 页 + otter 对话中分别看到什么）

### 端到端验证（已通过 spike 完成）

见上方"Spike 验证结果"。Spike 已验证：DOM 扫描、bossId 抓取、historyMsg fetch、扩展→otter 链路、大獭角色稳定性、定时摘要。生产实现只需把 spike 的 throwaway 代码替换为正式实现，行为应一致。

## 不在本设计范围

- 回写 BOSS（明确不做）
- 简历托管（用户暂未提；后续可单独加，让大獭管简历 PDF + 按岗位微调自我介绍）
- 其他招聘平台（拉勾、智联）——架构已通用，后续按平台加扩展即可
- BOSS WebSocket 帧逆向（先放弃，DOM + webRequest + historyMsg REST 够用就不碰）

## 风险与已知问题

| 风险 | 缓解 |
|---|---|
| BOSS 改版导致 DOM 选择器失效 | `scan-zero-unexpected` warning 自动上报；扩展 options 页提供"重新校准选择器"流程 |
| BOSS 反爬升级触发 about:blank 更频繁 | critical 状态立即通知；扩展自动暂停扫描等待用户手动恢复 |
| 用户长时间不开浏览器（出差等） | 扩展不工作；otter 侧定时摘要仍会触发，会发现"今日无新消息" |
| otter 服务挂了 | 扩展三件套兜底（badge + Chrome 通知 + 本地缓冲） |
| 扩展审核（如未来上 Chrome Web Store） | 本设计假设私有分发（开发者模式加载未打包），不上架 |
| Safari 移植 | spike 阶段用 Chrome；Safari 移植成本高（Xcode 打包 + SW 生命周期更激进），暂不在范围 |
| **抽象债：`ManageConversation.create` 不接受 systemPrompt** | **触发重构条件**：第三个专用对话出现时。当前 `ensureRecruitingConversation` 和 `ensureHealingConversation` 存在逻辑重复（create → pin → find big otter → settings）。重构方向：给 `CreateConversationInput` 加可选 `bigOtterSystemPrompt?` 字段，内部传给 `createOtter.execute`，让两个 ensure 都走同一个 API（来源：架构师审视） |
| **抽象债：定时任务 body 策略不统一** | healing 用动态注入（`[self-healing-analysis]` 标记 + body-builder hook），recruiting 用固定文本 + 大獭自检索。两种模式并存合理，但选型依据（数据量小用固定 / 数据量大用动态注入）未沉淀为架构约束。建议未来在 SchedulerService 注释或 CONTRIBUTING.md 里写明选型规则（来源：架构师审视） |

## causal_links（向下游）

本 F 文档可能衍生：
- 简历托管 feature（如果用户后续提出）
- 其他招聘平台扩展（拉勾、智联等，复用同一 inbound 端点 + kind 机制）
- 通用"外部桥接"框架（如果出现第三个类似需求，把 inbound 端点泛化）
