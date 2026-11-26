---
id: F20261126hubsf
title: 附件流式响应关闭竞态修复（undici ReadableStream already closed 致 hub 崩溃）与 D3 离线反馈排查结案
summary: GET /api/attachments/:id 曾把 Node fs.ReadStream 以类型欺骗直接喂给 Web Response 构造器，落入 undici ReadableStreamFrom 包装的 cancel→close 竞态（queueMicrotask 对已关闭 controller 调 close），客户端断开恰落在 pull pending 窗口时抛 ERR_INVALID_STATE 成为 uncaughtException，整个 hub 进程退出。修复为 Readable.toWeb() 产生真 WHATWG ReadableStream（undici extractBody 直接透传，不包装），竞态面消失；附确定性竞态回归测试（legacy 形态崩=攻击有效性元验证）。D3（目标机离线时助手回复成为孤儿文本）排查结论：主根因是 planc 时点（c374cb4e）env 工厂 resolveForConversation 失败炸掉全部工具（含 speak/yield），已由 #2041（03326843 统一注册制占位 env）修复，本特性文档附 alpha 真实 LLM 全链路验证证据（离线反馈经 speak 完整到达用户、yield 正常交棒）。
change_type: fix
doc_type: feature
created_at: 2026-11-26
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
capability_test: "n/a: 传输层流关闭竞态修复，由确定性子进程竞态测试 + 真实 AttachmentController 断开攻击测试验证，不涉及 LLM 自由行为"
tags: [hub, stability, attachment, stream, undici, race-condition, offline-feedback]
modules:
  - src/interface-adapters/http/controllers/attachment-controller.ts
  - tests/interface-adapters/http/attachment-stream-race.test.ts
  - tests/interface-adapters/http/fixtures/stream-race-server.mjs
intent:
  problem: "hub 进程在附件下载/客户端断开时偶发 uncaughtException 退出（TypeError: ReadableStream is already closed，ERR_INVALID_STATE，stack 全 undici 内部帧无应用帧），单次断开即崩溃整个 hub（所有 SSE/connector 会话连带中断）。"
  expected_effect: "修复后附件响应 body 为真 WHATWG ReadableStream（undici 透传），重复断开/轮询/广播不触发 undici 包装层 cancel→close 竞态；确定性竞态测试中 toWeb 形态在同攻击时序下存活且 legacy 形态仍崩（攻击有效性元验证）；真实 AttachmentController 断开攻击零 uncaughtException。"
  verify_by:
    type: behavior_check
  rollback: "revert 本 PR 即恢复旧形态（fs.ReadStream 类型欺骗直喂 Response）；无 schema/配置变更，回滚即完整复原崩溃前行为。"
  risk_note: "修复只覆盖 hub 自有代码的响应构造形态；undici ReadableStreamFrom 自身的 close 非幂等是 Node 内置依赖层缺陷（node v24.14.1 deps/undici/undici.js:1562-1590），hub 内其他未来新增代码若再把 Node async iterable 直喂 new Response() 会重新暴露——依赖机械回归测试（legacy 路由用例）与评审守住。"
---

# 附件流式响应关闭竞态修复（#2010）与 D3 离线反馈排查结案

## 预注册（troubleshooting 步骤 1）

- 预期根因方向 X：hub 内某处用 fetch（undici）消费流式响应（最可能 LLM streaming），流提前中断/未完全消费且错误未捕获，undici 内部异步 close 抛 ERR_INVALID_STATE 成为 uncaughtException。
- 验证标准 Y：代码中定位 uncaughtException 退出点 + fetch 流式消费缺错误处理的分支；且能 dump 出 undici:1573 对应调用点、最小复现 stack 与日志一致。
- 放弃条件 Z：若证据指向 SSE 服务器侧 Web 流转换或附件响应路径（非 fetch 客户端），放弃此预期。

