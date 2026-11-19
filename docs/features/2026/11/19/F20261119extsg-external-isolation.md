---
id: F20261119extsg
title: "外部接入对话（CoLink）隔离加固：受限档副作用收口 + 对话级档位单源"
summary: "外部接入对话（CoLink）隔离加固。现有 restricted external profile 主干成立（独立 durable、无 coding/记忆/编排工具、dynamicContext 恒空），但独立复核发现「允许的工具」自带未隔离写面：speak 可落 healing/signal 台账（后续全权轮次回注）、html-card-play 经 autoRegisterPlayableCards 写 linked_resources 与全局记忆索引（绕过 send-entry 的外部判断）；另有三处注入面漏点：identityPrefix 注入搭档名/仓库/邮箱、外部发送者回退成「搭档」、外部对话里人类发言走全权档。特性：受限档 speak/yield 窄实现、拒活类卡、中性身份、发送者中性化、conversation kind=external 作为对话级档位单源（fail-closed）、产物创建外部断言。"
change_type: feature
capability_test: "n/a: 纯代码权限收窄，非 LLM 行为采样面——由 tests/interface-adapters/agent-runtime/tools/external-restricted-surface.test.ts（14 例：参数面/副作用拒绝/身份段/标签/档位单源 fail-closed）与既有 external-session-profile.test.ts 装配断言覆盖"
intent:
  problem: "外部档的隔离是把工具**名单**收窄到 speak/yield，但这两个工具内部仍带全局写面与内部身份注入点——名单级隔离对「工具自带副作用」失明。同时档位判定只发生在消息级（source=external），一旦同一对话里出现非外部来源的消息（搭档从 web UI 发言）或后续 hop，就会拿到全工具档，而该对话历史里全是攻击者可控文本。"
  solution: "五个收口点：①ToolContext 增 externalRestricted（invoke 级、由 session 工厂按 externalProfile 注入，工具层不可抬升），speak 只收 body 且拒 html-card-play、yield 只许 to:['user'] 且不触发 matter/检视轮次/派工台账；②受限档身份段替换为中性常量（RESTRICTED_EXTERNAL_IDENTITY）；③resolveSignalSenderLabel 与 buildRoster 对外部 senderId 一律中性标签，禁读全局搭档显示名；④conversation kind 新增 external，agent-invoker 在 invoke 入口以对话级档位覆盖消息级（读不到对话类别时 fail-closed 抛错）；⑤createLinkedResourceTool 与 resource.link 路径的外部断言（防未来白名单加工具时默认打开）。"
  expected_effect: "外部用户诱导模型调用 healing/signal/活类卡/产物登记时全部机械拒绝，内部台账与全局记忆零新增；外部对话里搭档本人发言也受限；受限轮次 system prompt 不含任何内部身份信息；外部发送者不再显示为搭档。"
  verify_by:
    type: static_only
created_in_conversation: 0401284f-dff7-4927-af60-3516a984529d
tags: [external-profile, colink, isolation, security, tool-surface, prompt-injection]
modules:
  - agent-runtime
  - conversation
  - agent-framework
causal_links:
  - {type: "complements", id: "F20261118cldep", note: "同一 CoLink 通道的部署面；本特性收口其运行时的权限边界"}
---

# 外部接入对话隔离加固（F20261119extsg）

## 背景与判定

CoLink 是多用户平台，海獭是单用户的个人 agent。心愿口径三条红线：

- **R1**：外部用户 A/B 互不感知；
- **R2**：外部对话边界止于当前一个海獭对话，不得查其他数据；
- **R3**：外部消息不得借海獭泄漏到海獭系统本身或所在服务器。

隔离的**正确单位是 CoLink 可见性域**（DM = 一对一私域；频道 = 频道成员本来就互相可见），不是「每个用户」。

复核结论：主干（独立 durable session、仅 speak/yield 工具、dynamicContext 恒空、外发正文双向不入记忆索引）成立；
**破损点在「允许的工具」内部**与**每轮注入的身份段**——名单级隔离看不见工具副作用。

## 改动清单

