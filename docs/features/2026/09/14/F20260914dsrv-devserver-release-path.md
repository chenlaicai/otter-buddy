---
id: F20260914dsrv
title: 自有项目 dev server 放行路径：端口白名单 + 受控重启脚本 + 拦截升级
summary: 解决 #844——外部项目 dev server 重启被 bash 守卫拦死后无正当出路（6 次变体重试实证）。三层交付：方案 A 端口白名单静态放行（lsof 可溯源形态）、方案 B restart-service.mjs 受控脚本（PID/cwd 级校验）、方案 C 同獭 6h 内 ≥3 次拦截自动升 high。
change_type: feature
capability_test: "n/a: 守卫为运行时防护层，行为由 19 个新单测锁定（六变体同构命令 + 铁拦不松动 + 升级判定）；受控脚本依赖真实 lsof 环境不进单测"
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
created_at: 2026-09-14
tags: [bash-guard, security, devserver, whitelist, healing, daily-review]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/allowed-service-ports.ts
  - src/frameworks/agent/guard-intercept-escalation.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/frameworks/agent/pi-session-factory.ts
  - scripts/restart-service.mjs
  - tests/frameworks/agent/allowed-service-ports.test.ts
---

# 自有项目 dev server 放行路径（#844）

## 背景

2026-09-07 dongbeicun 项目的开发獭 6 小时内用 6 种变体尝试重启 dev server（端口 3100），全部被 bash 守卫拦截（healing events f4f389f6/08055f1d/868b849e/e80acf7b/cfe7d5d5/e514d442），全部落 medium 静默无人处置。守卫按设计拦截正确——但「正当场景无出路」是真实缺口：

- 守卫引导语只有「worktree 隔离实例」（对外部项目 dev server 不适用）和「告知搭档人工执行」（高频操作推给人工）两条路；
- 按名匹配从原理上无法区分自有项目与 otter 主进程：dongbeicun dev server 的启动命令 `node dist/api/src/main.js` 与守卫特征模式（`node.*main` / `main.js`）天然撞名；
- 实践中獭选择反复变体重试而非升级——引导事实上失效，误拦/真拦混杂侵蚀对引导的信任。

## 方案

issue 给出 A（白名单）/B（受控命令）/C（升级路径）三方向，本 PR 实现 **A+B+C 组合**：

### 方案 A：端口白名单静态放行（allowed-service-ports.ts + bash-safety-guard.ts）

搭档在 `<otterRoot>/.otter/allowed-service-ports.json` 声明 `{ "services": [{ "port": 3100, "projectDir": "/abs/path" }] }` 后，守卫把「kill 目标可静态溯源到白名单端口监听者」的命令放行：

- **判定窗口**：守卫在 tool_execution_start 同步拦截，不能跑 lsof——白名单必须静态化，动态校验全部下沉到方案 B 脚本内；
- **放行形态**（三条溯源规则，#844 六变体中 lsof 族全覆盖）：
  - 2a 同段：`lsof -i :3100 -t | xargs -n1 kill`（同段管道）
  - 2c 跨段：`lsof -i :3100 -t` 与 kill 段相邻（分段把 `|` 切开后在完整分段序列里找左邻）
  - 2b 变量：`P=$(lsof -t -i:3100); kill $P`（kill 段的 $VAR 在同命令内被赋值为白名单端口的 lsof 结果）
- **铁拦永不放行**（先于放行判定）：① `.otter-buddy.pid` 文件引用；② 字面量主进程 PID；③ pkill/killall 族命中 otter 特征名（按名匹配无法区分，永不放行——main.js/node 撞名问题在这条路上无解，引导走 lsof 形态或方案 B）；
- **ps-grep 形态不放行**（#844 变体 1）：grep 名字取 PID 无法静态绑定到端口，且模式串与 otter 特征天然撞名——设计取舍，非遗漏；
- 热加载：每次判定重读白名单（mtime+size 缓存去抖），改配置无需重启主进程；64KB 体积上限防巨文件阻塞同步路径；解析失败退化为主逻辑原状。

### 方案 B：受控重启脚本（scripts/restart-service.mjs）

`node scripts/restart-service.mjs <port> [--project /abs/path]`——守卫生态内唯一合法的 dev server 终止入口：

- 命令行形态本身不含 kill/pkill 词元，天然不触发守卫（「放行」不是开口子，是形态干净）；
- 脚本内四级校验全过才发 SIGTERM：① 端口在白名单内；② --project 与白名单声明一致；③ 每个解析出的 PID ≠ 主进程 PID（纵深防御）；④ 每个 PID 的 lsof cwd 在声明项目目录下；
- 校验失败退出码 1 + stderr 说明；无监听者视为已达成（幂等）。

### 方案 C：重复拦截升级（guard-intercept-escalation.ts + pi-session-factory.ts）

guard_intercept 落 healing 前经 `classifyGuardIntercept` 判定：同 otter 近 6h 内已有 ≥2 次（本次为第 3 次）→ severity 升 **high** + suggestion 换「优先人工排查误拦/考虑白名单，勿再静默批量 resolve」+ context 记 `repeatedIntercept` 次数。#844 现场的 6 连拦在第 3 次就该浮出水面，而不是淹没在 medium 池里 7 天无人看。

### 引导文案增强（circuit-breaker-helpers.ts）

拦截文案动态追加（静态文案零改动，测试断言友好）：已配置白名单 → 提示 restart-service 用法 + 已声明端口；未配置 → 提示白名单文件路径与格式。

## 验证

- 新增 19 个单测（tests/frameworks/agent/allowed-service-ports.test.ts）：白名单加载 5（合法/缺文件/坏 JSON/热加载/体积上限）+ 放行判定 8（六变体同构 lsof 族放行、ps-grep/pkill 撞名维持拦截、铁拦三件、白名单外端口、未配置退化）+ 端口提取 2 + 升级判定 4；
- 全量 2919/2919 pass（main 2900 + 19），tsc 0 error，eslint 0 error；
- 守卫原 91 个用例零回归（含 #850 位置感知白名单全量回归）；
- restart-service.mjs 冒烟：--help 路径（无参退出码 1）+ 白名单外端口拒绝路径人工验证；
- 最简实现检查：已过——白名单判定纯函数化挂在现有 checkBashCommandSafety 入口（无新调用链），升级判定独立纯函数模块，未引入任何依赖。

## 边界与已知限制

- 本 PR 不解决「守卫对文本提及不免疫」（heredoc/gh --body 引用被拦）——那是 #858 的范畴；开发本 PR 过程中 2 次被自家守卫拦截（调试命令内联测试字符串）再次实证 #858 的真实性；
- pkill -f 撞名形态（如 dongbeicun 的 main.js）维持拦截——按名匹配无静态区分度，出路是 lsof 形态或方案 B；
- 白名单是搭档级配置（放行语义 = 搭档信任声明），獭不能自行创建。

## 关联

- closes #844
- 姊妹：#858（守卫对生态文本不免疫）、#777/#850（位置感知白名单——本 PR 的地基）
