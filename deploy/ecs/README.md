# ECS 部署 runbook（阶段 6a：部署底座）

> 特性：F20261118cldep（#1868 阶段 6 三步切片之首）。
> 范围：把中枢以正式形态部署到阿里云 ECS（60.205.214.148）。
> **不含**：数据迁移与真实切换（6b 的 migrate-* 脚本）、安全强化与演练（6c）。

## 目标拓扑

```
[本机] deploy.sh ──ssh 管道（.otter/deploy-keys/ecs-ssh.sh）──▶ /opt/otter-buddy（代码）
                            /etc/otter-buddy/config.yaml（配置）
                            /etc/otter-buddy.env（env 面：OTTER_EMBEDDING=off 等）
                            /var/lib/otter-buddy（数据持久卷——6b 迁移目标）
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

1. **替换 colink PoC 实例**（如旧 PoC 在跑）：
   `sudo systemctl disable --now otter-buddy`（旧 PoC 单元）；PoC 验证数据默认丢弃（不迁移）
2. **配置面**：
   - `/etc/otter-buddy/config.yaml`：沿 PoC 版（server.port 3000 / database.path `/var/lib/otter-buddy/otter-buddy.db` / llm models 走本机 apig 回环或真实 key——**从本机主中枢 config.yaml 拷贝 llm 段，勿用 PoC 占位 key**）
   - `/etc/otter-buddy.env`：
     ```
     OTTER_EMBEDDING=off
     OTTER_OWNER_PASSWORD=<本机同款或新口令>
     ```
3. **systemd 单元**：`sudo cp deploy/ecs/otter-buddy.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable otter-buddy`
4. **TLS**：先装 nginx-otter.conf 的 80 段（或整文件）→ `sudo bash deploy/ecs/setup-tls.sh` → 确认证书路径 → reload nginx
5. **代码部署**：前置——本机仓 `.otter/deploy-keys/ecs-ssh.sh`（免密 helper，私钥同目录、已 gitignore）与远端 `/opt/node24` 就绪。然后本机仓库根 `bash deploy/ecs/deploy.sh`（build → tar+ssh 管道 → 远端 npm ci → restart → 探活；传输统一走 ecs-ssh.sh 单一身份 admin）
6. **验证**：
   - `curl https://otter.60.205.214.148.sslip.io/api/ping` → `{"ok":true,...}`
   - 浏览器开 `https://otter.60.205.214.148.sslip.io/` 登录页
   - `systemctl status otter-buddy`（active + Memory 曲线）
   - connector 改连 `wss://otter.60.205.214.148.sslip.io/connector-ws`（6c 强化前的过渡面）

## 单实例语义（阶段 6 红线）

数据库打开前进程先拿 `<db-path>.otter-instance.lock`：第二个进程启动会**拒绝打开同一数据域**并报持锁 PID（防滚动替换期间双写）。崩溃残留锁（stale）由下次启动自动接管（PID 判活）。部署脚本 restart 间隔（stop→start）由锁释放保底。

## 回退

- 代码回退：重跑 deploy.sh（上一版 git commit 检出后构建）
- 数据回退：6b 的迁移快照保留在本机（本方案下中枢数据 6b 之前仍在本地——ECS 上 6a 阶段是空库新起）
- 整机回退：`systemctl disable --now otter-buddy && nginx conf 移除`——恢复 colink PoC 或空机

## 已知边界

- 6a 阶段 ECS 是**空库新实例**（无历史对话）——真数据在 6b 迁移后才上云
- colink-agent-app 依赖 `otter-buddy.service` 存在（Requires=）——替换后 colink-agent 不受影响（主中枢 API 是 PoC 超集）；但 PoC 的对话数据不迁移
- 阶段 6c 将加 connector WSS 升级鉴权强化与 packages 化，当前 wss 面靠 Bearer token（阶段 4 配对码产物）
