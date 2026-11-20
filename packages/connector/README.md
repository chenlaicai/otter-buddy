# @otter-buddy/connector

OtterBuddy 设备侧动作执行代理：连接中枢 WSS 网关（协议 v1/v2 双栈），接收动作请求并在本机
workspace 执行、回执；v2 增加 shell.exec 流式输出、取消、超时与进程组收尾。
轻量铁律——不加载模型/embedding/主记忆（依赖仅 ws + better-sqlite3 +
pi-durable/chord context 执行底座 + node 内置）。

## 安装（从中枢仓构建的 tarball）

```bash
npm i -g otter-buddy-connector-<version>.tgz
```

## 首启配对

中枢侧生成一次性配对码（`node scripts/connector-pair.mjs`，TTL 内单次核销）：

```bash
otter-connector --hub https://otter.example.com --pair <配对码> --name <设备名>
```

配对成功后身份落 `~/.otter/connector/device.json`（deviceId + pairToken），后续直连：

```bash
otter-connector --hub https://otter.example.com
```

## 运行语义

- 断线自动重连（指数退避 1s→30s；重连=新会话，旧会话在途动作按 sid 代际隔离）
- 心跳半开自愈（3 间隔无 ack 判死重连）；协议版本不兼容=致命错误退出（升级本包）
- 动作台账落 `~/.otter/connector/<deviceId>/action-ledger.sqlite`（机器侧真相源，崩溃恢复）
- shell.exec 在 `<connector 数据根>/workspaces/<conversationId>` 执行；输出流式回传，
  timeout/abort 只杀对应命令进程组；spillPath 是设备本机诊断路径
- SIGINT/SIGTERM 优雅下线（先取消在途进程组，再将动作落 interrupted）

## 升级说明

- 升级子协议 pin：连接握手声明 `otter-connector.v2` 与 `otter-connector.v1`，
  双方取支持交集最高版本。v1 会话保留六动作；远程 bash 需要 v2，旧端不会被
  静默当作支持新能力。
- 中枢公网部署（HTTPS/WSS）后 `--hub` 传 `https://` 地址即可（ws/wss 自动跟随）。

## 从仓内源码直跑（开发）

```bash
npm run build:connector   # 产物 packages/connector/dist（过依赖闭包断言）
node packages/connector/dist/connector/main.js --hub http://localhost:3000 ...
```
