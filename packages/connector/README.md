# @otter-buddy/connector

OtterBuddy 设备侧动作执行代理：连接中枢 WSS 网关（协议 v1），接收动作请求并在本机
workspace 执行、回执。轻量铁律——不加载模型/embedding/主记忆（依赖闭包仅 ws +
better-sqlite3 + node 内置）。

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
- SIGINT/SIGTERM 优雅下线（在途动作落 interrupted）

## 升级说明（阶段 6c 起）

- 升级子协议 pin：连接握手必须声明 `otter-connector.v1`——**旧版 connector（本包
  0.1.0 之前仓内直跑形态）连新中枢会被升级层拒绝**，装本包或升级本包即可，配对
  身份与协议状态机不变。
- 中枢公网部署（HTTPS/WSS）后 `--hub` 传 `https://` 地址即可（ws/wss 自动跟随）。

## 从仓内源码直跑（开发）

```bash
npm run build:connector   # 产物 packages/connector/dist（过依赖闭包断言）
node packages/connector/dist/connector/main.js --hub http://localhost:3000 ...
```
