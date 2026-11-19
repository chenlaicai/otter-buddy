---
title: 部署通道两处根因修复：依赖分区唯一 + App unit 纳入部署
id: F20261119dploy
date: 2026-11-19
module: deploy
change_type: fix
status: active
from: F20261118cldep
summary: |
  #1941 合入后按 deploy.sh 部署 ECS 服务起不来：`npm ci --omit=dev` 后找不到 hono。根因是
  package.json 把 hono 等包同时写进 dependencies 与 devDependencies——npm 静默取 dev 那份，
  生产安装跳过它，HTTP 层照样 import，启动即 ERR_MODULE_NOT_FOUND；本地与 CI 都装 dev 依赖，
  测试永远看不见。连带两处：deploy.sh 只部署中枢，App 扩展是独立 unit（/opt/colink-agent-app）
  脚本不管，「部署成功但 App 还是旧版」；打包带上 macOS resource fork，文档同步整片报
  Missing frontmatter（一次 7914 个）。修法：删重复声明 + 机械闸
  check-dependency-sections.mjs 挂 CI + deploy.sh 两段式（备份、重启、按源版本核对 manifest）
  + 打包排除垃圾文件。
intent:
  problem: "生产部署通道等同坏掉：任何从零安装的生产环境都因缺 hono 启动失败，而本地/CI 全绿掩盖；同时 deploy.sh 的单段式让 App 扩展版本与中枢脱钩，部署后无法确认真实在线版本"
  expected_effect: "npm ci --omit=dev 装出来的依赖能跑起 dist；重复声明在 CI 合入前就红；一次 deploy.sh 同时更新中枢与 App 两个 unit，并以「实际服务的 manifest 版本 == 源清单版本」作为部署成功判据；线上文档同步不再被 macOS resource fork 污染"
  verify_by:
    type: behavior_check
    evidence:
      - "反向验证：把 hono 加回 devDependencies → `node scripts/check-dependency-sections.mjs` exit 1 并报「hono → dependencies + devDependencies」；复原 exit 0"
      - "单测 tests/scripts/check-dependency-sections.test.ts 19 条全绿（分区互斥、真冲突两区、optional / peer 叠加豁免、缺失分区容错、lock dev 标记降级为警告、CLI exit 0/1/2、提示走 stderr）"
      - "package-lock.json 由 npm --package-lock-only 重算：hono / @hono/node-server 的 \"dev\": true 标记消失（omit=dev 会装上），playwright 1.63.0 从 dependencies 移除"
      - "线上实证（2026-11-19 ECS）：修前 npm ci --omit=dev 后启动报 Cannot find package 'hono'；补包装上后 /api/ping 200；本次脚本第二段上线后 /opt/colink-agent-app 由 0.6.0 变 0.6.1，公网 manifest 亦为 0.6.1"
      - "deploy.sh 语法自检 bash -n 通过；备份保留最近 3 份（ls -1dt | tail -n +4 | xargs rm -rf）"
      - "端到端实跑（2026-11-19 ECS）：`bash deploy/ecs/deploy.sh` → 中枢 npm ci 失败自动回退就地安装 → 「中枢依赖闭包完整」→ /api/ping `{\"ok\":true}` → App 备份 /opt/colink-agent-app.bak-20261119103358 → 「App 依赖闭包完整」→ 「App 就绪：manifest 0.6.1」→ deploy done"
      - "检视现场实证（首版被推翻的两点）：源清单 sed 宽松正则会连带 extensionPoint 的 1.0.0；探活侧行内贪婪正则会把同一份 JSON 里的 extensionPoint.version 当 App 版本——两处都已改为锚定/JSON 解析"
capability_test: "tests/scripts/check-dependency-sections.test.ts"
tags: [deploy, dependency-hygiene, ci-gate, systemd, packaging]
modules:
  - package.json
  - package-lock.json
  - scripts/check-dependency-sections.mjs
  - tests/scripts/check-dependency-sections.test.ts
  - .github/workflows/ci.yml
  - deploy/ecs/deploy.sh
  - deploy/ecs/README.md
