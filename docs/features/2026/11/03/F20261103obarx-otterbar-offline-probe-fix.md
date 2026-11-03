---
id: F20261103obarx
title: otterbar Dock 闪动双修：探活适配鉴权层 + renderer 离线驻留替代退出让位
summary: 2026-11-03 搭档目击 Dock 应用图标反复弹出消失（闪动）4 天。根因链：#1541 鉴权层合入后 /api/conversations 对裸探活 401 → status-core 恒判离线 → renderer「offline_long 退出让位」+ launchd KeepAlive/ThrottleInterval 60s = 「拉起-注册-秒退-注销」循环（日志 3646 条）。双修：探活带 X-Otter 身份头 + 401 特判（鉴权漂移≠离线）；renderer 长期离线改驻留空转（不再退出）。
change_type: fix
capability_test: tests/scripts/otterbar-offline-probe.test.sh
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
tags: [otterbar, scripts, auth, touchbar]
modules: [scripts]
created_at: 2026-11-03
---

# F20261103obarx：otterbar Dock 闪动双修

## 事故现场（2026-11-03 09:55 搭档报告）

「底下的菜单栏会弹出打开一个新应用、但立马又关了」「反复打开关闭，然后就变成闪动了」。

排查（fact 009d7e5c + 工作区 investigation-otterbar-dock-flicker-20261103.md）：

| 环节 | 证据 |
|---|---|
| Dock 闪动 | launchd 日志「Service only ran for 0 seconds. Pushing respawn out by 60 seconds」；每轮拉起 LaunchServices 注册应用、随即注销 |
| 退出原因 | /tmp/otterbar-swift.log 3646 条「exit: offline_long」（10/30 起） |
| 离线误判 | display-model.json 实测 offline_long=true，而主服务全程在线 |
| **真根因** | #1541（F20261016autz，10/19 合入）鉴权层：/api/conversations 裸探活 401 → curl -sf 失败 → 恒判离线 |
| 放大器 | renderer「offline_long → teardown 退出」设计（9/21 加入）× KeepAlive+ThrottleInterval 60s |

## 修复（双修 + 部署面）

### 修 1：status-core.sh 探活适配鉴权

- 探活请求带 `X-Otter-User-Id: otterbar-status-core` + `X-Otter-User-Role: admin` 身份头（身份中间件 #1322 声明式接缝，脚本声明 admin 档——单用户自部署现状，web 前端同档）
- 401 特判 fail-loud：带对头仍 401 = 鉴权口径漂移（非离线）→ stderr 记警告，不静默计离线——防「未来鉴权再变更又静默判离线 4 天」的复现面
- 探活分两段：先 HEAD-ish 取 http_code 判状态，200 再取 body（多一次请求换状态可观测，5s 轮询开销可忽略）

### 修 2：renderer offline_long 不再退出（驻留空转）

- 原：`offline_long → teardown(exit:0)` 让 launchd 低频拉起——本意省 CPU，实际与 KeepAlive 组成永久 Dock 闪动循环（任何一次真离线超 10 分钟 = 闪动开始）
- 新：驻留，继续 2s 轮询契约文件，离线徽章照常渲染；服务恢复即刻亮灯
- 代价：离线期间每 2s 一次契约文件读（NSFileManager 缓存友好）；省掉的代价：每 60s 一次 GUI 应用进程创建+LaunchServices 注册/注销（实测后者是用户可见噪音，前者不可感知）
- MTMR 让位退出保留（用户强意图信号，非本事故面）

### 部署面

- plist 的 ProgramArguments 启动前调 build.sh 增量编译——「二进制 9/3 vs 源码 9/21 差 18 天」由该机制自然解决（源码合入后下次启动自动重编译）
- 止血已先行：renderer-swift LaunchAgent 已 bootout+disable（2026-11-03 10:10，70s+ 零新拉起验证）；本 PR 合入后重新 bootstrap 即恢复

## 设计取舍

- **探活带 admin 头 vs 免鉴权 liveness 端点**：选前者。身份中间件自述「声明式接缝不是凭据校验」，运行时同机脚本带声明头与 web 前端同档，不新增 API 面免鉴权口子；后者要动策略表+路由，改动面大且「public 化一个端点」是安全方向相反的动作。401 特判是漂移保险丝。
- **renderer 驻留 vs 改 KeepAlive=false**：驻留。KeepAlive=false 服务恢复后不自动复活，bar 永久消失（更差）；驻留把「低频探测」从「进程重生」改为「进程内轮询」，消除 GUI 应用注册/注销的用户可见噪音。
- 机制识别检查点：无新增配置/状态/定时任务/持久化/被记住分支/跨模块路径——`Modification-Class: narrow-fix`（修法决策树①：otterbar 本该正确探活、renderer 本不该以闪动为代价省电）。

## 验证

### 失败证据链（修复前 → 修复后）

- **探活口径**（本机实测，主服务在线）：
  - 修复前（裸 curl）：`401` → status-core 恒判离线 → offline_long →（旧 renderer）60s 循环
  - 修复后（带身份头）：`200` + 真 JSON 数据
- **renderer 行为**（二进制对照实测）：
  - 修复前（9/3 旧二进制）：offline_long=true → 8 秒内退出，日志「exit: offline_long, sleep for launchd low-freq probe」
  - 修复后（本 PR 编译）：offline_long=true → 存活 8s+（驻留空转）
- swift build 通过 + `--selftest` PASS（本机 macOS，CI ubuntu 无法编译 AppKit——与 #713 本机实测矩阵策略一致）

### 回归测试

`tests/scripts/otterbar-offline-probe.test.sh`：
- 场景 A：status-core 探活 curl 含身份头（grep 断言源码形态）
- 场景 B：401 特判存在且写 stderr（鉴权漂移不静默）
- 场景 C：renderer 源码不含「offline_long 退位 teardown」路径（防回潮）

## 验收标准（断言化）

| 场景 | 预期 |
|---|---|
| 主服务在线 + 新 status-core | display-model.json sys_online=true（探活 200） |
| 服务真离线 >10min + 新 renderer | 驻留空转，Dock 零闪动，离线徽章渲染 |
| 鉴权口径未来再变更（带对头仍 401） | stderr 警告可见，offline_long 状态不变（不静默翻转） |
| MTMR 手动启动 | renderer 让位退出（保留行为） |

## 遗留问题（不本次修）

- 今晨 07:29/08:01 旧 bge-m3-worker 崩溃 2 次（新 worker 稳定）——独立问题，观察中，不与本次混修
- renderer-swift LaunchAgent 合入后需手动 bootstrap 恢复（止血 disable 的逆操作）