**预期 vs 实际**：部分命中（偏离一处）——确是 undici 包装流的 cancel→close 竞态，但位置不在 LLM fetch 消费端，而在 **Response 构造端**（`new Response(fs.ReadStream)` 触发 undici extractBody 的 async-iterable 分支包装）。崩溃日志中「崩溃前 5ms 恰有 GET /api/attachments/... 200 (duration 1ms)」是改变方向的关键证据：undici 是 Node fetch 客户端实现，服务器侧不经过它，唯有 Response 构造器才会引入 undici 包装层。

## 问题现象（#2010）

计划 C 本地部署验收（隔离 alpha hub，main `c374cb4e`）期间，hub 进程 `uncaughtException` 退出：

```
TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is already closed
    at ReadableByteStreamController.close (node:internal/webstreams/readablestream:1162:13)
    at node:internal/deps/undici/undici:1573:30
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

- 全栈无应用帧（异步 tick 中抛出）
- 崩溃前 5ms 最后一次业务活动：`GET /api/attachments/427aec48-...` 返回 200（duration 1ms——handler 返回 Response 的时间，body 异步流式消费）
- 单实例单次复现，但进程级崩溃 → P1

## 根因分析

### 机制链（每步有证据锚点）

1. **危险形态**：`attachment-controller.ts:173`（修复前）`return new Response(stream as unknown as ReadableStream, { headers })`，其中 `stream = fs.createReadStream(absPath)` 是 **Node ReadStream（async iterable）**，类型欺骗只骗过 TypeScript，运行时它不是 WHATWG ReadableStream。
2. **undici 包装**：undici `extractBody`（node v24.14.1 `deps/undici/undici.js:6842`）`stream = webidl.is.ReadableStream(object) ? object : ReadableStreamFrom(object)`——非 Web 流（含 async iterable）落入 `ReadableStreamFrom` 包装（undici.js:1562-1590）。
3. **竞态点**：`ReadableStreamFrom` 的 pull 实现（undici.js:1568-1577）——`iterator.next()` resolve `done=true` 后执行 `queueMicrotask(() => { controller.close(); ... })`，**对 controller 状态零检查**（close 非幂等、cancel 无守卫）。
4. **触发链**：客户端断开 → @hono/node-server `writeFromReadableStreamDefaultReader`（`@hono/node-server/dist/index.mjs:769-794`）的 `writable.on("close") → reader.cancel()` → 流 cancel 算法关闭 controller → 此前 pending 的 `iterator.next()` 此后 resolve done → `queueMicrotask(controller.close())` 落在已关闭 controller 上 → **ERR_INVALID_STATE** → queueMicrotask 回调抛错无人捕获 → **uncaughtException → main.ts:57 handler → 进程退出**。
5. **为何 planc 只崩一次**：窗口 = 「pull pending 期间 cancel」。持续 read 循环（hono 消费）下 pull 几乎恒 pending，但 cancel 必须恰落在其中——单次附件下载 + 客户端断开才命中。崩溃日志中 invoke 完成后 52 秒的 attachment 请求是唯一可对齐的触发源。

### 复现实验（修复前失败证据固化，troubleshooting 5a）

最小复现脚本（受控 async generator + undici Response 包装 + hono 式持续读循环 + pull pending 窗口内 cancel）稳定触发**与生产崩溃逐帧一致**的 stack：

```
TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is already closed
    at ReadableByteStreamController.close (node:internal/webstreams/readablestream:1162:13)
    at node:internal/deps/undici/undici:1573:30
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

关键：cancel 时若无 pending pull（无持续读方）则不崩——解释了「多数断开无恙、偶发崩溃」。

## 修复

**修法决策树①（既有语义内修 / narrow-fix）**：`attachment-controller.ts` getById 的响应构造改为 Node 原生转换：

```ts
const stream = Readable.toWeb(fs.createReadStream(absPath)) as unknown as ReadableStream<Uint8Array>;
return new Response(stream, { headers });
```

`Readable.toWeb()` 产生真 WHATWG ReadableStream → undici extractBody `webidl.is.ReadableStream(object)` 命中 → **直接透传（不包装）** → 竞态面消失；cancel 走 Node toWeb 流的 cancel 实现（`stream.destroy()`），无 undici queueMicrotask(close)。