| # | 改动 | 锚点 |
| --- | --- | --- |
| 1 | `ToolContext.externalRestricted`（invoke 级标记，session 工厂注入） | `usecases/ports/agent-tools.ts`、`frameworks/agent/tool-builder.ts`、`frameworks/agent/pi-session-factory.ts` |
| 2 | 受限档 speak 只声明/接受 `body`；拒 `healing`/`signal`；拒 `html-card-play`；跳过活类卡自动登记 | `tools/tool-factory.ts`（`RESTRICTED_SPEAK_PARAMETERS`/`RESTRICTED_SPEAK_DESCRIPTION`） |
| 3 | 受限档 yield 只接受 `to:['user']`+`reason`；拒 `expects_partner_decision`/`assignmentRole`；不执行 matter 登记等后置动作 | `tools/tool-factory.ts`（`restrictedYieldParamError`、`FULL_YIELD_PARAMETERS`） |
| 4 | 受限档身份段替换为中性常量（不再注入搭档名/对话标题/仓库/签名邮箱/大獭文案） | `session-helpers.ts` `RESTRICTED_EXTERNAL_IDENTITY`、`pi-session-factory.ts` |
| 5 | 外部发送者标签中性化（信号路由） | `usecases/conversation/signal-router.ts` `resolveSignalSenderLabel` |
| 6 | 外部触发不注入搭档名册行与「当前说话者」段 | `usecases/conversation/dispatch-chain-engine.ts` `buildRoster` |
| 7 | `conversation.kind` 新增 `external`；invoke 入口以对话级档位覆盖消息级（fail-closed） | `entities/conversation/conversation.ts`、`agent-invoker.ts` `externalProfileForConversationKind`、`conversation-controller.ts`、扩展 `otter-bridge.mjs` 建对话带 `kind:'external'` |
| 8 | 产物创建工具的外部断言兜底 | `tools/tool-factory.ts` `createLinkedResourceTool` |
| 9 | 每外部对话每日 token 额度（默认 200k，0=不限）；只计 input+output，invoke 前拒绝并回配置文案 | `config-service.ts`、`external-token-budget.ts`、`sqlite-invoke-repository.ts`、`agent-invoker.ts`、扩展 `otter-bridge.mjs`/`mention-handler.mjs` |
| 10 | 出站 SVG 渲染前拒绝主动内容/外部读取，限制画布 ≤2000px 与元素 ≤2000 | 扩展 `image-forward.mjs` |
| 11 | 附件去重 uploaderId 收窄为安装实例+DM/频道可见性域 | 扩展 `otter-bridge.mjs` |
| 12 | 最终消息组装（第三条标签路径）对外部发送者中性化，且外部对话不读全局搭档显示名 | `dispatch-chain-engine.ts` `resolveUserEntryLabel`/`resolvePartnerLabel`/`isExternalConversation`、`external-identity.ts` |
| 14 | 信号路由层（真实入口）按对话类别判档并中性化注入文本：冷启动 / steer / followUp 三条路径都不拼搭档真名，外部对话不走热旁路 | `signal-router.ts` `resolveExternalConversationProfile`/`resolveSignalLabel`/`externalProfile` 透传 |
| 13 | 存量外部绑定的懒升档：`PATCH /api/conversations/:id/kind` 单向 normal→external，适配器每轮事件前 ensure | `conversation-repository.ts` `updateKind`、`manage-conversation.ts` `promoteToExternal`、`conversation-controller.ts`、`router.ts`、扩展 `otter-bridge.mjs` `ensureExternalKind` |

## Why（关键取舍）

- **为什么动 ToolContext 而不只改提示词**：healing/signal 参数与活类卡登记都是**工具内部副作用**，提示词管不住；落库后 healing/signal 提醒会在后续**全权档**轮次被回注（`agent-invoker` 的 alert 注入），等于给外部文本开了一条进内部工作流的通道。
- **为什么拒 html-card-play 而不是静默不登记**：活类卡会在搭档的网页端自动运行（外部可控 JS），且外发到 CoLink 无意义；静默丢弃会让模型误以为已发送。因此显式拒绝并给出可执行替代（纯文本/普通卡）。
- **为什么档位必须是对话级**：消息级 `source=external` 只覆盖外部事件；搭档本人从 web UI 在同一对话里发言、或链上后续 hop，都会拿到全工具档，而上下文里是攻击者文本。对话级单源 + fail-closed 才堵住反向注入。
- **为什么发送者标签也要管**：模型看到的 `[chen] 请执行 X` 与 `[外部用户 4017] 请执行 X`，对提示注入的抵抗力完全不同——标签是边界块的实际执行面。
- **为什么额度不计 cache_read/cache_write**：缓存账面目数来自同一段上下文的重复发送，不是外部用户新增输入/输出；计入会让长上下文重发把日额度迅速耗空。日界固定 Asia/Shanghai，超额在 invoke 创建前 fail-closed。
- **为什么 SVG 在 sharp 前拒绝而非依赖渲染器**：SVG 是模型可控 XML，DOCTYPE/ENTITY、主动元素与外部 href 必须在解析器接触输入前被挡住；xmlns 的 http URI 只是命名空间标识，不作为网络引用误杀。
- **为什么附件按可见性域去重**：去重键是 `(sha256,uploader_id)`；全域共享 uploader 会让字节相同的图片命中其他 DM/频道的附件记录与原文件名。零 schema 变更，把 uploader 细化到安装实例与 DM/频道即可。

## Verification

