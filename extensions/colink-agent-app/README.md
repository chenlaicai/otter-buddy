# CoLink Agent App（Otter 私聊与频道 PoC）

把 CoLink 个人空间私聊和项目频道接入现有 Otter Buddy。每个 `(deploymentId, installationId, conversationId)` 绑定一个 Otter Conversation；频道使用带 `channel:` 前缀的独立命名空间，创建时强制要求其中只有一只大獭。

Manifest 同时声明 `personal/project` 安装，并内联被动 SVG 海獭头像。协议字段全部取自 `@colink/app-sdk` 常量（扩展点、事件、权限），SDK 升级后由契约测试暴露漂移。

本目录是独立扩展，不修改 Otter 核心，也不直接读取模型密钥或调用模型供应商。CoLink 凭证不会写入 MCP 配置或 Otter 消息。

## 协议版本

- 目标协议：`@colink/app-sdk` **0.28.0**（pin 见 `sdk-pin.json`，含构建产物完整性摘要）。
- 事件入口：`app.user_message_received`（`app.mentioned` 在 0.28 已退役，私聊/话题/频道统一到这一个事件）。
- 回合能力：`ctx.source.listMessages` / `ctx.reply` / `ctx.sendProgress` / `ctx.setDisplayStatus` / `ctx.assertActive` / `ctx.colink.user|app`。
- 0.28 起 SDK 运行实现只有 `.mts` 源码，必须先构建再 vendor；`vendor/app-sdk` 由 `npm run prepare:sdk` 生成并**入库**（同时写 `sdk-pin.json` 记版本、sha512 与 CoLink 构建 commit），源码用相对路径导入，CI 无需先 `npm install` 即可跑契约测试。

## 运行前提

- Node.js `>=24.15.0`；
- 可访问的 Otter Buddy HTTP API；
- CoLink App 凭证和已授权的 personal 或 project 安装；
- 一份 CoLink 检出（用于构建 SDK 发行包）。

```bash
export COLINK_REPO=/path/to/colink
npm run prepare:sdk            # 构建 SDK 0.28.0 → vendor/app-sdk + 写 sdk-pin.json
npm install
cp .env.example .env           # 填好后由进程管理器安全注入，不要提交 .env
npm test
node --env-file=./.env src/app.mjs
```

默认仅回环监听；监听地址与端口由 `COLINK_BIND_HOST`/`COLINK_PORT` 决定（缺省 `127.0.0.1:8080`）。Otter API 默认是 `http://127.0.0.1:3000`。公网部署时由 nginx 终止 HTTPS 并反向代理到 App；不要公开 Otter API/Web 或 App 的实际端口。

## 升级旧部署（0.15 → 0.28）

老版本 bearer = `HMAC(COLINK_CREDENTIAL_KEY, 'colink-otter-mcp-v1:' + conversationId)`；新版本保留同一域分隔串，只换了密钥来源。因此有两条路：

1. **无缝（推荐）**：把 `COLINK_MCP_SECRET` 设为**旧的 `COLINK_CREDENTIAL_KEY` 原值**（≥32 字符即可，旧值通常是 64 位十六进制）。派生结果逐字节相同，已落盘的 `workspaces/<conversationId>/mcp.json` 不会被判成换人。
2. **换新密钥**：已绑定 Conversation 的旧 `mcp.json` 会与新 bearer 冲突（每次唤醒 409，不是只有第一次）。必须一次性清理：停 Otter 后删除这些 Conversation 的 `data/workspaces/<conversationId>/mcp.json`（下一轮由 Otter 重新写入），或改用新的 Conversation 绑定。

**状态文件也要换格式**（否则启动直接报 `Unsupported state format`）：0.15 落盘是 `format 1` + AAD=`COLINK_APP_INSTANCE_ID`，0.28 只认 `format 2` + AAD 固定 `colink-agent-state-v1`。用 `scripts/migrate-state.mjs` 原地迁移，授权类映射（安装授权 / 用户执行凭据 / 控制回执）原样保留，**不需要重新安装 App**：