### 机制识别检查点（命中论证）

清单逐项：新增配置字段□ 无 / 新增状态生命周期□ 无 / 新增定时任务□ 无 / 新增信号类型□ 无 / 新增持久化□ 无 / 新增决策分支□ 无（cast 语义修正，运行时同路径）/ 新增跨模块调用□ 无。**全部未命中 → 走修法决策树① narrow-fix**。

### 影响面排查（同类形态全库扫描）

`new Response(` 全库 5 处：
- `attachment-controller.ts:173` ← 本修复（唯一 async-iterable 喂入点）
- `mahjong-controller.ts:229`：真 Web ReadableStream（enqueue 有 try-catch）→ undici 透传 ✓ 安全
- `server.ts:52/54`：字符串 body ✓ 安全
- `background-controller.ts:13`：Uint8Array ✓ 安全

hono `streamSSE`（sse-streamer.ts）经 TransformStream（非 bytes 流）+ undici 透传 ✓ 安全。崩溃栈的 `ReadableByteStreamController`（bytes 流专属）与 `ReadableStreamFrom` 的 `type: "bytes"` 构造互相印证：SSE 路径自始不在嫌疑内（与 issue 初判「疑似 SSE」相反——修正了初判方向）。

### 负向验收（本次变更破坏了什么旧契约 / 绕过了什么既有保护）

- 未破坏任何旧契约：`Content-Length`（stat.size）、缓存头、nosniff、Content-Disposition 全部不变；变更仅是 body 的流形态（Node stream → Web stream），HTTP 语义等价。
- 未绕过既有保护：不涉及鉴权/守卫/配置。
- 旧代码的 `as unknown as ReadableStream` 双重 cast 保留（toWeb 返回的 Node 类型声明与 DOM lib ReadableStream 类型对齐需要），但语义从「Node 对象硬骗」变为「同构类型对齐」（运行时同一 WHATWG ReadableStream 类）。

## 验证

### 确定性回归测试（tests/interface-adapters/http/attachment-stream-race.test.ts + fixtures/stream-race-server.mjs）

| 用例 | 操作 | 预期结果 | 实际 |
|---|---|---|---|
| 元验证（红基线） | 子进程真 @hono/node-server，`/legacy` 路由 `new Response(nodeStream)`（受控流：chunk1→挂起→客户端 abort→EOF 迟到 400ms） | 子进程 exit(42) + stderr 含 ERR_INVALID_STATE（攻击手段有效性=修复前失败的永久固化） | PASS（640ms） |
| 修复面 | 同时序下 `/fixed` 路由 `new Response(Readable.toWeb(nodeStream))` | 子进程存活、无 ERR_INVALID_STATE | PASS（3220ms） |
| 真实端点攻击 | 真 AttachmentController（真 sqlite/busboy/sharp 管线）+ 8MB 文件 + 3 次中途 abort，进程内接管 uncaughtException 计数 | 零 uncaughtException | PASS（773ms） |
| 攻击后服务未损 | 同 server 完整下载 | 200 + 8MB 内容完整 | PASS |

### 既有回归

- `tests/interface-adapters/http/` 全目录：24 文件 211 测试全绿（含 attachment-api.test.ts 12 用例）
- `npm run build`：通过（tsc + tsc-alias + web build + package）
- eslint（改动文件）：0 违规

### alpha 真实验证（隔离实例 a4105269，端口 3194，本 worktree 构建）

```
attack 0-4: read 65536B then abort   ×5
full download: 200 8388608 bytes content OK
RESULT: SURVIVED（hub PID 77742 存活）
```

## D3 离线反馈排查结案（同简报关联排查项）

### 现象（planc P5，2026-11-24）

目标机离线时用户请求 remote 执行：invoke 序列为 `#16 user 请求 → #17 invoke_start → #18 invoke_end「[系统] 重试后仍未调用 yield 工具」`——**无任何 speak entry**，助手回复彻底丢失。

