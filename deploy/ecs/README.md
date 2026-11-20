# ECS 部署 runbook（部署底座）

> 特性：F20261118cldep（#1868 阶段 6 三步切片之首）。
> 范围：把中枢以正式形态部署到阿里云 ECS（60.205.214.148）。
> **不含**：数据迁移与真实切换（migrate-* 脚本）、安全强化与演练。

## 目标拓扑

```
[本机] deploy.sh ──ssh 管道（.otter/deploy-keys/ecs-ssh.sh）──▶ /opt/otter-buddy（代码）
                            /etc/otter-buddy/config.yaml（配置）
                            /etc/otter-buddy.env（env 面：OTTER_EMBEDDING=off 等）
                            /var/lib/otter-buddy/data（数据物理根——6b 迁移 restore 目标；代码根 /opt/otter-buddy/data 为指向此处的 symlink，deploy.sh 创建）
[ECS]
  nginx(443, otter.60.205.214.148.sslip.io) ──▶ 127.0.0.1:3000
                                                  ├─ /            中枢 HTTP（web UI + API）
                                                  └─ /connector-ws connector WS（Bearer token 鉴权）
  otter-buddy.service（systemd，Restart=always，MemoryMax 1280M，ExecStartPost 探活）
```

## 资源定稿（搭档拍板）

- 机型现状：2 核 / 1.8G 内存 / 40G 盘（剩约 19G）；**线上关闭 bge 嵌入**（`OTTER_EMBEDDING=off`）——记忆检索降级 FTS-only，语义召回缺失；升配后放回模型文件+去掉开关即恢复
- swap 6G 已在（/swapfile）；迁移集约 12G（models 不迁）
- TLS：sslip.io 免域名方案（沿 colink-agent 先例），Certbot 自动续期

## 首次部署步骤

1. **替换海獭 CoLink PoC 体系**（终态：本机只跑一个海獭系统进程）：
   `sudo systemctl disable --now otter-buddy`（PoC 中枢退役，验证数据默认不迁移）。
   colink-agent-app 是海獭的 CoLink 通道适配（独立轻进程，OtterBridge 连中枢 API）——
   过渡期保留（CoLink 对接不能断），待 CoLink 能力并入主中枢进程后退役；
   其 `Requires=otter-buddy.service` 在新单元安装后自然满足
2. **配置面**：
   - `/etc/otter-buddy/config.yaml`：沿 PoC 版（server.port 3000 / database.path `./data/otter-buddy.db`（相对 WorkingDirectory=/opt/otter-buddy，经 data symlink 落 /var/lib/otter-buddy/data 物理数据根）/ llm models 走本机 apig 回环或真实 key——**从本机主中枢 config.yaml 拷贝 llm 段，勿用 PoC 占位 key**）。数据迁移（6b 工具）restore 目标 = `/var/lib/otter-buddy/data`（物理根，与 symlink 布局对齐）
   - `/etc/otter-buddy.env`：
     ```
     OTTER_EMBEDDING=off
     OTTER_OWNER_PASSWORD=<本机同款或新口令>
     OTTER_SERVICE_TOKEN=<openssl rand -base64 32>
     ```
     `OTTER_SERVICE_TOKEN` 是 HTTP 面给「会跳反代/跨主机」的集成方（当前就是同机的 colink-agent-app）留的唯一可编程凭据：中枢只让**本机直连**用声明式身份头（`X-Otter-User-*`），一旦经 nginx 或走公网域名，声明式头一律拒（401）——那是伪造面。所以 App 侧 `/etc/colink-agent-app.env` 必须给同一个值（`OTTER_SERVICE_TOKEN=<同值>`），扩展便会用 `Authorization: Bearer` 而不是声明式头；两边不同值＝App 侧稳定 401。
