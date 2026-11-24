---
id: F20261124conon
title: "Web 设备接入：登录态一次性配对码与当前中枢 connector CLI 分发"
summary: "落实 #1981 PR-A：在执行机弹窗提供添加设备入口，由 admin 会话签发既有 pairing_codes 的一次性码；当前中枢提供与主仓同版本的 connector npm tarball，明确标注开发态和 Node/npm/CLI 前提。公开核销端点、WSS 协议和 onlineSession 语义不变。"
change_type: feature
capability_test: "n/a: 纯确定性 HTTP、文件分发与 React 行为，无 LLM 参与；由 A 类集成、组件和 Playwright 测试覆盖"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
created_at: 2026-11-24T09:19:11+08:00
tags: [connector, onboarding, pairing, web, packaging, security]
modules: [web, connector]
intent:
  problem: "新电脑接入仍要求运维者登录中枢主机运行仓内 CLI 签发配对码，Web 执行机弹窗也没有下载与添加设备入口，导致本地、局域网和云端部署无法从当前登录中枢完成同一套接入流程。"
  expected_effect: "owner 可在 Web 签发 8 位、10 分钟、单次核销的配对码并下载与中枢同版本 CLI tarball；未登录与低权限请求被拒绝，缺包明确失败，真实 connector 可用该码核销并上线。"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/interface-adapters/http/connector-onboarding.test.ts：身份矩阵、TTL、单次核销、下载字节/hash/版本、缺包失败"
      - "web/src/pages/conversation/ConnectorOnboardingPanel.test.tsx：签发、复制、下载及错误状态"
      - "web/e2e/connector-onboarding.spec.ts：真实浏览器添加设备、核销与下载证据"
---

# Web 设备接入（#1981 PR-A）

## 背景

搭档确认：「更新计划，按照新计划，你逐步来做……先用 kimi highspeed 小獭来开发」。修正计划把 #1981 定为正式上云前 blocker，当前切片只交付 Web 添加设备、登录态配对码签发和明确标注开发态的 CLI tarball。

已核实前提：`ConnectorRegistryRepository.createPairingCode` 与原子 `redeemAndCreateDevice` 已存在；`POST /api/connector/pair` 是码即秘密的公开核销口；`scripts/package-connector.mjs` 已生成 npm tarball。问题存在，缺的是登录态产品入口与构建产物链，不是配对协议。

## 目标与非目标

- T1：admin 通过 `POST /api/connector/pairing-codes` 签发既有 8 位字母表、10 分钟 TTL 的一次性码。
- T2：Web 显示配对码、过期时间和 `window.location.origin` 对应的当前中枢地址，可复制首启命令。
- T3：user 及以上身份可下载与中枢版本一致的 CLI tarball；guest/匿名拒绝，包缺失 503。
- T4：常规 build 同步生成 tarball，下载只读固定构建产物，版本和 SHA-256 可核。
- 非目标：双击 GUI、免 CLI 首启、原生可执行包、签名/公证、自更新、部署、云端切换、WSS/onlineSession/调度改动。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 配对事实源 | 新 usecase 生成码并调用既有 `createPairingCode`，核销仍走原 controller/repo | 新表、新 token 机制、Web 直接写 SQL | 保持 TTL、字母表、原子核销与撤销语义单一 |
| 权限 | 签发 admin；下载 write（user/admin）；匿名 401，低档位 403 | 两端点 public 或一律 admin | 码能注册执行设备，必须 owner；安装包不含秘密，登录 user 即可读取，符合最小权限 |
| 中枢地址 | 浏览器只展示 `window.location.origin` | API 接收任意 hub URL、硬编码 ECS | 部署位置无关，避免把调用方输入当可信配置 |
| 包供给 | `npm run build` 连带 `package:connector`；下载读取组合根注入的固定文件名 | 请求时 `npm pack`/shell、用户输入路径、提交二进制 | 构建期决定版本与内容，运行时无 shell/路径注入，缺包 fail-closed |
| 下载校验 | 响应带版本文件名、版本头、SHA-256 头与 Digest | 只按“下载成功”判断 | 调用方可独立核对字节、版本和完整性 |
| UI 载体 | 执行机弹窗内独立 `ConnectorOnboardingPanel` | 另建页面或把状态塞进设备列表 | 添加设备与选机是同一任务；配对码只存在组件内存，关闭即丢弃 |

### 机制识别检查点与预算四问

检查点：新增配置/状态生命周期/后台任务/持久化表字段均否；新增 HTTP 消息格式与 Web→usecase→repo 跨模块路径为是，因此按 `mechanism-addition` 留痕。该机制是搭档已确认计划的实现，独立对抗门与本 PR 的异体检视合并，由大獭编排。

1. **谁需要它**：拥有中枢登录口令、要把新电脑接入当前中枢的 owner；已登录的维护用户需要获取设备侧安装包。
2. **失败后果**：没有它，用户必须登中枢主机跑仓内 CLI，云端/局域网新设备接入无法从产品面完成；错误放行则会让攻击者注册可执行远程动作的设备，故签发必须 admin。
3. **后续机制**：码可能过期、重放或签发后未被使用，分别由既有 TTL、原子核销和短期秘密语义处理；包可能缺失/版本漂移，由构建期版本断言、运行时 503 与 hash 校验处理；Web 可能误显示旧码，组件仅保留当前响应并在关闭时卸载。
4. **退役条件**：PR-B 的免 CLI 首启与可执行分发完成真实平台验收后，可退役“开发态 CLI tarball”展示与 npm 安装指引；若 pairing_codes 被更安全且覆盖同等场景的 enroll 机制整体替代，可连同 CLI 签发路径一起退役，不能保留双轨。

