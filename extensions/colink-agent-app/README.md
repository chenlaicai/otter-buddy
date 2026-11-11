# CoLink Agent App（Otter 私聊与频道 PoC）

把 CoLink 个人空间私聊和项目频道接入现有 Otter Buddy。每个 `(deploymentId, installationId, conversationId)` 绑定一个 Otter Conversation；频道使用带 `channel:` 前缀的独立命名空间，创建时强制要求其中只有一只大獭。

Manifest 同时声明 `personal/project` 安装，并内联被动 SVG 海獭头像。

本目录是独立扩展，不修改 Otter 核心，也不直接读取模型密钥或调用模型供应商。

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

见 `.env.example`。`COLINK_ALLOWED_USER_IDS` 是逗号分隔的 CoLink 用户 ID 白名单，至少一项；不在白名单中的事件会失败关闭。在线 PoC 只能填搭档本人账号，不得开放其他用户安装。

`DATA_DIR` 保存 SDK 加密状态和外部会话→Conversation 映射，目录应仅服务账号可读写并持久备份。单进程、单副本运行；映射写入采用同目录临时文件加原子重命名，文件权限为 `0600`。

`COLINK_STORE_AAD` 通常不需要设置，默认使用 `COLINK_APP_INSTANCE_ID`。仅为复用旧版本地“上下文验收助手”的加密状态时，才设置旧默认值 `colink-agent-state-v1`；新部署不要复用这个兼容项。

## 行为边界

- 接受 `reason=dm_message` 的私聊文本，以及 `reason=mention/reply` 且带 `channelId` 的频道文本；附件和历史读取不在本期范围。
- 同一外部 DM 或频道内的消息串行处理；进程重启后保留映射，不宣称崩溃自动恢复或多副本能力。
- POST SSE 只作为通知，拿到响应后立即取消；最终回答以持久 `entries/invokes` 为准。
- 必须等本轮 invoke/yield 链终态且交还用户，再取最后一个 `speak`；失败、无回答或超时都会让事件失败，不生成假成功文本。
- 输出剥离 HTML 卡片和 healing 块，单条回复上限 60,000 字符。
- 当前 PoC 不具备 external 工具权限档和跨 Conversation 全局记忆隔离，不得据此向其他真实用户开放。

## 验证

```bash
npm test
```

真实联调至少验证：

1. 第一条 DM 记住暗号，第二条 DM 能回答；
2. 两轮进入同一个 Otter Conversation，且参与者只有一只大獭；
3. 项目频道中 @ App，确认回复落到原话题且同一频道续接同一 Conversation；
4. CoLink 收到最终回答，SDK 事件进入 `done`；
5. App 配置和代码中没有模型供应商密钥或直接模型请求。
