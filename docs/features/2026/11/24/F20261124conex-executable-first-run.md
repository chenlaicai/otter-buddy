---
id: F20261124conex
title: "免 CLI 首启与可执行分发：双击启动器、向导配对与安装包下载"
summary: "落实 #1981 PR-B：connector 以 .command 启动器 + 内嵌 Node 运行时分发（macOS 实测），首启向导自动带入配对码与 hub URL 并复用既有核销链路写 device.json；Web 添加设备页扩展安装包与引导文件下载。诚实标注未签名与终端向导形态，不冒充桌面应用。"
change_type: feature
capability_test: "n/a: 纯确定性 HTTP、打包脚本、shell 启动器与交互向导，无 LLM 参与；由 A 类集成/组件/Playwright 测试与真实 PTY 进程证据覆盖"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
created_at: 2026-11-24T12:40:00+08:00
tags: [connector, onboarding, executable, packaging, security]
modules: [connector, web, interface-adapters]
causal_links:
  - "F20261124conon-connector-web-onboarding（PR-A）：本切片在其 Web 面板与产物链上扩展，CLI tarball 降为开发者方式"
intent:
  problem: "PR-A 分发的 npm tarball 要求目标电脑预装 Node/npm 并手敲 CLI 参数，『新电脑下载后双击运行』不成立，配对码与 hub URL 全靠人肉转录"
  expected_effect: "owner 从 Web 下载 zip 解压双击即进入首启向导，配对码与中枢地址自动带入，回车完成配对并常驻；后续双击自动重连；双开被明确拦截；未登录/越权/坏码/缺包全部 fail-closed"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/interface-adapters/http/connector-onboarding.test.ts：app 下载身份矩阵与字节/hash、引导文件身份矩阵与码状态、repo 只读查询"
      - "tests/connector/first-run-wizard.test.ts + tests/connector/instance-lock.test.ts：预填发现/校验、锁决策与生命周期"
      - "web Playwright（web/e2e/connector-onboarding.spec.ts）+ 组件测试：双下载入口、错误路径、几何证据"
      - "真实 PTY 进程证据（工作区 connector-onboarding-evidence/prb-real/）：向导首启/重启重连/离线 fail-closed/双开拦截/LaunchServices open"
---

# 免 CLI 首启与可执行分发（#1981 PR-B）

## 背景

PR-A（#2003）交付了 Web 签发配对码与 CLI tarball，但设备侧仍需 Node/npm 与命令行知识。修正计划 B 节要求：新电脑下载后**双击运行**，首启引导输入或自动带入配对码与 hub URL，换 token 后常驻，之后启动自动重连——且不新增第二套配对机制，不拿 npm tarball 冒充桌面应用。

已核实前提：`pairWithHub`（核销→device.json）与断线重连循环已存在；`packages/connector` 独立构建 + 闭包断言已存在；better-sqlite3 v13 随包分发全平台 prebuilds（含 darwin x64/arm64）——这使「内嵌 Node 运行时 + 依赖闭包」的单 zip 分发成为可行路线，无需 SEA/原生重编译。

## 目标与非目标

