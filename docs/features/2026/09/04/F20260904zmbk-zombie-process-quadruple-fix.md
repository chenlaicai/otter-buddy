---
id: F20260904zmbk
title: 僵尸进程四层修复：dispose 超时兜底 + 后台 timer 全量 unref + EADDRINUSE 干净退出 + Feishu stop 接入 dispose 链
summary: |
  #460（8/25 Bug）：node 进程负载异常时僵尸化——占满单核数天、SIGTERM 杀不死、可多实例并存。
  根因四层叠加，本 PR 全修，顺手带 #439（诊断脚本 chunk 语义文档化，纯文案）。
  ① dispose 无超时：SIGTERM await dispose()，任一 async 清理卡住就到不了 exit——
    新增 bootstrap/shutdown.ts，5s 超时强制退出。
  ② 后台 timer 缺 unref（4 处：sse-streamer/embedding-retry/rhi-scan/scheduler），
    阻止事件循环退出——全补（另 3 处此前已自愈）。
  ③ EADDRINUSE 无处理：serve() 裸 listen，port 冲突走 uncaughtException→dispose 又卡死——
    listen() 挂 server error handler，干净退出。
  ④ Feishu WSClient 未停：setupFeishu 改返回 stopFeishu 句柄，接入 dispose 链。
change_type: fix
created: 2026-09-04
created_in_conversation: e9b71eec-679e-4380-947d-8e641c4b90d5
tags: [process-lifecycle, zombie-process, graceful-shutdown, timer-unref, eaddrinuse, feishu]
modules: [src/main.ts, src/bootstrap/shutdown.ts, src/bootstrap/server.ts, src/bootstrap/platforms.ts, src/app.ts, src/usecases/scheduler/scheduler-service.ts, src/usecases/health/rhi-scan-worker.ts, src/usecases/memory/embedding-retry-worker.ts, src/interface-adapters/http/sse-streamer.ts]
issue: 460
capability_test: "n/a: 纯 A 类代码逻辑修复（进程生命周期/网络绑定），无 LLM 参与行为；行为验证走 vitest 单测（shutdown 超时/端口冲突均真实现验证）"
---

## 背景

issue #460（2026-08-25）：`node dist/src/main.js` 在两种异常路径下僵尸化：

1. LLM 持续产出 degenerate output → orchestrator retry loop + circuit break 循环
2. Feishu 服务不可达 → WSClient 无限重连

僵尸进程占满单核 CPU 数天，SIGTERM 无效必须 `kill -9`；重启后旧僵尸仍在 → 多实例并存。

## 根因与修复

### 根因 ①：dispose() 无超时（P1，进程"杀不死"）

SIGTERM handler（原 main.ts:20）`await built.dispose()` 后才 `process.exit()`。dispose 链含多个 async
操作（rhiScanWorker.stop / metricsRegistry.dispose / logger.flush 等），任何一个悬挂 → 永远到不了 exit。

**修复**：新增 `src/bootstrap/shutdown.ts`：

```ts
export function disposeWithTimeout(
  dispose: () => Promise<void>,
  timeoutMs: number,
  exitFn: ExitFn,
  exitCode = 1,
): Promise<void>
```

- `Promise.race([dispose(), timeout.then(() => exitFn(exitCode))])`——超时调 exitFn 强制退出（默认 process.exit）
- dispose 抛错原样透传，调用方按原语义处理（graceful 场景 log 后继续退出）
- 兜底 timer 自身 unref，不引入新的退出阻塞
- **exitFn 注入**：测试传记录函数，避免真退出测试进程

main.ts 三处信号 handler（SIGINT/SIGTERM、uncaughtException、unhandledRejection）统一走 `disposeWithTimeout`，
超时 5s，退出码 1（graceful 超时=异常退出语义；正常完成落 exit(0)）。

### 根因 ②：后台 timer 未 unref（P2，进程"死不透"）

全仓 7 处生产 setInterval 排查（2026-09-04 时点）：