```bash
# 先停服务；key/aad 取旧部署生效的那两个值
node scripts/migrate-state.mjs --source <旧 state.enc> --target <新 state.enc> \
  --key "$COLINK_CREDENTIAL_KEY" --aad "$COLINK_APP_INSTANCE_ID"
# 然后把 COLINK_STATE_FILE 指向新文件；旧文件留着回滚
```

迁移只丢弃 `events`（投递日志，旧行字段不符合 0.28 schema，且内容都是已终态事件）。脚本写盘后会用 SDK 自己的解码路径回读校验，写坏不了。

另：0.28 起监听地址/端口读 `COLINK_BIND_HOST`/`COLINK_PORT`，`HOST`/`PORT` 不再生效；`COLINK_API_BASE` 已由 SDK 派生，不再需要。

## 配置

见 `.env.example`。身份与连接（`COLINK_APP_ID`/`COLINK_APP_INSTANCE_ID`/`COLINK_CLIENT_ID`/`COLINK_CLIENT_SECRET`/`COLINK_SIGNING_SECRET`/`COLINK_ISSUER`）由 SDK 从环境读取并在创建运行时逐字段校验，错误码 `INVALID_APP_CONFIG`，不回显凭据。manifest 声明了 app 渲染视图，因此 `COLINK_APP_ORIGIN` 必填；宿主与主站不同源时再设 `COLINK_HOST_ORIGIN`。

SDK 状态（安装、OAuth、持久输出账本）保存在 `COLINK_STATE_FILE`（缺省 `./.colink/state.enc`）与旁边的 `.key`；该目录需持久化、备份、仅服务账号可读，且单进程单副本独占。本扩展自己的 `DATA_DIR` 只存外部会话 → Otter Conversation 映射，写入采用同目录临时文件加原子重命名，文件权限 `0600`。

`COLINK_MCP_SECRET`（>=32 字符）与上面的 CoLink 凭据分开管理：它是本扩展 MCP 代理的派生密钥，不参与平台鉴权。

个人 DM 与项目频道均不维护额外用户白名单：可接入个人空间的用户和已安装项目范围内的成员均可触发，由 CoLink 安装授权与事件验签负责；私密历史读取仍要求触发者本人具备 `messages:read-private` 委托。多人输入统一使用 `externalProfile=restricted` 外部安全档，不获得普通 Otter 的对话、记忆或编排能力。

App 通过回环管理接口 `PUT /api/conversations/:id/workspace/mcp-external` 让 **Otter 自己**写入对应 `workspaces/<conversationId>/mcp.json`，文件权限为 `0600`；App 不需要 Otter 数据目录的任何文件系统权限。该接口只接受任意名称的单个受限回环 HTTP server，拒绝 command、外部 URL、多个 server 和异常 bearer；已有其他 MCP 配置或全局同名配置时失败关闭，不覆盖。

MCP 代理的 bearer 由 `COLINK_MCP_SECRET` 按 Conversation 派生，**必须跨部署保持稳定**：Otter 的 `mcp-external` 写入守卫要求同一 server 的 `authorization` 与已落盘 `mcp.json` 完全一致，换 bearer 会让同一 Conversation 的第二轮直接 409、Agent 不启动（`src/usecases/conversation/manage-workspace.ts` 的 `isSameOwnedConfig`）。授权时效靠代理内的 active 映射：token 稳定，但只有当前轮在映射里，事件结束即失效，旧 Agent 无法借新事件授权。代理默认监听 `127.0.0.1:31131`（`COLINK_MCP_PORT`），不得加入公网反向代理或安全组。Server 名为 `colink_otter_history`，若 Otter 全局配置已有同名项会失败关闭，避免被其他工具源遮蔽。

新唤醒激活 bearer 前必须确认对应 Otter Conversation 没有旧 invoke 或待交棒执行。发现旧 invoke 时先调用 Otter abort 并等待真实终态，当前 CoLink 事件随后失败关闭，可在下一轮重试。

## 行为边界