- T1：macOS 安装包（zip：.command 启动器 + 内嵌 Node + connector 产物 + 依赖闭包），构建期产出、hash 可核、缺包 503 fail-closed。
- T2：双击启动器 → 无身份且交互终端时进入首启向导；引导文件（bootstrap.json）自动带入 hub 与配对码；三问（hub/码/设备名）回车采纳预填；核销复用既有 `/api/connector/pair`，身份写既有 device.json（新增可选 hubUrl 字段）。
- T3：后续双击无向导直接自动重连；单实例锁防双开互踢。
- T4：Web 添加设备页提供安装包下载（user 档）与引导文件下载（admin 档，服务端验证码活跃、hub 取请求 origin）。
- 非目标：.app/.dmg GUI、图标/Dock 集成、签名公证（无证书，诚实标未签名）、Windows/Linux 实测、自更新、WSS/onlineSession/调度协议改动、公开核销端点语义变化。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 可执行形态 | `.command` 启动器 + Terminal 向导（macOS） | Node SEA；.app bundle | SEA 对 better-sqlite3 原生 addon 支持脆弱；.app 的 shell 可执行体默认无可见终端（要 osascript 二次唤起，窗口闪烁）。Finder 双击 .command 原生打开 Terminal 前台运行——正是向导所需。大獭简报明列 .command 为合法路线 |
| 免 Node 安装 | 内嵌构建机 `process.execPath`（darwin 上为 x64+arm64 通用二进制）+ better-sqlite3 全平台 prebuilds | 要求目标机预装 Node；SEA；交叉编译原生模块 | 一个 macos zip 同时服务 Intel/Apple Silicon（arm64 侧为 agent 推断，见未覆盖边界）；依赖零额外构建 |
| 依赖闭包收集 | 从 dist 产物实际 import 图做**文件级**追踪，触达包整个拷入（prune 文档/测试/源映射） | 按各包 dependencies 做 BFS | 实测 BFS 把 pi-durable→pi-ai→AWS/Anthropic/OpenAI SDK 全家拖入（98MB zip）；文件级追踪只触达 5 包（chord/pi-durable/pi-telemetry/better-sqlite3/ws），zip 缩至 ~90MB（体积主导者已是 node 二进制本体）。追踪不解析即 fail-closed（ws 的 peer/optional 加器件显式豁免——有 try/catch 纯 JS 回退） |
| 打包自证 | 打包期冒烟：用**内嵌** node 在隔离 HOME 跑 staged main.js，必须 exit 2 + usage | 只打包不运行 | 证明运行时/产物/依赖闭包三者自洽（ESM import 全链 eager 解析）；隔离 HOME 防误连真实中枢。该冒烟实际拦到过一次旧 dist 被打包的错配（见「实际验证」脚注） |
| hub 记忆 | device.json 新增可选 `hubUrl`，向导/CLI 配对成功与 --hub 连接时回写；显式 --hub 覆盖 | 配置文件另立；每启动强制传参 | 「之后双击自动重连」的最小实现；旧文件无此字段照常加载（兼容），地址非秘密 |
| 自动带入通道 | 引导文件 otter-connector-bootstrap.json：Web 下载（POST，admin）→ 放启动器同目录或 ~/Downloads（按前缀+最新 mtime 发现，新→旧逐个尝试）→ 向导预填 | 把码嵌进 zip（请求期改包）；码放 URL query | 码不进 URL/访问日志；zip 保持静态产物可 hash 核；发现范围限定精确文件名前缀，不扫无关内容 |
| 引导文件服务端 | 码形态校验 + repo 只读查询 `findActivePairingCode`（未核销未过期才放行，404 不区分原因）+ hub 取 `new URL(c.req.url).origin` | 信任客户端传码；接受 body 指定 hub | 与核销口防探测同口径；hub 只认请求自身 origin（不接受调用方指定，同 PR-A 信任边界） |
| 单实例锁 | `~/.otter/connector/instance.lock`（内容=pid；O_EXCL 原子创建；死锁接管、活锁人话退出、释放校验所有权） | 无锁；跨进程 socket 锁 | hub 顶替语义下双实例互踢进入重连风暴（旧 sid 心跳失效→判死→再顶替），双击使误双开成为高概率路径；文件锁跨平台零依赖，崩溃残留由接管逻辑兜底 |
| 非 TTY 语义 | 无身份且非交互 → usage exit 2（与 PR-A 前完全一致） | 一律进向导 | 保住脚本化使用与 CI 冒烟可预期性（打包冒烟依赖此路径） |

### 机制识别检查点与预算四问

检查点：新增后台任务/持久化表字段/配置生命周期均否（device.json 的 hubUrl 是既有文件的可选字段，非新存储）；新增 HTTP 消息格式（bootstrap 端点）、新分发产物（zip 产物链）、新进程内锁机制为是——按 `mechanism-addition` 留痕。该机制为搭档已确认计划的实现，独立对抗门与异体检视合并，由大獭编排。