---

# F20261119dploy：部署通道两处根因修复

## 触发

搭档 09:33 授权合入 #1941（私聊历史翻页跟随平台统一契约）。按 runbook 跑
`bash deploy/ecs/deploy.sh` 后 ECS 上的中枢起不来：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'hono' imported from
  /opt/otter-buddy/dist/src/interface-adapters/http/controllers/auth-controller.js
```

同时暴露第二个问题：App 扩展是独立 unit，deploy.sh 从未覆盖它——脚本报「部署成功」，
但公网 `manifest.json` 还是上一版 `0.6.0`。

## 根因（三处，都是机械可判的结构问题）

1. **依赖分区重复声明。** `hono`、`@hono/node-server`、`playwright` 同时出现在
   `dependencies` 与 `devDependencies`。npm 不报错、只保留一份解析结果（取 dev 那份），
   `--omit=dev` 于是跳过它们。代码照样 import → 生产启动即崩。**本地与 CI 不 omit dev，
   所以测试全绿**；11-12 的旧 dist 不 import hono，也让问题潜伏到这次才炸。
2. **部署脚本只覆盖一个 unit。** 中枢在 `/opt/otter-buddy`，App 扩展在
   `/opt/colink-agent-app`（独立 systemd unit，内部端口 31130）。脚本只 rsync 前者，
   App 版本与中枢脱钩，「部署成功」与「线上版本正确」之间没有机械联系。
3. **打包带上 macOS resource fork。** 从 macOS 打包时 `._*`（AppleDouble）随行上线，
   文档同步把它们当特性文档解析，整片报 `Missing frontmatter`（一次 7914 个）。

## 修法

| 面 | 改动 |
| --- | --- |
| 依赖声明 | `hono` / `@hono/node-server` 只留 `dependencies`；`playwright` 只留 `devDependencies`（`src/` 零引用；引用点全在开发侧：`scripts/game/*.mjs` 截图工具、`tests/web-mahjong/*`、`web/e2e/*`；顺带消除 1.63.0 vs 1.65.0 的版本冲突） |
| 机械闸 | 新增 `scripts/check-dependency-sections.mjs`：① 分区互斥——**只有** `dependencies` 与 `devDependencies` 不得重叠（判据是「叠加会不会让生产少装东西」：`optionalDependencies` 叠加是 npm 认可的「优先按可选装」，包仍会装；`peerDependencies` 是独立的期望轴，两种叠加都不算冲突）② `dependencies` 的包在 lock 里带 `dev: true` 时给**警告**（启发式，不阻断；红只由断言 ① 出）。挂进 CI `check` 段（分支保护 required 上下文） |
| 部署 | `deploy.sh` 扩成两段式：第一段中枢（原逻辑 + 打包排除 `._*`/`.DS_Store` + 依赖闭包校验 + `npm ci` 失败时按 lock 就地安装兜底），第二段把中枢里的扩展目录同步到 `/opt/colink-agent-app`（**排除 node_modules**）、留备份（保留最近 3 份）、就地装生产依赖、校验依赖闭包、重启 `colink-agent-app`，并用**JSON 解析出的 manifest 版本 == 源清单版本**作为成功判据 |
| 文档 | `deploy/ecs/README.md` 补双 unit 部署、备份回滚、依赖分区红线 |

## 设计取舍

- **为什么用「分区互斥」而不是「显式白名单」**：白名单会随依赖变化腐化，且拦不住新引入的
  重复声明；互斥是结构不变量，零维护。
- **为什么 lock 的 `dev: true` 只做警告**：它能提示「生产安装可能跳过这个包」（本次 hono 在
  lock 里正是 `dev: true`），但它是启发式——手改过的 lock、历史遗留标记会误报，最小 fixture 里
  出现过「闸报错而 `npm ci --omit=dev` 实际装得上」的反例。红必须由结构不变量（分区互斥）来出，
  启发式只提示，交给看日志的人判断。
- **为什么部署判据用「服务的 manifest 版本 == 源清单版本」**：不关心进程怎么起、日志说什么，
  只认实际对外声明的版本。这一条把「我以为发上去了」变成可观测事实。解析必须走 JSON——
  manifest 是一行 JSON，行内贪婪正则会把 `extensionPoint.version`（1.0.0）当成 App 版本，
  探活于是永远等不到（首版实现踩过，被检视当场抓出）。
- **为什么 App 目录同步要排除 node_modules**：扩展有自己的生产依赖（SVG 转图用 sharp）。
  `rsync --delete` 会把已装依赖一起删掉，而服务仍能起来、manifest 探活也照过——故障要等到
  真正用图像能力才炸。所以「同步代码」与「装依赖」必须分开，且装完要有**依赖闭包校验**
  （清单声明的每个 dependency 在 node_modules 里存在；判据取目录存在而非 `require.resolve`——
  ESM-only 包在后者下会假报缺失）。
- **为什么第一段依赖装不上还能继续**：这台机的 `onnxruntime-node` 安装脚本要下载二进制，
  源在该网络下 302 失败（云端本就走 `OTTER_EMBEDDING=off`）。脚本先试 `npm ci`（可复现），
  失败时退回「按 lock 就地安装 + 跳过安装脚本」——就地安装不重建已装的 native 模块
  （better-sqlite3 等），比让 `npm ci` 半途留下残缺 node_modules 安全。
- **不做的事**：不把 `npm ci` 整体换成 `npm install`（后者会重算依赖树、破坏可复现性）——
  只在 `npm ci` 失败时**回退**到「按 lock 就地安装 + 跳过安装脚本」。这是有意为之的兜底：
  这台机的 `onnxruntime-node` postinstall 要下载二进制且源不可达，若让部署卡在这一步，
  整条发布通道就断了；就地安装不重建已装 native 模块，风险面小于让 `npm ci` 半途留下残缺
  node_modules。可复现性缺口记在遗留里，不当作已解决。

## 半部署语义（两段式部署的失败面）

两段之间有四种状态，脚本只把「两段判据都过」当成功，其余都算失败，但**失败时现场可能已经变了一半**：

| 状态 | 现象 | 处置 |
| --- | --- | --- |
| 中枢磁盘已换装、进程未重启 | `/api/ping` 探活超时，但 `/opt/otter-buddy` 内容已是新树 | 手工 `systemctl restart otter-buddy`；仍起不来按 Rollback 检上一版重跑 |
| 中枢已重启、依赖残缺 | 进程反复 `ERR_MODULE_NOT_FOUND`（本轮真实故障） | 依赖闭包校验会先拦住；漏网时按 lock 就地安装后重启 |
| App 磁盘已同步、进程仍是旧版 | `manifest.json` 版本与源清单不符 | 备份目录可直接回灌；或 `systemctl restart colink-agent-app` |
| App 重启失败 | unit 处于 activating/failed，端口不通 | `journalctl -u colink-agent-app` 看首行错误；按 Rollback 回灌备份 |

判据的位置选择：**只看「实际对外声明的版本」**，不看日志叙事——因为「磁盘更新了」不等于
「进程在用新代码」，而只有后者对线上行为有意义。

## 遗留（不在本 PR 范围）

- ECS 上 `onnxruntime-node` postinstall 下载 build list 报 HTTP 302 失败，导致
  `npm ci --omit=dev` 在**干净** node_modules 上仍可能失败一次；本次是 `--ignore-scripts`
  绕过。云端本就 `OTTER_EMBEDDING=off`（模型文件不迁），但安装路径的可复现性需要独立治。
- `deploy.sh` 仍假设本机 `.otter/deploy-keys/ecs-ssh.sh` 就绪；首次部署的密钥引导不在脚本内。
