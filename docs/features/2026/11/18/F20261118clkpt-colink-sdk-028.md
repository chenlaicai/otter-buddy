---
title: CoLink App 协议 0.28 对齐——海獭插件适配层重写
id: F20261118clkpt
date: 2026-11-18
module: extensions
change_type: feature
status: active
summary: |
  CoLink 平台侧协议已从我们发现时锁定并 vendor 的 @colink/app-sdk 0.15.0 迭代到 0.28.0，
  SDK 整体重构：createCoLinkApp→createCoLinkRuntime、serveCoLinkApp→serveCoLinkRuntime、
  turn→ctx（数据统一收到 event.data）、事件 app.mentioned→app.user_message_received、
  turn.topic.readPrivate/readPublic→ctx.source.listMessages（身份由事件 channelVisibility
  快照固定）、turn.progress→ctx.sendProgress、interaction.setStatus→ctx.setDisplayStatus、
  turn.colink 扁平业务客户端→ctx.colink.user/ctx.colink.app 双身份，openEncryptedStore/
  validateIssuer/外部 store 全部取消（状态由 SDK 自管 state.enc + 自动密钥，配置走 COLINK_*）。
  新 SDK 的用户消息回合不再提供 turn.tools（tools.list/call 只在 Agent 适配器 AgentTurn），
  因此把「CoLink 历史读取包成 MCP 工具交给 Otter Agent」的工具面从 4 个重设计为 2 个：
  colink_read_topic（ctx.source.listMessages，身份由平台按可见性固定）与
  colink_read_channel（公共 ctx.colink.app / 私密 ctx.colink.user 的 channels.listMessages，
  缺可见性快照时失败关闭）。另：MCP 代理 bearer 仍按 conversation 用 HMAC 派生（新增独立密钥
  COLINK_MCP_SECRET），授权时效靠 active 映射保证——独立检视证明「每轮随机 token」会撞上 Otter
  mcp-external 写入守卫（同 server 换 bearer 即 409，第二轮 Agent 不启动）；SDK 打包链路从「整目录 cp」改为
  「CoLink distribution/build.mjs 构建 tgz → 解包 vendor + sdk-pin.json 记版本与完整性」，
  vendor 入库以便 CI 直接跑契约测试；manifest 升 0.6.0 并全部改用 SDK 常量声明。
intent:
  problem: "线上那版插件按 0.15.0 协议编写，而 CoLink 已换代（事件名、回合上下文、身份模型、清单校验白名单全变）：老代码在新平台上拿不到事件、读不了历史，清单里的旧协议字段也不再被识别；同时新 SDK 取消了 turn.tools，原四工具代理设计失去底层能力"
  expected_effect: "插件在新协议下行为等价：DM/频道消息仍映射到单獭 Otter Conversation，历史读取仍被限定在当前事件资源与平台固定身份内，回复仍以持久 entries/invokes 为准；差异是工具面收敛为 2 个只读工具、凭证模型收敛为每轮一次性 bearer、清单字段全部由 SDK 常量声明且随 SDK 升级可被测试捕获漂移"
  verify_by:
    type: behavior_check
    evidence:
      - "extensions/colink-agent-app npm test：26/26 通过（含工具面、身份选择、跨资源拒绝、每轮 bearer 失效、manifest 契约与 SDK pin 一致性）"
      - "仓库根 npm run test:extensions（CI 同款命令）：26/26 通过，无需先 npm install"
      - "冒烟：以 0.28.0 vendored SDK 启动 src/app.mjs，GET /healthz 200、/manifest.json 返回 version 0.6.0 与 events.types=[app.user_message_received]、/embed.html 200、/page-config.json 正常"
      - "SDK 构建锚：colink@a9525f46d 的 dev/app-toolkit/distribution/build.mjs 产出 0.28.0 包，sdk-pin.json 记录 sha512 完整性"
capability_test: "extensions/colink-agent-app/test/colink-tools.test.mjs"
---