1. **谁需要它**：把新电脑接入当前中枢的 owner（不想装 Node/npm、不想手敲 CLI）；已配对设备的普通使用者（双击重连、双开被明确提示）。
2. **失败后果**：没有它，#1981 的「下载后双击运行」不成立，云端/局域网新设备接入仍需运维者远程协助；错误放行则 bootstrap 端点会分发无效码（困惑）或接受调用方指定 hub（钓鱼中枢），故码要服务端验证、hub 只取请求 origin；单实例锁若误判活锁会阻断正常启动，故死锁接管 + 「删除锁文件」人话出口。
3. **后续机制**：码过期/重放由既有 TTL/原子核销处理（bootstrap 只读验证不核销）；包缺失/版本漂移由构建期版本断言 + 运行时 503 fail-closed；锁崩溃残留由 pid 判活接管；引导文件过期只降级丢码保 hub。
4. **退役条件**：若未来交付真 .app/公证/自更新形态并经完整验收，本启动器与引导文件通道整体退役（不能双轨并存）；若 pairing_codes 被更安全的 enroll 机制替代，bootstrap 端点随之退役。

准入三问：决策者不变（owner 仍决定添加哪台设备、配对码只交指定设备）；权限、TTL、原子核销、构建版本断言、fail-closed 均为机械守卫；入口把「装 Node+敲命令」收敛为「解压+双击+三次回车」，不替人做设备授权决定。

## 负向验收（本次破坏/绕过了什么）

- device.json 增加可选 hubUrl 字段：旧消费者（hub 侧不读此文件）零影响；connector 自身旧文件无字段时回退交互补问——**不破坏旧契约**。
- 首启入口不再在 parseArgs 阶段因缺 --hub 退出：非交互且无身份场景的 usage exit 2 语义保留（既有测试口径不变）；交互场景从「报错退出」变为「进向导」——这是本 PR 的目的性变化，非绕过保护。
- 未绕过：公开核销仍要求有效单次码；WSS 鉴权/子协议 pin 不变；闭包断言（readline/os 均为 node 内置，闭包白名单不受影响）继续在 CI 把关。

## 机械验收

| 场景 | 操作 | 预期结果 |
|---|---|---|
| app 下载身份 | 匿名/guest/user 分别 GET `/api/connector/download/app` | 401 / 403 / 200，zip 字节=构建产物、版本/SHA-256/Digest 头可核 |
| app 缺包 | 产物文件缺失时 GET | 503 `connector_app_package_missing`，无 shell 执行、无伪空包 |
| 引导文件身份 | 匿名/guest/user/admin 分别 POST `/api/connector/download/bootstrap` | 401 / 403 / 403 / 200（JSON 含 hub=请求 origin、code、expiresAt；attachment 头） |
| 引导文件码状态 | 形态非法/未知码/已核销/过期码分别 POST | 400 / 404 / 404 / 404（不区分拒绝原因；核销状态不被该端点改变） |
| hub 不可指定 | body 携带 hub 字段 POST | 响应 hub 为请求 origin，body 值不被采纳 |
| 码不进日志 | 引导文件请求后检查测试 logger 全部调用 | 码字符串不出现在任何日志调用 |
| 向导预填 | 构造同目录/Downloads 坏 JSON/过期码 bootstrap 文件跑单测 | 同目录优先；新→旧逐个尝试；坏文件跳过；过期只丢码保 hub |
| 规范化 | hub 形态/码形态纯函数单测 | 仅 http(s) 去尾斜杠；8 位大写字母表（无 0/1/I/O） |
| 单实例锁 | 锁决策/生命周期单测 + 真实双开 | 无锁=acquire；活锁=busy 人话退出 4；死锁=接管；释放只删自己的锁 |
| 非 TTY 语义 | 无 HOME 身份、非交互、无参数跑 main.js | usage + exit 2（脚本化/CI 冒烟语义不变） |
| 打包 fail-closed | 版本漂移/dist 缺失/闭包未解析/冒烟失败 | 拒绝出包（exit 1），不产出半成品 zip |
| 真实双击等价 | PTY 跑 .command：干净 HOME+引导文件 | 向导横幅→预填→回车核销→online→SIGINT 优雅退出（证据 scenario-a） |
| 重启重连 | 同 HOME 再跑 | 无向导，直接 online（scenario-b） |
| 离线 fail-closed | 停 hub 观察再恢复 | 1s→2s 退避重连不退出、无二次配对；hub 回来自动上线（scenario-c） |
| Web 入口 | Playwright 打开添加设备面板 | app 下载/引导文件按钮可见在视口内；下载字节 hash=端点头；签发前无引导文件入口 |