| timer | 间隔 | 状态 |
|---|---|---|
| metricsRegistry flush | — | 已 unref（早前修复） |
| weixin login-session TTL | — | 已 unref（早前修复） |
| signal-router debounce | — | 已 unref（早前修复） |
| sse-streamer keepAliveTimer | 15s | **本 PR 补** |
| embedding-retry-worker timer | 30s | **本 PR 补** |
| rhi-scan-worker timer | 1h | **本 PR 补** |
| scheduler-service pollTimer | 轮询 | **本 PR 补** |

修复方式统一：`setInterval(...)` 后一行 `timer.unref?.()`。注释说明 unref 只影响"进程能否自然退出"，
不影响 tick 触发——主进程生命周期由 HTTP 监听持有。

### 根因 ③：EADDRINUSE 无处理（P3，port 冲突死循环）

`bootstrap/server.ts` 的 `listen()` 原为裸 `serve()`。@hono/node-server 的 serve() 回调只在成功时触发，
绑定错误走 server 'error' 事件——无人监听时升级为 uncaughtException → dispose 链 → 若 dispose 又卡住回到僵尸。

**修复**：listen() 挂 error handler，EADDRINUSE（另一实例运行中）或其他绑定错误均 `process.exit(1)` 干净退出。

> 测试时发现的关键行为（已验证）：serve() 默认绑定全接口（IPv6 `::`）。若现有实例绑 127.0.0.1，新实例绑 `::`
> 时 IPv6 侧不冲突，**不会触发 EADDRINUSE**。本修复依赖两个实例绑同接口（生产部署 otter-buddy.sh 均绑全接口，成立）。

### 根因 ④：Feishu WSClient 未停（P3，重连机制持续跑）

`setupFeishu()`（platforms.ts:275）创建 FeishuLongConnectionClient 但返回 void，引用不外露——
app.ts dispose 链无从 stop。`FeishuLongConnectionClient.stop()`（long-connection-client.ts:167）早已存在，
`wsClient.close()` + log，就差接线。

**修复**：setupFeishu 返回类型改为 `{ stopFeishu: () => void } | undefined`（无 feishu 配置时 undefined）；
app.ts 捕获返回值，dispose 链首行调用 `feishuStop?.stopFeishu()`（stop 失败仅 log 不阻塞后续清理）。

### 附带：#439（diagnose-degenerate.mjs chunk 语义文档化）

脚本默认 `--chunk 37` 声称「模拟流式 delta」，但运行时 delta 尺寸由 LLM provider 决定，无单一真相源可绑定。
按 issue 方案 3：文案改「灵敏度参数」——影响触发点数值、不影响是否触发的判定；help 与运行时输出
提示可用 `--chunk` 扫 1/37/100/500 对比触发点区间。脚本头注释同步。零逻辑变更。

## 验证

- 全量 vitest：243 files / 3015 tests 全绿（含新增 5 个）
- tsc --noEmit：0 错误
- eslint（全部改动文件）：0 error
- 新增测试：
  - `tests/bootstrap/shutdown.test.ts`（4 用例）：正常完成不退出 / 悬挂超时强退 exitCode / 抛错透传 / exitCode 可定制
  - `tests/bootstrap/server-addrinuse.test.ts`（1 用例）：真端口占用（net.Server 全接口 bind）→ listen() 被占端口
    → error handler 捕获 EADDRINUSE → process.exit(1) 且不走 uncaughtException（process.exit mock 记录副作用）

### 最简实现检查（已过）

- dispose 超时：独立 12 行函数（Promise.race + unref timer），未引第三方库（如 why-is-node-still-running）
- unref：每处 1 行 + 注释，无结构改动
- EADDRINUSE：error handler 6 行，未引入 port 预检轮询/文件锁（issue 提到的另一方案——需要跨平台锁语义，重得多）
- Feishu stop：复用现成 stop() 方法，仅接线（签名改返回值 + dispose 链一行）
- #439：纯文案，3 处字符串

## 观察项（留待运行时验证）

- 5s dispose 超时在真实清理负载下是否充裕（生产 metric flush 通常 <1s；若观察到 timeout 日志频繁出现可上调）
- EADDRINUSE 修复依赖"两实例绑同接口"前提；若未来部署改为显式 hostname 绑定需同步检查