- `tests/interface-adapters/agent-runtime/tools/external-restricted-surface.test.ts`：14 例
  - speak 参数面只 body / 显式传 healing、signal 被拒 / 活类卡被拒；普通档回归不变
  - yield 只 to+reason / 交给他獭被拒 / 带 expects_partner_decision 被拒 / 交回 user 放行且无待办注记
  - 中性身份段不含搭档名/仓库/邮箱；`buildInvokeSystemPrompt(..., 'restricted')` 无资产串
  - `resolveSignalSenderLabel` 外部 senderId 不回退搭档名
  - 档位单源：kind=external → restricted；normal → undefined；回读失败 fail-closed 抛错；kind 枚举含 external
- `tests/frameworks/agent/external-session-profile.test.ts`、`tool-universe.test.ts`：既有装配断言仍全绿
- 全量：`tests/usecases/conversation` 490 例、`tests/interface-adapters` 784 例全绿；`tests/frameworks`+`tests/usecases` 3957 例绿（唯一失败为 `durable-runtime` 的 SIGKILL fixture 需 dist 构建产物，与本改动无关）
- 扩展侧：`npm run test:extensions` 65 例全绿（含 SVG 危险输入不加载 sharp、正常 SVG/内部 use 可渲染、额度终态不重放、附件域隔离）
- 额度定向：core 4 文件 114 例全绿（配置默认/校验、上海日界、未超额/0/非外部放行、超额不建 invoke、SQLite 排除 cache 账目、HTTP 稳定码）
- D3 补测（`signal-router-entries.test.ts` 5 例，走真实路由链路而非下层组装）：kind=external 的网页发言在冷启动路径注入正文不含真名且按受限档点火 / 热路径 steer 被旁路改点火 / followUp 排队同样改点火 / 普通对话不误伤（仍带显示名且保留 steer）/ 类别回读失败 fail-closed
- D2 补测：`dispatch-chain-engine.test.ts` 外部标签 5 例（未配 resolver 不回退真名 / 配 resolver 仍中性 / kind=external 的 web 发言不注入显示名 / 普通对话不误伤 / 回读失败 fail-closed）；`manage-conversation.test.ts` 升档 4 例；`sqlite-conversation-repository.test.ts` `updateKind` 5 例；`tests/api/conversation.test.ts` PATCH kind 2 例；扩展 `otter-bridge.test.mjs` 懒升档 2 例

## 独立复核处置（D2）

独立检视（审计獭-external 对 head `a9909b05`）打回两点，均在本 PR 内闭环：

| 发现 | 性质 | 处置 |
| --- | --- | --- |
| `dispatch-chain-engine` 最终消息组装仍无条件读全局 `user.displayName`，未配置 `partnerResolver` 时回退 `partnerLabel`——外部触发渲染成搭档真名 | P0（#5/#6 只覆盖了信号路由与名册两个面，第三条面漏了） | 新增 `external-identity.ts` 单一实现（前缀判定 + 「外部用户 <尾4>」），`resolveUserEntryLabel` 在 resolver 判定**之前**中性化；新增 `resolvePartnerLabel`——kind=external 对话不读 settings，web 人类发言同样拿中性称呼；`isExternalConversation` 回读失败按外部处理（fail-closed） |
| 适配器只在新建时传 `kind:'external'`，上线前已存在的绑定仍 normal，「对话级受限」只对新对话成立 | P1（P1-6 口径①的迁移缺口） | 仓储 `updateKind`（`WHERE kind='normal'` 单向升档、拒绝降档）、用例 `promoteToExternal`（跨类别 fail-closed）、`PATCH /api/conversations/:id/kind` 只接受 `external`、适配器 `ensureExternalKind` 在每轮事件前 GET 类别并按需 PATCH（失败即抛，不降级放行） |

复核同时确认无需处置：SVG `feImage` 绝对/协议相对 URL 在黑名单下会被 sharp 渲染为空白且回环请求数为 0（未实证外读），后续可按元素白名单继续收紧。

D3 复审（同一检视者对 head `f40ef037`）又发现一处真实入口缺口，同 PR 闭环：

| 发现 | 性质 | 处置 |
| --- | --- | --- |
| `SignalRouter` 只按消息 `source==='external'` 出档，网页发言（`source='web'`）在 kind=external 对话里两条路径都泄漏全局显示名：热路径 steer/followUp 注入「来自 chen」，冷路径先拼 `[chen]` 再进已修的下层组装；且热旁路绕过 invoke 级档位 | P1（下层修了、真实入口没修；原测试直接调下层 assert，没覆盖链路） | `resolveExternalConversationProfile`（对话级判档，回读失败 fail-closed 按外部）→ 路由层用有效档位决定：外部对话不走 steer/followUp 旁路，`invokeTarget` 与 `executeChain` 收到 restricted；`resolveSignalLabel` 让注入文本对外部发送者用「外部用户 <尾4>」、对网页发言用中性称呼，冷/热两条路径共用 |

## 未纳入本特性（PR-B / 后续）

- **P0-1 中枢入口收口**：`server.host` 默认回环、非回环禁声明式身份头、读接口升档（单独 PR，动鉴权与部署面）
- P2-7 审计表/留存：搭档定案不做（对话原文已在 entries，拒绝走 journal）