准入三问：决策者不变，owner 仍决定添加哪台设备；权限、TTL、原子核销、固定路径、构建版本断言均为机械守卫，视觉与文案由异体审；入口把原先需要读仓和登主机的过程收敛为可观察的 Web 操作，降低深潜成本，不替人做设备授权决定。

### 代价与负向验收

新增一条构建产物链和一个运行时下载读取点，后续升级必须继续同步根包/connector 版本并保留 tarball；Web 增加一次性秘密展示面，禁止日志和持久化。没有绕过既有保护：公开核销仍要求有效单次码，签发与下载新增身份闸，WSS 鉴权与总闸不变。

## 机械验收

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 签发身份 | 匿名/user/admin 分别 POST 配对码端点 | 401 / 403 / 201；只有 admin 返回码与 expiresAt |
| 下载身份 | 匿名/guest/user 分别 GET 下载端点 | 401 / 403 / 200 |
| TTL 与单次核销 | admin 签发后公开 pair 核销，再重放；过期码再试 | 首次 201 建设备；重放/过期均 403 且不建第二个设备 |
| 下载内容 | GET 下载并计算 SHA-256、读取文件名和版本头 | 字节等于构建 tarball；hash 一致；版本等于根 package.json |
| 缺包 | 指向不存在的固定产物后 GET | 503 `connector_package_missing`，不执行 shell，不返回伪空包 |
| Web 正常/错误 | 点击添加设备、下载；模拟 401/403/503 | 显示码、过期时间、当前 origin、开发态提示；错误可见且不伪装成功 |
| 真实浏览器 | 运行 Playwright 打开执行机弹窗并截图、读 bounding rect | 入口与配对信息在视口内可见；下载文件可核，测试 connector 可核销 |
| 上线回归 | 用签发码换 token，经真 WSS hello | online_sessions 出现 online 行，执行机列表可见设备 |
| 旧契约 | 直接 POST 原 `/api/connector/pair` 并跑既有 connector 测试 | 无登录核销语义、协议与在线状态行为不变 |


## 实际验证（2026-11-24）

| 命令 / 操作 | 结果 |
|---|---|
| `npx vitest run tests/interface-adapters/http/connector-onboarding.test.ts tests/interface-adapters/http/identity-middleware.test.ts tests/usecases/execution/connector-registry-repo.test.ts` | 3 files / 50 tests passed；含匿名/越权、过期/重放、缺包与真 WSS 上线 |
| `npm --prefix web test` | 90 files / 876 tests passed |
| `npm test` | 527 files / 6817 tests passed |
| `npm run check` | build（含 connector closure + tarball）、eslint、schema、双形态 smoke boot、脚本与 otterbar probes 全过 |
| `npm --prefix web run build` | tsc + vite 通过 |
| `npm run lint:intent` / `npm run lint:docs` | 0 error；仅既有 warning，本文 intent 与 docs 校验通过 |
| `CONNECTOR_EVIDENCE_DIR=<对话工作区>/connector-onboarding-evidence scripts/e2e-server.sh run e2e/connector-onboarding.spec.ts` | 真实 Chromium 1 test passed；签发、核销、重放 403、下载 hash 和几何断言通过；服务已 stop |
| 真实 CLI 验证脚本（工作区 `verify-real-connector.mjs`） | 临时 HOME + 临时 npm global prefix 安装 96 packages；真实 connector paired + protocol v2 online；重放 403；下载字节等于 tarball；SIGTERM 优雅退出，e2e 服务已 stop |

证据目录：`/Users/orca/ai/otter-buddy/data/workspaces/6af46649-f93f-4c5b-a6d2-245a4ed33e9f/connector-onboarding-evidence/`

- `connector-onboarding-entry.png`：1280×900 初始入口，下载按钮 rect 在视口内。
- `connector-onboarding-issued.png`：签发/核销后的码、当前 origin、命令、开发态提示与设备状态；截图中的码已核销，不能重放。
- `connector-onboarding-evidence.json`：版本 `0.1.0`、SHA-256 `7db6c8a9eb9554e73ad54f6fc9ba4178efe81c6a41177370976eea0480b71ccc`、dialog/code/download 几何。
- `real-connector-evidence.json` / `real-connector-process.log`：真实 CLI 上线与退出证据，不含配对码/token。

最简实现检查已过：复用现有 repo、打包脚本、身份表和 Modal，无新增依赖、表或协议；独立签发 usecase 防止控制器复制码生成规则，独立 Web 面板避免原弹窗越过函数/文件复杂度门，不能再删而不损害既有边界。

未覆盖边界：真实 CLI 仅在本机 macOS + Node 24 验证；Windows/Linux 安装、干净设备完整远程工具/附件链、免 CLI 首启、签名公证与自更新属于后续 PR-B/C，不在本切片宣称完成。云端未部署、未切换。
