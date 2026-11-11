# CoLink Agent App（Otter 私聊与频道 PoC）

把 CoLink 个人空间私聊和项目频道接入现有 Otter Buddy。每个 `(deploymentId, installationId, conversationId)` 绑定一个 Otter Conversation；频道使用带 `channel:` 前缀的独立命名空间，创建时强制要求其中只有一只大獭。

Manifest 同时声明 `personal/project` 安装，并内联被动 SVG 海獭头像。`0.3.0` 起挂载 CoLink 历史读取工具：公共话题/频道使用 App 身份，私密话题/频道与 DM 使用当前用户身份。

本目录是独立扩展，不修改 Otter 核心，也不直接读取模型密钥或调用模型供应商。CoLink 凭证不会写入 MCP 配置或 Otter 消息。

## 运行前提

- Node.js `>=24.15.0`；
- 可访问的 Otter Buddy HTTP API；
- CoLink App 凭证和已授权的 personal 或 project 安装；
- `@colink/app-sdk` 源包目录。

```bash
export COLINK_SDK_SOURCE=/path/to/colink/dev/app-toolkit/sdk/javascript
npm run prepare:sdk
npm install
cp .env.example .env # 填好后由进程管理器安全注入，不要提交 .env
npm test
npm start
```

默认仅监听 `127.0.0.1:31130`，Otter API 默认是 `http://127.0.0.1:3000`。公网部署时由 nginx 终止 HTTPS 并反向代理到 App；不要公开 Otter API/Web 或 App 的实际端口。

## 配置

见 `.env.example`。`COLINK_ALLOWED_USER_IDS` 是逗号分隔的 CoLink 用户 ID 白名单，至少一项，**只限制个人 DM**，在线 PoC 填搭档本人账号。项目频道不应用该白名单：已安装范围内的成员均可 @ 触发，由 CoLink 安装授权与事件验签负责；私密历史读取仍要求触发者本人具备 `messages:read-private` 委托。

`DATA_DIR` 保存 SDK 加密状态和外部会话→Conversation 映射，目录应仅服务账号可读写并持久备份。单进程、单副本运行；映射写入采用同目录临时文件加原子重命名，文件权限为 `0600`。

App 通过回环管理接口 `PUT /api/conversations/:id/workspace/mcp-colink` 让 **Otter 自己**写入对应 `workspaces/<conversationId>/mcp.json`，文件权限为 `0600`；App 不需要 Otter 数据目录的任何文件系统权限。该接口只接受 `colink_otter_history` 的回环 HTTP 配置，拒绝 command、外部 URL、其他 server 和异常 bearer；已有其他 MCP 配置或全局同名配置时失败关闭，不覆盖。

每个 Conversation 使用独立的 HMAC bearer，仅在该 CoLink 唤醒执行期间映射到 SDK 的 `turn.tools`；事件结束后代理立即失效。MCP 代理只暴露四个历史读取工具，并限制为当前事件的 topicId/channelId；DM 固定读取当前会话，不接受其他 conversationId。代理默认监听 `127.0.0.1:31131`（可用 `COLINK_MCP_PORT` 修改），不得加入公网反向代理或安全组。Server 名为 `colink_otter_history`，若 Otter 全局配置已有同名项会失败关闭，避免被其他工具源遮蔽。

新唤醒激活 bearer 前必须确认对应 Otter Conversation 没有旧 invoke 或待交棒执行。发现旧 invoke 时先调用 Otter abort 并等待真实终态，当前 CoLink 事件随后失败关闭，可在下一轮重试；Otter 等待超时/中止也会先清理旧 invoke，再释放 active turn。这样旧常驻 Agent 不能在新事件里借用新用户或新话题授权。

`COLINK_STORE_AAD` 通常不需要设置，默认使用 `COLINK_APP_INSTANCE_ID`。仅为复用旧版本地“上下文验收助手”的加密状态时，才设置旧默认值 `colink-agent-state-v1`；新部署不要复用这个兼容项。

## 行为边界

- 接受 `reason=dm_message` 的私聊文本，以及 `reason=mention/reply` 且带 `channelId` 的频道文本；附件不在本期范围。DM 仅限白名单本人，频道允许安装范围内其他成员触发。
- 频道可按需读取当前话题及其根消息之前的当前频道历史；DM 可按需读取当前私聊历史。Manifest 声明 `messages:read-public/messages:read-private`，现有安装必须由用户重新授权后才会获得相应工具。
- App 会把当前事件定位、工具使用规则和用户原文一起交给 Otter；历史只作为数据，不作为高优先级指令。需求完整时不额外读取历史；只有 @ 时由 App 在 Agent 启动前确定性预读当前话题最近一页，意图/指代不明时由受限历史工具补充当前话题与频道背景。
- `source=colink` 与 invoke `externalProfile=colink` 启用外部安全档：每轮独立受限 Session，不复用普通池；durable transcript 按 `colink/<conversationId>/<otterId>` 隔离，不注入普通会话摘要或交接档案。编码/文件/bash、全局记忆和其他 MCP 均不进入工具面，只保留 speak/yield 与当前 CoLink 历史读取；yield 在落库和派发前仅允许 `to:["user"]`。
- CoLink user 与 invoke speak 均不写入全局记忆索引，也不触发裸 URL 后台 unfurl；频道正文、私聊和历史都按不可信输入处理，恶意套话不能获得其他对话、凭据或系统能力。
- MCP 配置在 Otter Session 创建时加载。首次部署或权限目录变化后，需要重启 Otter 服务以重建已有会话的工具注册；CoLink 凭证本身不随该配置持久化。
- 同一外部 DM 或频道内的消息串行处理；进程重启后保留映射，不宣称崩溃自动恢复或多副本能力。
- POST SSE 只作为通知，拿到响应后立即取消；最终回答以持久 `entries/invokes` 为准。
- 必须等本轮 invoke/yield 链终态且交还用户，再取最后一个 `speak`；失败、无回答或超时都会让事件失败，不生成假成功文本。
- 输出剥离 HTML 卡片和 healing 块，单条回复上限 60,000 字符。
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
5. 让 App 总结当前话题，并追问话题根消息之前的频道背景；确认实际调用公共话题/频道读取工具，回答与历史一致；
6. 在 DM 中追问较早的私聊内容，确认通过用户授权读取当前 DM，跨会话资源参数被拒绝；
7. 在频道只发 @，确认 App 先读取当前话题最近一页再启动 Agent，回复利用实际上下文而非凭空追问；
8. App 配置和代码中没有模型供应商密钥或直接模型请求，MCP 配置中没有 CoLink 长期令牌。