# F20261118clkpt：CoLink App 协议 0.28 对齐

## 背景

搭档提出「colink 更新了 app 协议，更新海獭的 colink 插件」。核对结果：

- 本地 CoLink 检出当时落后 `origin/main` **160 个 commit**（停在 11-12 的 #3176），已 `merge --ff-only` 到 `a9525f46d`（11-18 09:21）。
- 我们 vendor 的 `@colink/app-sdk` 是 **0.15.0**，平台当前是 **0.28.0**；`colink.dm.actions` 扩展点在 #3341 已落地（`ExtensionPoint.DmActions`），F20261117dmact 的声明仍然有效。
- 0.15 时代的 `createCoLinkApp`/`turn.*` API 在 0.28 已不存在，属于**换代**而非版本号变更。

## 协议差异与迁移映射

| 旧（0.15.0） | 新（0.28.0） | 本插件处置 |
| --- | --- | --- |
| `createCoLinkApp({config, store, manifest, onMention})` | `createCoLinkRuntime({manifest, onEvent})` | 重写 bootstrap；配置与状态交给 SDK（`COLINK_*`、`state.enc`） |
| `serveCoLinkApp(app, {assets, pageConfig})` | `serveCoLinkRuntime(runtime, {views, assets})` | 嵌入页由 `views['otter.embed']` 按 manifest `entryPath` 托管 |
| `app.mentioned` | `app.user_message_received` | manifest `events.types` 换代 |
| `turn.input` / `turn.context` | `ctx.event.data` / `ctx.context` | 处理函数改读归一化事件数据 |
| `turn.topic.readPrivate/readPublic` | `ctx.source.listMessages`（身份按 `channelVisibility` 固定） | 私密/公共两套工具合并为一个 `colink_read_topic` |
| `turn.tools.list/call`（平台工具目录） | 用户消息回合不再提供 | 频道背景改走 `ctx.colink.app/user.channels.listMessages`，工具由本扩展自实现 |
| `turn.colink: BusinessClient`（扁平） | `ctx.colink.user` / `ctx.colink.app` | 按可见性选身份，不提供切换入口 |
| `turn.progress` / `interaction.setStatus` | `ctx.sendProgress` / `ctx.setDisplayStatus` | 本期不启用阶段输出，保持等价行为 |
| `openEncryptedStore` / `validateIssuer` / 外部 `store` | 取消，SDK 自管 | 删除 `COLINK_CREDENTIAL_KEY` 的 AAD 用途 |
| — | 每轮随机 bearer 更贴合「不跨事件复用授权」 | MCP 代理改用 `randomBytes` 一次性 token |

## 工具面重设计

原本 4 个工具（public/private × topic/channel）要由 App 猜可见性；0.28 把身份判定收进平台：

- **`colink_read_topic`**（事件来源读取）：`ctx.source.listMessages`。公共话题由安装 A 读（`messages:read-public`），私密话题与私聊由本轮用户 U 读（`messages:read-private`）。话题只接受 `limit/cursor`，私聊只接受 `limit/beforeId/afterId`。
- **`colink_read_channel`**（话题根之前的频道背景）：`channelVisibility=public` → `ctx.colink.app.channels.listMessages`；`private` → `ctx.colink.user.channels.listMessages`；`beforeMessageId` 固定为当前话题根。旧事件缺可见性快照时失败关闭（`COLINK_CHANNEL_VISIBILITY_UNKNOWN`），不猜身份、不回退成 App 身份。

两条路径都只接受分页参数，任何 `topicId/channelId/conversationId/userId/identity` 之类自选资源参数一律 `COLINK_TOOL_ARG_NOT_ALLOWED`（且先于可用性判断，避免参数错误掩盖越权尝试）。分页上限按来源分别对齐 0.28 权威约束：话题 `limit≤100`/`cursor≤2048`、私聊 `limit≤100`/`beforeId|afterId≤36`、频道 `limit≤50`/`cursor≤1024`。

## 凭证：为什么 bearer 必须稳定

