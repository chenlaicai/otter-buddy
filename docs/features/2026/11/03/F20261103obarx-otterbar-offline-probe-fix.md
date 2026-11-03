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

### 修 1：status-core.sh 探活适配鉴权（检视轮#1 后重写）

- 单请求取 code+body（curl -w 追加状态码尾行，免双请求竞态与双倍开销）
- 身份头降 user 档（GET /api/conversations 需 authenticated 即可，最小权限；检视建议#4）
- 三分类返回：0=在线写 model；2=口径漂移（401/403/404——服务可达但探活口径过时）stderr 警告 + **MODEL_FILE 不动 + 主循环冻结离线计时**；1=真离线（拒连/超时/5xx）累积计时超窗翻转
- 语义要点：漂移不计离线（初版只做了 stderr 可见性、语义上仍计离线——检视严重#1 抓实，本轮重写兑现）；403/404 一并纳入（鉴权/路由漂移同类，检视建议#2）

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
  - 修复后（带身份头）：`200` + 真 JSON 数据（user 档实测 200）
- **renderer 行为**（二进制对照实测）：
  - 修复前（9/3 旧二进制）：offline_long=true → 8 秒内退出，日志「exit: offline_long, sleep for launchd low-freq probe」
  - 修复后（本 PR 编译）：offline_long=true → 存活 8s+（驻留空转）
- **三态运行时验证**（检视轮后补，复刻检视獭 mock 方法，加速参数 POLL=1s/WINDOW=2s）：
  - 持续 401 跑 6s（超窗 3 倍）：MODEL_FILE 不生成（保持不动）、stderr 漂移警告在位、offline_long 不翻——初版实现此处会翻 true（检视严重#1 的复现器）
  - 拒连跑 8s：offline_long=true（真离线路径不回归）
  - 在线 200：sys_online=true, offline_long=false
- swift build 通过 + `--selftest` PASS（本机 macOS，CI ubuntu 无法编译 AppKit——与 #713 本机实测矩阵策略一致）

### 回归测试

`tests/scripts/otterbar-offline-probe.test.sh`：
- 场景 A：status-core 探活含身份头（user 档）+ 单请求 code+body 形态（grep 断言源码形态）
- 场景 B：401/403/404 漂移特判 fail-loud（stderr）+ return 2 语义 + 主循环冻结分支存在
- 场景 C：renderer 源码不含「offline_long 退位 teardown」路径（行内注释过滤，防回潮；反例形态自验过能抓回潮）

## 验收标准（断言化）

| 场景 | 预期 |
|---|---|
| 主服务在线 + 新 status-core | display-model.json sys_online=true（探活 200） |
| 服务真离线 >10min + 新 renderer | 驻留空转，Dock 零闪动，离线徽章渲染 |
| 鉴权口径未来再变更（带对头仍 401/403/404） | stderr 警告可见；MODEL_FILE 保持最后已知状态；离线计时冻结，offline_long 不翻转 |
| MTMR 手动启动 | renderer 让位退出（保留行为） |

## 遗留问题（不本次修）

- 今晨 07:29/08:01 旧 bge-m3-worker 崩溃 2 次（新 worker 稳定）——独立问题，观察中，不与本次混修
- renderer-swift LaunchAgent 合入后需手动 bootstrap 恢复（止血 disable 的逆操作）
