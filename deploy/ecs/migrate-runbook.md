# 数据迁移与回退 runbook

> 特性：F20261119mgrr（#1868）。
> 工具：`scripts/migrate-export.mjs` / `migrate-restore.mjs` / `migrate-verify.mjs`。
> 原则：**停源导出、三级校验、回退保底、云端验证期不承诺双活**。

## 迁移数据域（白名单，代码内 MIGRATE_INCLUDES 单源）

主库 `otter-buddy.db` + `durable-sessions/`（每会话一库）+ `workspaces/` + `sessions/` + `attachments/` + `feishu/` + `metrics/` + `owner-password` + `backgrounds/`（用户背景图）+ `weixin/`（通道凭据）。
**不含**：models（关 bge 定稿）、backups、logs、rehearsal 旧库（云端新起）、
terminology（种子随 dist 部署，编译期 import）、execution-machines（执行机本地
真相，不迁移不备份——特性文档语义）、quota-browser（运行时 cache）、patches/
guard-replay 归档（历史存档，云端不重放）。

## 演练实证注记（2026-11-19 ECS 验证轮）

- 全链路耗时：在线导出 17min（12.2G→5.1G）→传输 ~1h（上行带宽硬顶）→restore 6min
  →verify 4min→起服首扫 22min（2 核；重启热缓存后快）
- 真切架构：**预热全量 + 停服窗口内 rsync 增量**（窗口分钟级，不陪 1h 传输）
- 双实例并存=定时任务双跑：真切序列本机停服后才起云端；验证实例验证完即停
- 布局约定：WorkingDirectory=数据根父（/var/lib/otter-buddy），./data/* 相对引用统一
- 磁盘纪律：restore 验证过后删 tar（峰值 92%→79%）

## 切换操作序列（真切）

1. **停源**：本机主服务停（`Ctrl-C` / `kill <pid>`）。export 自带 fail-closed 探活（127.0.0.1:3000 /api/ping 可达即拒）。
2. **导出**（本机仓库根）：
   ```
   node scripts/migrate-export.mjs
   # 产物：data/backups/migrate/migrate-<ts>.tar.gz + .manifest.json（~12G，gzip -1）
   ```
   一致性：sqlite 走 better-sqlite3 backup API（WAL 合并）；普通文件 clonefile 拷贝。
3. **传输**：`scp` / `rsync` 产物到 ECS（`sh .otter/deploy-keys/ecs-ssh.sh` 通道）。
4. **还原**（ECS，物理数据根 `/var/lib/otter-buddy/data`——代码根 /opt/otter-buddy/data 为 deploy.sh 建的指向此处的 symlink，restore 落物理根）：
   ```
   node scripts/migrate-restore.mjs --tar migrate-<ts>.tar.gz --data-dir /var/lib/otter-buddy/data
   # 默认拒非空目录（防误覆盖）；内置三级校验：文件 sha256 全量 + sqlite 表行数逐库逐表 + 多余文件检测
   ```
5. **起云**：`systemctl start otter-buddy`（探活就绪 + 单实例锁护数据域）。
6. **入口切换**：web 用 `https://otter.60.205.214.148.sslip.io/`；connector 换 `wss://…/connector-ws`。
7. **验证期巡检**：`node scripts/migrate-verify.mjs --data-dir <目标> --manifest <manifest>` 幂等重跑 + 内存曲线观察（`systemctl status`）。

## 回退剧本（云端验证不过 / 想回本机）

1. `systemctl stop otter-buddy`（云端停）+ nginx 站点摘除或保留（不入流量即可）。
2. 本机重启主服务（数据 = 切换点冻结快照，未删未改）。
3. 入口指回本机。
4. **语义边界（如实）**：云端验证期新写的数据（对话/记忆/会话）随回退**丢弃**——验证窗口压短（当天切当天定）可把损失面压到最低。
5. 云端数据留档不删（诊断/补捞价值），下次切换重新走 1-7。

## 演练（本机零风险空跑）

```
node scripts/migrate-export.mjs --data-dir <本机data> --out /tmp/mig-drill --skip-liveness
node scripts/migrate-restore.mjs --tar /tmp/mig-drill/migrate-<ts>.tar.gz --data-dir /tmp/mig-drill/restored
node scripts/migrate-verify.mjs --data-dir /tmp/mig-drill/restored --manifest /tmp/mig-drill/migrate-<ts>.manifest.json
```
全绿即工具链就绪。vitest 端到端（tests/scripts/migrate-tools.test.ts）是小数据集同构回归。

## 红线回顾

- **禁止双进程共写**：导出前停源 + 云端单实例锁双保险。
- **不留不可用中间态**：restore 校验不过即停（现场保留诊断），本机数据从未被破坏——任意时刻本机可重启。
