---
id: F20261119cwssp
title: connector 安全强化与独立分发（#1868 阶段 6 切片 6c）：WSS 升级双查 + packages 化
change_type: feature
tags: [connector, security, websocket, packaging, deployment]
modules: [src/frameworks/execution/connector-ws-gateway.ts, src/entities/execution/connector-protocol.ts, src/connector/main.ts, packages/connector/, scripts/package-connector.mjs]
summary: 阶段 6 切片 6c（代码半）：公网暴露面前的 connector 通道强化——WSS 升级请求在阶段 4 Bearer token 之上加双查（①子协议 pin：Sec-WebSocket-Protocol 必须声明 otter-connector.v1，通用 WS 客户端/扫描器挡在升级握手层，hub handleProtocols 回显完成协商；②Origin 白名单 OTTER_WS_ALLOWED_ORIGINS exact match，带 Origin 必须命中、未配置 fail-closed 全拒、无 Origin 的 node 客户端放行——CSWSH 纵深防御）+ connector packages 化独立分发（packages/connector npm 包：bin otter-connector、依赖闭包仅 ws+better-sqlite3、闭包断言随迁、package-connector.mjs 打包器做版本一致性校验与 bin 可执行位）。旧版客户端连新中枢会被升级层拒（有意 breaking，装新包即解，配对身份不变）。
intent:
  problem: "中枢要公网部署（nginx TLS + WSS 透传），connector-ws 通道从「本机无威胁面」变公网暴露——阶段 4 的 Bearer token 查只验秘密不验来源与指纹：扫描器/通用 WS 客户端能进到 token 校验路径、浏览器跨站页理论上可尝试 CSWSH；同时 connector 仍以仓内 dist 路径分发（node dist/connector/connector/main.js），设备侧安装无版本、无 bin、无独立依赖声明"
  expected_effect: "升级层三查（子协议 pin → Origin 白名单 → Bearer token）：指纹不符在 400/403 层拒、来源不符 403、秘密不符 401；connector 以 npm tarball 分发（npm i -g → otter-connector 命令），版本与主仓锁定同步，依赖闭包断言迁至 packages/connector/dist 继续把守轻量铁律"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/frameworks/execution/connector-ws-gateway.test.ts 新增 4 用例：缺子协议拒（含错误子协议）、白名单未配置 fail-closed 拒带 Origin 而放行无 Origin、白名单命中放行/未命中拒（含子串仿冒）、双查与 token 组合面"
      - "npm run package:connector 产出 tarball（18.7kB/13 文件）+ 临时目录 npm i 冒烟：bin otter-connector 可执行（shebang+chmod）、ws/better-sqlite3 依赖装齐、usage 正常输出"
capability_test: "tests/frameworks/execution/connector-ws-gateway.test.ts"
---

# F20261119cwssp：connector 安全强化与独立分发（阶段 6 切片 6c）

## 背景

阶段 6a（#1945）部署底座 + 6b（#1953）迁移工具链就位后，真切 ECS 前剩两件工程事：
公网暴露面前的 connector 通道强化（本切片）与演练轮（运行时步骤，另约窗口）。
阶段 4 的升级鉴权只有 Bearer token 一查——本机环境够用，公网上威胁面不足。

## 升级请求三查（handleUpgrade 内序）

| 序 | 查 | 拒 | 放行 | 防的 |
|---|---|---|---|---|
| ① | 子协议 pin：Sec-WebSocket-Protocol 必须含 `otter-connector.v1` | 400 | 声明即过（hub `handleProtocols` 回显完成握手协商） | 通用 WS 客户端/扫描器——不进 token 查询路径，指纹层即拒 |
| ② | Origin 白名单（`OTTER_WS_ALLOWED_ORIGINS`，逗号分隔 exact match） | 403 | 无 Origin（node 客户端）放行；带 Origin 命中白名单放行 | 浏览器 CSWSH 与跨站探测——authorization 头虽难伪造，纵深防御 + 暴露面收紧 |
| ③ | Bearer token（阶段 4 原有） | 401 | 库内有效设备 token | 秘密校验（不变） |

- 白名单未配置（默认/空）= **fail-closed 拒所有带 Origin 请求**——connector 是 node
  客户端不发 Origin，零影响；将来引入浏览器 WS 客户端时将页面 origin 配入即可。
- exact match 不吃子串仿冒（`https://otter.example.com.evil.com` 不命中）。
- nginx（6a 配置）默认透传 Sec-WebSocket-Protocol 与 Origin 头，无需改。

## packages/connector 独立分发

```
packages/connector/
  package.json   # @otter-buddy/connector，bin: otter-connector → dist/connector/main.js
  README.md      # 安装/配对/运行语义/升级 breaking 说明
  dist/          # 构建产物（gitignore，npm run build:connector 生成）
  release/       # npm pack tarball（gitignore，npm run package:connector 生成）
```

- `tsconfig.connector.json` outDir 迁至 `packages/connector/dist`（并关闭
  declaration/sourceMap——内部消费不需要）；`check-connector-closure.mjs` distRoot 随迁，
  轻量铁律断言（禁模型/embedding/记忆节点 + 相对 import 逃逸检测）原样把守。
- `scripts/package-connector.mjs` 打包器：版本一致性校验（packages/connector vs 主仓
  package.json，防漂移）→ bin 产物 chmod +x（shebang 文件 npm pack 不自动加执行位）→
  npm pack 落 release/。
- 依赖声明只 `ws` + `better-sqlite3`（版本对齐主仓），与闭包断言白名单一致。

## 兼容性（有意 breaking）

升级子协议 pin 生效后，**旧版 connector（6c 之前仓内直跑形态）连新中枢被 400 拒**。
处置：装/升级 packages/connector 打出的 tarball——配对身份（device.json）与协议
状态机不变，只换客户端进程。切换窗口期（真切 ECS 前后）设备侧统一升包，演练轮
全链路用新包验证。

## 验证

- gateway 端到端 12 用例全绿（8 原有 + 4 新增：双查各查独立行为 + 组合面）。
- `npm run build:connector` → 闭包断言过 → `npm run package:connector` → tarball
  18.7kB/13 文件 → 临时目录 `npm i <tarball>` → `npx otter-connector` usage 冒烟通过。