3. **systemd 单元**：`sudo cp deploy/ecs/otter-buddy.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable otter-buddy`
4. **TLS**：先装 nginx-otter.conf 的 80 段（或整文件）→ `sudo bash deploy/ecs/setup-tls.sh` → 确认证书路径 → reload nginx
5. **代码部署**：前置——本机仓 `.otter/deploy-keys/ecs-ssh.sh`（免密 helper，私钥同目录、已 gitignore）与远端 `/opt/node24` 就绪。然后本机仓库根 `bash deploy/ecs/deploy.sh`（build → tar+ssh 管道 → 远端 npm ci → restart → 探活 → App unit 同步与版本核对；传输统一走 ecs-ssh.sh 单一身份 admin）
   - **一次部署覆盖两个 unit**（2026-11-19 起）：`otter-buddy`（中枢，`/opt/otter-buddy`）与 `colink-agent-app`（CoLink App 扩展，`/opt/colink-agent-app`）。脚本第二段把中枢里的 `extensions/colink-agent-app/` 同步到独立 unit 目录、留备份、重启，并核对 `manifest.json` 的 `version` 与源清单一致——不再接受「脚本说成功、App 版本却没跟上」。
   - 打包排除 macOS resource fork（`._*`）与 `.DS_Store`：这类文件不是内容，带上线会让文档同步整片报 `Missing frontmatter`（2026-11-19 实证 7914 个）。
   - **两段的成功判据不同，但都不是「命令 exit 0」**：中枢看 `/api/ping` 存活（该端点只返回 ok/pid/uptime，**不含版本**，所以它判的是「起来了」而非「版本对」）；App 看内部端口 `manifest.json` 的 `version` 字段是否等于源清单（JSON 解析，不用行内正则——一行 JSON 里还有 extensionPoint 的 1.0.0）。
   - **半部署语义（四种状态，失败时现场可能只变了一半）**：
     | 状态 | 现场 | 处置 |
     | --- | --- | --- |
     | 中枢磁盘已换装、进程未重启 | `/api/ping` 探活超时，但 `/opt/otter-buddy` 已是新树 | `systemctl restart otter-buddy`；仍起不来按「回退」节检上一版重跑 |
     | 中枢已重启、依赖残缺 | 进程反复 `ERR_MODULE_NOT_FOUND` | 依赖闭包校验会先拦；漏网时按 lock 就地安装后重启 |
     | App 磁盘已同步、进程未更新 | 内部端口 `manifest.json` 版本与源清单不符 | `systemctl restart colink-agent-app`，或回灌备份目录 |
     | App 重启失败 | unit activating/failed、端口不通 | `journalctl -u colink-agent-app` 看首行错误；回灌备份 |
     判据只看「实际对外声明的版本 / 存活」，因为「磁盘更新了」不等于「进程在用新代码」，只有后者对线上行为有意义。
   - **App 目录同步排除 `node_modules`**，依赖由独立安装步骤管（扩展有 sharp 这类自有生产依赖）。装完脚本会做依赖闭包校验：清单里每个 dependency 必须在 `node_modules` 有目录——缺包不会让探活失败，只会在用到该能力时炸。
   - **中枢 `npm ci` 失败时的回退**：这台机 `onnxruntime-node` 安装脚本要下载二进制、源不可达（云端 `OTTER_EMBEDDING=off`）。脚本先试 `npm ci`，失败退回「按 lock 就地安装 + 跳过安装脚本」，随后仍做依赖闭包校验 + `/api/ping` 探活。
6. **验证**：
   - `curl https://otter.60.205.214.148.sslip.io/api/ping` → `{"ok":true,...}`
   - 浏览器开 `https://otter.60.205.214.148.sslip.io/` 登录页
   - `systemctl status otter-buddy`（active + Memory 曲线）
   - connector 升级新包后改连 `wss://otter.60.205.214.148.sslip.io/connector-ws`（安装：`npm i -g otter-buddy-connector-<ver>.tgz`，命令 `otter-connector --hub https://otter...`——升级子协议 pin 生效后旧版客户端（仓内直跑形态）会被 400 拒，装包即解，配对身份不变）

## 单实例语义（阶段 6 红线）

数据库打开前进程先拿 `<db-path>.otter-instance.lock`：第二个进程启动会**拒绝打开同一数据域**并报持锁 PID（防滚动替换期间双写）。崩溃残留锁（stale）由下次启动自动接管（PID 判活）。部署脚本 restart 间隔（stop→start）由锁释放保底。

## 回退

- 代码回退：重跑 deploy.sh（上一版 git commit 检出后构建）
- App 扩展回退：`sudo rm -rf /opt/colink-agent-app && sudo cp -a /opt/colink-agent-app.bak-<时间戳> /opt/colink-agent-app && sudo systemctl restart colink-agent-app`（deploy.sh 每次部署留备份，只保留最近 3 份）
- 生产依赖面红线：`npm ci --omit=dev` 要求 `dependencies` 与 `devDependencies` 零重叠——同一个包两边都写时 npm 取 dev 那份，生产安装直接跳过，服务启动即 `ERR_MODULE_NOT_FOUND`（2026-11-19 实证：`hono`）。机械闸 `scripts/check-dependency-sections.mjs` 在 CI `check` 段守着。
- 数据回退：迁移快照保留在本机（本方案下中枢数据迁移前仍在本地——ECS 上部署阶段是空库新起）
- 整机回退：`systemctl disable --now otter-buddy && nginx conf 移除`——恢复 colink PoC 或空机

## 已知边界

- 部署阶段 ECS 是**空库新实例**（无历史对话）——真数据在数据迁移后才上云
- **终态进程拓扑（搭档定稿）**：这台机只有一个海獭系统——主中枢进程（含全部模块能力）；
  PoC 中枢（263M）退役让位，colink-agent-app（~几十 M，CoLink 通道适配）过渡保留至
  能力并入；内存账：系统服务 ~500M + 主中枢（关 bge）400-700M + swap 6G 兜底，余量健康
- connector WSS 升级鉴权强化与 packages 化已落地：升级层三查（子协议 pin → Origin 白名单 → Bearer token，见 F20261119cwssp）；Origin 白名单 `OTTER_WS_ALLOWED_ORIGINS` 当前保持空（fail-closed 拒带 Origin 请求，connector node 客户端不受影响）