### 根因（alpha 实例 fe9de8d3 invoke_events 实锤）

invoke `4e69e0b8` 的 20 条事件显示：agent 调 bash → fail-closed 错误（机器未注册）→ agent **调 speak 5 次、调 yield 2 次，全部返回同一错误** `<harness>[error] Execution machine not registered: connector-6bde5467</harness>` → agent 直出文本（孤儿）两轮 → no_yield 耗尽 → invoke_end 通用失败文案。

链路：planc 时点（`c374cb4e`）SDK env 工厂为 `executionMachines.resolveForConversation(conversationId)`（`git show c374cb4e:src/frameworks/agent/durable-session.ts` 第 122-128 行）——设备离线时 resolve 抛错，而 **SDK 在每个工具 execute 之前构造 env**（构造失败炸掉全部工具，含 speak/yield 这类纯中枢工具）。

### 处置结论：主根因已被 #2041 修复，不在本 PR 范围

当前 HEAD（f0d83d19）的 env 工厂已改为占位 env 恒成功（`src/frameworks/agent/placeholder-execution-env.ts`，#2041 统一注册制切片，commit 03326843，2026-11-26 10:04 合入）；speak/yield 的 execute 不触碰 env 执行面（tool-factory.ts 无 `env.` 调用）。

**alpha 真实 LLM 全链路验证（本 worktree 构建，无 connector 的离线形态）**：

```
speak: 命令没有执行……执行机 connector-nonexistent-999 不在机器池中，工具按
fail-closed 规则拒绝了请求，也没有自动换机。目前在线的执行机是
connector-94b3fd9f（hub-orca-mbp.local）。如果你确认改用这台，我再运行。
yield: → 交给 user
VERDICT: D3 PASS: 离线反馈经 speak 到达用户，yield 正常交棒
```

即 D3 的三个目标全部达成：离线反馈可定位（机器 id + 在线清单）、用户可理解（自然语言 + 改进建议）、不丢成孤儿文本（speak entry 落库）、yield 正常（无「重试后仍未调用 yield」）。

### 残余缺口（建议另立 issue，非本 PR 域）

orchestrator no_yield 耗尽路径（`orchestrator.ts:1057`）的失败文案为通用「[系统] 重试后仍未调用 yield 工具」，不带 `result.directText`（孤儿文本）摘要——若未来 agent 因其他原因 no_yield，其最后解释仍会丢。属 UX 兜底增强，与 D3 主根因（发言通道被炸）不同层。

## 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 竞态元验证 | `npx vitest run tests/interface-adapters/http/attachment-stream-race.test.ts` | 4 用例 PASS（legacy 崩 + toWeb 存活 + 真实端点攻击零 uncaught + 攻击后完整下载） |
| 行为断言（外部可观察） | 测试内子进程 exit code | `/legacy` → 42（ERR_INVALID_STATE）；`/fixed` → 非 42 且 stderr 无 ERR_INVALID_STATE |
| 既有回归 | `npx vitest run tests/interface-adapters/http/` | 全绿 |
| 构建 | `npm run build` | exit 0 |

## 最简实现检查

已过最简检查：一行 `Readable.toWeb()` 是 stdlib/平台原生路径（阶梯第 2 级），无更简达成方式（不引入依赖、不新增抽象、不改 hono 层）。

## 风险与回滚

- 风险：undici `ReadableStreamFrom` 的 close 非幂等是依赖层缺陷，本修复只移除 hub 侧暴露面。未来新增代码若再把 Node async iterable 直喂 `new Response()` 会重新暴露——由元验证用例（legacy 路由持续存在并断言崩溃）+ 对抗审视守住。
- 回滚：revert 本 PR 即恢复旧形态；无 schema/配置/数据变更。

## 关联

- issue #2010（本 PR 修复）
- planc 探查报告（对话工作区 connector-onboarding-evidence/planc/）
- #2041 / F20261126expot（D3 主根因的既有修复，本文档附验证证据）