## 实际验证（2026-11-24）

| 命令 / 操作 | 结果 |
|---|---|
| `npx vitest run tests/interface-adapters/http/connector-onboarding.test.ts tests/interface-adapters/http/identity-middleware.test.ts tests/connector/first-run-wizard.test.ts tests/connector/instance-lock.test.ts` | 4 files / 53 tests passed（含 PR-B 新增 app/bootstrap/锁/预填矩阵） |
| `npx vitest run`（全量后端） | 529 files / 6836 tests passed |
| `npm --prefix web test` | 90 files / 880 tests passed（面板新用例 8 个） |
| `npm run build`（含 package:connector + package:app） | 全链通过；zip `otter-connector-macos-universal-0.1.0.zip` sha256 `c81193ac…`（staging ~275MB → zip ~90MB，体积主导为通用 node 二进制） |
| `CONNECTOR_EVIDENCE_DIR=<工作区>/connector-onboarding-evidence scripts/e2e-server.sh run e2e/connector-onboarding.spec.ts`（经 bash） | 真实 Chromium 1 test passed：app 下载 hash 对账、引导文件 POST、几何断言、截图×2 更新 |
| 真实 PTY 证据（`connector-onboarding-evidence/prb-real/`） | scenario A/B/C/D/E 全 PASS + 锁所有权/优雅释放补充实测；hub 侧 10 条会话全 offline、协议 v2、码 redeemed 状态与多码并存符合预期；证据 JSON + 五份日志 + hash 清单落盘 |
| `bash scripts/alpha.sh start/stop` | 隔离 hub（3184）用于上述证据，结束后已 stop |

脚注：开发中被自己的打包冒烟拦下一次「dist 未重建即打包」的错配（package:app 原本不带 build:connector），已把 `package:app` 改为与 `package:connector` 同构（先 build:connector 再打包）——冒烟机制的有效性实证。

最简实现检查已过：向导复用 readline 内置与既有 pairWithHub；锁为单文件+pid 判活零依赖；引导文件端点复用既有 controller/身份表/repo 模式；打包脚本不引入 zip 库（系统 zip）。未能更简的方面：文件级闭包追踪 ~90 行——被 BFS 98MB zip 的实测体积否决，属必要复杂度。

## 未覆盖边界

- Apple Silicon 实机未测：包内含 darwin-arm64 prebuild 与通用 node 二进制（agent 推断可用，未在 arm64 硬件复验）。
- Gatekeeper 拦截对话框未截图（无证书签名，GUI 对话无法 CLI 采集）；Web 面板与启动器注释已标注「右键打开」路径。
- 浏览器下载 zip 的 quarantine 传播与右键放行全流程：留待搭档真机首次使用反馈（PR body 未复验层声明）。
- Windows/Linux：打包脚本平台通用（linux zip 可在 CI/部署机产出）但本切片只在 macOS 实测；云端 hub（linux）分发 macos 包给 Mac 设备的平台矩阵问题留待上云切片。
- 附件/远程工具全链验收属计划 C 节，不在本切片。
