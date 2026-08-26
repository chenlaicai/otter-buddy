# 飞书集成用户手册

本手册介绍如何将 otter-buddy 接入飞书，实现私聊与群聊双链路。

## 前置条件

- 一个飞书管理员账号（或有权在开放平台创建自建应用的账号）
- otter-buddy 服务已部署并可运行

## 一、创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/) → **开发者后台** → **创建企业自建应用**
2. 填写应用名称（如 `otter-buddy`）和描述

## 二、启用机器人能力

应用详情 → **添加应用能力** → 选择 **机器人**。

> 必选。没有机器人能力，用户无法与系统对话。

## 三、订阅事件

应用详情 → **事件与回调** → **事件配置**：

| 事件 | Event 类型 | 用途 |
|------|-----------|------|
| 接收消息 | `im.message.receive_v1` | 接收私聊与群聊消息（长连接方式，无需公网回调地址） |

订阅方式选择 **使用长连接接收事件**（WebSocket），otter-buddy 采用长连接接入，不需要公网 IP 和回调 URL。

## 四、开通 API 权限（关键）

应用详情 → **权限管理** → 搜索并开通以下权限：

| 权限标识 | 名称 | 必选 | 用途 |
|---------|------|------|------|
| `im:message` | 获取与发送单聊、群组消息 | **必选** | 收发私聊和群聊消息 |
| `im:message:send_as_bot` | 以应用身份发消息 | 必选* | 向会话发送消息（发消息子集，`im:message` 已覆盖时可不开） |
| `contact:user.base:readonly` | 获取用户基本信息 | 推荐 | 群聊多人识别：把消息发送者 open_id 换成姓名 |
| `im:chat:readonly` | 获取群信息 | 可选 | 排查群绑定问题、群名解析（暂未依赖，预留下步扩展） |

> ⚠️ **群聊不通的最常见原因**：只开了私聊相关权限（如 `im:message.p2p` 子集），群消息事件不会被推送。开 `im:message`（全量）可同时覆盖私聊与群聊。

> ⚠️ **群聊多人识别**：不开 `contact:user.base:readonly` 时，海獭仍能区分"是不同的人在说话"（open_id 唯一），但只能显示匿名 ID，无法显示姓名。开通后消息入库时自动快照发送者姓名。

权限开通后需**创建版本并发布**（或按提示发布生效），部分权限需管理员审批。

## 五、获取凭证并配置

1. 应用详情 → **凭证与基础信息** → 复制 **App ID** 和 **App Secret**
2. 编辑 otter-buddy 的 `config/config.yaml`：

```yaml
feishu:
  appId: "cli_xxxxxxxxxxxxxxxx"
  appSecret: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  # 事件加密密钥（可选，事件订阅页配置了 Encrypt Key 才需要）
  encryptKey: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

3. 重启 otter-buddy，日志出现 `Feishu long connection started` 即接入成功

## 六、建立对话绑定

系统通过 **Connection** 把飞书会话（私聊或群聊）绑定到对话：

1. **自动注册**：私聊或群聊里给机器人发第一条消息时，系统自动创建 Connection 并提示进入对话
2. **手动绑定**（Web 端）：连接管理页 → 创建 Connection，填入飞书会话 ID（`oc_` 开头）

绑定后即可在飞书里使用命令：

| 命令 | 作用 |
|------|------|
| `/list` | 查看所有活跃对话 |
| `/in <对话ID>` | 进入指定对话 |
| `/out` | 退出当前对话 |
| `/history` | 查看当前对话历史 |
| `/help` | 帮助 |

## 七、群聊使用要点

- **机器人入群**：把机器人拉进群后，群里任意成员发消息即触发（需已开 `im:message` 权限并发布生效）
- **多人识别**：开通 `contact:user.base:readonly` 后，海獭能识别群成员姓名（如 `[张三] 你好`）；未开通时以匿名 open_id 区分
- **一人一绑定**：每个飞书会话（群或私聊）对应一个 Connection，同一时间进入一个对话
- **Web 同步**：飞书侧发的消息会实时同步到 Web 端（含发送者姓名显示）

## 八、常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 私聊正常、群聊无响应 | 应用未开 `im:message` 群消息权限 | 权限管理开通 `im:message` 并发布版本 |
| 群里显示匿名 ID 而非姓名 | 未开 `contact:user.base:readonly` | 开通该权限；历史消息的姓名快照不回填，新消息生效 |
| 完全收不到消息 | 事件未订阅或长连接未建立 | 检查事件订阅含 `im.message.receive_v1`；看服务日志 `Feishu long connection started` |
| 发消息机器人无回复但提示"未进入对话" | Connection 未绑定对话 | 群里发 `/list` + `/in <对话ID>`，或 Web 端绑定 |