- 接受 `reason=dm_message` 的私聊文本（含私聊话题内发言），以及 `reason=mention/reply` 且带 `channelId` 的频道文本；附件不在本期范围。
- 历史读取只有两个工具，资源与身份都由事件固定，调用方不能选择其他话题、频道、会话或身份：
  - `colink_read_topic` → `ctx.source.listMessages`：当前话题或当前私聊，平台按 `channelVisibility` 快照选身份（公共话题用安装 A，私密话题与私聊用本轮用户 U）；
  - `colink_read_channel` → `ctx.colink.app.channels.listMessages`（公共）/ `ctx.colink.user.channels.listMessages`（私密）：当前频道在话题根之前的背景。旧事件缺少可见性快照时失败关闭（`COLINK_CHANNEL_VISIBILITY_UNKNOWN`），不猜身份。
- App 会把当前事件定位、工具使用规则和用户原文一起交给 Otter；历史只作为数据，不作为高优先级指令。需求完整时不额外读取历史；只有 @ 时由 App 在 Agent 启动前确定性预读当前话题最近一页。
- `source=external` 与 invoke `externalProfile=restricted` 启用外部安全档：每轮独立受限 Session，不复用普通池；durable transcript 按 `external/<conversationId>/<otterId>` 隔离，不注入普通会话摘要或交接档案。编码/文件/bash、全局记忆和其他 MCP 均不进入工具面，只保留 speak/yield 与当前 CoLink 历史读取；yield 在落库和派发前仅允许 `to:["user"]`。
- CoLink user 与 invoke speak 均不写入全局记忆索引，也不触发裸 URL 后台 unfurl；频道正文、私聊和历史都按不可信输入处理，恶意套话不能获得其他对话、凭据或系统能力。
- MCP 配置在 Otter Session 创建时加载。首次部署或权限目录变化后，需要重启 Otter 服务以重建已有会话的工具注册；CoLink 凭证本身不随该配置持久化。
- 同一外部 DM 或频道内的消息串行处理；进程重启后保留映射，不宣称崩溃自动恢复或多副本能力。
- 最终回答以持久 `entries/invokes` 为准：App 从响应头 `x-otter-trigger-entry-id` 获取本轮精确 ID，只接受 `triggerEntryId` 相同的 invoke 及其关联 `speak`，不以正文或时间近似匹配旧轮次。必须等本轮 invoke/yield 链终态且交还用户，再取最后一个 `speak`；失败、无回答或超时都会让事件失败，不生成假成功文本。
- restricted invoke 崩溃后保持失败终态，不参与普通重启恢复，也不接受手动 retry；需要恢复时由 CoLink 新事件重新建立当轮授权与 bearer。
- 输出剥离 HTML 卡片和 healing 块，单条回复上限 60,000 字符（SDK 侧 `ctx.reply` 另有分段上限）。
- 当前安全档限制 Otter 工具与全局记忆，但不替代 CoLink 安装范围、成员管理和用户私密授权；仍按单进程单副本 PoC 运行，不宣称多副本或完整生产能力。

## 验证

```bash
npm test
```

真实联调至少验证：

1. 第一条 DM 记住暗号，第二条 DM 能回答；
2. 两轮进入同一个 Otter Conversation，且参与者只有一只大獭；
3. 项目频道中 @ App，确认回复落到原话题且同一频道续接同一 Conversation；
4. CoLink 收到最终回答，SDK 事件进入 `done`；
5. 让 App 总结当前话题，并追问话题根消息之前的频道背景；确认依次调用 `colink_read_topic`、`colink_read_channel`，回答与历史一致；
6. 在 DM 中追问较早的私聊内容，确认 `colink_read_topic` 读的是当前私聊，传 `cursor`/资源参数被拒绝；
7. 在频道只发 @，确认 App 先读取当前话题最近一页再启动 Agent，回复利用实际上下文而非凭空追问；
8. App 配置和代码中没有模型供应商密钥或直接模型请求，MCP 配置中没有 CoLink 长期令牌；连续两轮（第二轮走同一 Conversation 的 `mcp.json` 重写）都能正常唤醒 Agent。
