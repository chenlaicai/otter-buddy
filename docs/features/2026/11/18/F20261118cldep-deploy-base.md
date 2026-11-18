---
id: F20261118cldep
title: ECS 部署底座（#1868 阶段 6 切片 6a）：systemd 正式单元 + 单实例锁 + 探活端点 + 嵌入开关 + 部署产物
change_type: feature
tags: [deployment, ecs, systemd, nginx, tls, single-instance, health-check, embedding-switch]
modules: [session, ci, web]
summary: 阶段 6 切片 6a：中枢可正式部署到 ECS（1.8G 内存机上）——数据库打开前单实例锁 fail-closed（活锁拒绝/崩溃残留接管，防双进程共写数据域红线）；OTTER_EMBEDDING=off 显式禁用 bge 嵌入（检索自动降级 FTS-only，升配后可恢复）；/api/ping 零依赖探活（public）；deploy/ecs/ 四件产物（systemd 正式单元、nginx TLS+WS 透传、certbot、deploy.sh）与 runbook。线上关 bge 是搭档资源定稿，TLS 沿 sslip.io 免域名先例。
intent:
  problem: "中枢仅能手动 node dist/src/main.js 跑在本机终端：无进程监管（挂了没人拉起）、无双进程防护（同时起两个会共写同一 SQLite 数据域——阶段 6 红线）、无探活端点（部署/监控无零依赖健康面）、嵌入模型 4.8G 在 1.8G 内存的 ECS 上跑不动（云端必须可显式关闭）"
  expected_effect: "ECS 可按 runbook 装出正式服务形态：systemd Restart=always + ExecStartPost 探活；数据库打开前单实例锁 fail-closed（活进程持锁即拒绝，崩溃残留自动接管）；/api/ping 无鉴权零依赖；OTTER_EMBEDDING=off 显式禁用嵌入（检索自动降级 FTS-only——消费侧既有降级链）"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/bootstrap/instance-lock.test.ts：获取/释放幂等、活锁拒绝（含同进程重入）、stale 接管（死 PID/损坏内容）、释放后重取（5 例）"
      - "tests/bootstrap/embedding-off-switch.test.ts：禁用契约面 available=false + embed 恒拒 + dispose 幂等（2 例）"
      - "tests/interface-adapters/http/identity-middleware.test.ts：策略矩阵 ping public + 裸 app 无身份 /api/ping 200 {ok,pid,uptimeSec}"
capability_test: "tests/bootstrap/instance-lock.test.ts"
---

# F20261118cldep：ECS 部署底座（阶段 6 切片 6a）

## 背景

#1868 阶段 6（云端部署与切换）第一步。资源定稿（搭档拍板 2026-11-18）：复用 colink 对接的
阿里云 ECS（2 核/1.8G 内存/40G 盘剩 19G），**线上关闭 bge 嵌入**（检索降级 FTS-only，
升配后放回模型文件即恢复）；TLS 沿机上先例 sslip.io + Certbot；swap 6G 已在。

## 变更清单

| 文件 | 内容 |
|---|---|
| `src/bootstrap/instance-lock.ts`（新） | 单实例锁（TCP 端口互斥，三轮检视迭代定稿）：dbPath 确定性派生回环端口（FNV-1a → 20000-32767，避开临时端口段），listen 独占——内核仲裁无 TOCTOU、进程死端口自动释放无 stale；同进程重入拒绝；锁文件仅持锁成功后写诊断 PID（非互斥依据） |
| `src/bootstrap/database.ts` | initDatabaseAndModels 开头 acquire（打开 DB 前）；dispose 链 release；`OTTER_EMBEDDING=off` 分支——跳过 ensureBgeM3Model + 不 fork 双 worker，注入 disabledEmbeddingServices（available=false + embed 恒拒） |
| `src/interface-adapters/http/router.ts` | `GET /api/ping` → `{ok,pid,uptimeSec}`（零依赖：不碰库/不上游） |
| `src/interface-adapters/http/identity-middleware.ts` | POLICY_TABLE public 段加 /api/ping |
| `deploy/ecs/otter-buddy.service`（新） | 正式 systemd 单元：Restart=always、MemoryMax=1280M、ExecStartPost 连探 60s、ProtectSystem=strict + ReadWritePaths=/var/lib/otter-buddy |
| `deploy/ecs/nginx-otter.conf`（新） | `otter.60.205.214.148.sslip.io`：80→443 重定向 + ACME webroot；443 反代 127.0.0.1:3000；/connector-ws Upgrade 透传（读写超时 3600s） |
| `deploy/ecs/setup-tls.sh`（新） | Certbot webroot 签发/幂等检查 |
| `deploy/ecs/deploy.sh`（新） | 本机 build → rsync（排除 data/models/.git）→ 远端 npm ci --omit=dev → restart → 探活（rsync 直连不可达回落 ssh+tar 管道） |
| `deploy/ecs/README.md`（新） | runbook：首次部署六步、替换 colink PoC 注意、单实例语义、回退路径 |

## 设计决策

- **锁放 initDatabaseAndModels 而非 main.ts**：护的是数据域（跟 dbPath 走），--config 隔离实例
  的 alpha 场景天然各自持锁互不干扰；同进程重入（二次 buildApp）同样拒绝——两份 DB 连接与双进程同罪。
- **禁用嵌入走 env 而非 config schema**：部署面开关（同 OTTER_OWNER_PASSWORD 模式），不进
  config.yaml——它控制的是「这台机器跑不跑嵌入」而非业务配置。
- **ping 零依赖**：systemd ExecStartPost 循环探活、nginx/监控探针都打它；不碰库不触发上游，
  起服即答（对齐「listen 先行」的启动语义）。
- **embed 禁用不新增降级代码**：searchVec 的 catch→FTS-only 回落是既有链路（D22），禁用服务
  的 embed 恒拒自然触发它——降级语义单点维护。

## 边界与已知残留

- 6a 阶段 ECS 是空库新起（无历史数据）；真数据 6b migrate-* 脚本迁移后才上
- deploy.sh 不碰 /var/lib/otter-buddy（数据域归 6b）；config.yaml/环境面按 runbook 手工首次配置
- colink-agent-app Requires=otter-buddy.service——替换 PoC 后 colink-agent 兼容（主中枢 API 超集）
- connector WSS 面当前靠 Bearer token（阶段 4 配对产物）；origin/升级鉴权强化在 6c

## Verification

| 验证 | 结果 |
|---|---|
| tsc --noEmit | EXIT=0 |
| 全量 vitest（495 文件） | 6260 全绿（净增 9 例：锁 6 + 嵌入开关 2 + ping 1） |
| eslint（改动文件） | EXIT=0 |
| 实机冒烟 | 6b 迁移演练时按 runbook 走（本 PR 不动线上） |
| ECS 部署链实证 | 双 node 并存（系统 22 + /opt/node24）与原生模块编译链（fs-ext 三重摩擦）已实测记录——最终选零依赖端口锁规避整条链 |

## Rollback

revert 单 commit：锁/开关/端点都是装配层增量，无 schema 迁移；deploy/ecs/ 产物为纯文件
（ECS 侧未安装则零影响）。