Otter 的 `PUT /api/conversations/:id/workspace/mcp-external` 用 `isSameOwnedConfig` 校验：同一 server 名下的 `authorization` 必须与已落盘的 `mcp.json` 完全一致，不一致直接 `OTTER_MCP_CONFIG_CONFLICT`（409，`tests/interface-adapters/http/workspace-mcp-external.test.ts` 锁定该行为）。因此 bearer 一旦轮换，同一 Conversation 的第二轮在注册处就失败、Agent 根本不会启动。

结论：bearer 保持「按 Conversation 用 `COLINK_MCP_SECRET` HMAC 派生」的稳定形态，授权时效改由代理内部的 active 映射保证——token 稳定但只有当前轮在映射里，事件结束立即删除，旧 Agent 无法借新事件授权。`COLINK_MCP_SECRET`（≥32 字符）是本扩展自己的密钥，与平台凭据分开管理。

## 打包与 pin

0.28 的 SDK 源码只有 `.mts`，发行包需要构建。新的 `scripts/prepare-sdk.mjs`：

1. 调 CoLink 自己的 `dev/app-toolkit/distribution/build.mjs → buildSdkArchive()`（权威打包路径，含版本）；
2. 解包到 `vendor/app-sdk`（剔除 `examples`），不落中间 tgz；
3. 写 `sdk-pin.json`（版本 + `sha512` 完整性 + 构建来源 commit）；vendor 与 pin 作为一次一致更新换位，中途失败回滚到上一份，不留半套 vendor。

`vendor/` 从 `.gitignore` 移出改为入库，源码用相对路径 `../vendor/app-sdk/index.mjs` 导入 —— 这样 CI 的 `npm run test:extensions` 不必先在扩展目录 `npm install` 就能跑真实契约断言（此前 vendor 不入库，扩展测试也不触碰 SDK）。

## 验证

```bash
cd extensions/colink-agent-app && npm run prepare:sdk && npm test   # 26/26
cd <repo root> && npm run test:extensions                           # 26/26（CI 同款）
```

冒烟（本地回环 + 假凭据）：`/healthz` 200、`/manifest.json` version `0.6.0`、`events.types=['app.user_message_received']`、`/embed.html` 200、`/page-config.json` 返回 hostOrigin/issuer。

## 独立检视修正（检视獭）

- **阻断项已修**：随机 bearer 轮换 → 改为稳定派生（见上节），并补「同一 Conversation 连续两轮 `mcp.json` 全文一致」的回归测试（`test/otter-bridge.test.mjs` 复刻 `isSameOwnedConfig` 的 409 语义）。
- 工具分页上限按来源收紧到平台约束，并补边界断言。
- `prepare:sdk` 改为事务性换位 + 记录构建 commit，删掉不再生成的 `vendor/SDK-SOURCE.json`。
- 契约测试里 `dm.actions` 合法容器收紧为仅 `side_panel`；恢复真实 MCP Streamable HTTP 客户端互通测试；修正名不副实的 DM/频道断言。
- 清理过期引用：`package-lock.json` 去掉 `@colink/app-sdk` 依赖项，README 同步「vendor 入库」与 `COLINK_MCP_SECRET`。

## 未做与风险

- **未做真实 CoLink 联调**：需要搭档的真实安装与部署凭据，本轮只到本地回环冒烟 + 契约测试。协议 0.28 的 `ctx.source` 读取窗口（最近 100 条 business 投递）与私密授权行为需在真机确认。
- **线上旧版仍按 0.15 协议**：换代后老版本大概率已不工作；是否重新发布由搭档单独授权（与 matter M-a1e9ae26/M-eacebded 的发布授权口径一致）。
- **阶段输出未接入**：`ctx.sendProgress` 可在长回合给用户「正在处理」的可见进度，但需要 `progressOutput` 终态文案与新文案设计，另立一项。
- **Agent 协作事件未接入**：`app.collaboration_message_received`（Agent 间点名）会扩行为面，本期不订阅。
