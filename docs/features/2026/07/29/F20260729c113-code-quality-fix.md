# F20260729c113 代码质量修复方案

**Issue**: #113 代码质量对抗性检视报告
**类型**: BugFix（代码质量 + 1 个隐藏 bug）
**日期**: 2026-07-29
**检视方法**: 架构师视角对抗性审查 → 修复设计

---

## 项目背景

基于 issue #113 检视报告，对全仓代码质量进行架构师视角对抗性审查。审查发现 8 项问题，其中 1 项为隐藏 bug（abort 错误类型导致客户端收到 500 而非 404/422），其余为代码卫生和架构合规问题。

---

## 问题清单与分级

| # | 问题 | 文件 | 风险 | 优先级 |
|---|------|------|------|--------|
| 1 | `abort()` 抛 `Error` 而非 `DomainError` | `send-message.ts:293-303` | LOW | P0 bug fix |
| 2 | 模块级副作用读取文件系统 | `config-service.ts:232` | MEDIUM | P1 |
| 3 | 框架层绕过 Repository 直接查 DB | `pi-session-factory.ts:393` | MEDIUM | P2 |
| 4 | SSE 忙等待轮询浪费 CPU | `sse-streamer.ts:80` | LOW-MED | P1 |
| 5 | `callHistory` 无界增长 | `tool-call-circuit-breaker.ts:179` | LOW | P1 |
| 6 | `recentSegments` 无界增长 | `output-guard.ts:43` | LOW | P1 |
| 7 | Scheduler 用 `console.error` | `scheduler-service.ts:62,126` | LOW | P1 |
| 8 | `DetailLevel` 类型定义重复 | `memory-entry.ts:50` / `otter-tool-client.ts:8` | LOW | P2 |

---

## 修复策略

按风险分三批，每批独立可提交：

### 第一批：独立修复（LOW 风险，5 项）

#### #1 `abort()` → DomainError

**文件**: `src/usecases/conversation/send-message.ts:293-303`

**现状**: `abort()` 是同文件中唯一使用 `throw new Error` 的方法。`complete()`、`fail()`、`startSpeaking()` 等均使用 `DomainError`。

**影响**: 控制器层 `http-error.ts` 按 `DomainError.kind` 映射 HTTP 状态码。当前 `abort()` 的普通 `Error` 会穿透到 500 通用处理器，客户端收到 500 而非正确的 404/422。**这是一个隐藏的 bug。**

**方案**: 替换 4 处 `throw new Error` → `throw new DomainError`：
- `Message not found` → kind: `"not_found"`
- `Cannot abort message with status` → kind: `"conflict"`（资源状态冲突，非输入校验）
- 其余 2 处（body / talkingStonePassedTo） → kind: `"validation"`

**kind 分配决策**: `Cannot abort message with status` 使用 `conflict`(409) 而非 `validation`(400)。理由：
- 代码库已有 2 处使用 `conflict`：`manage-participant.ts:43`（Otter already joined）、`manage-session.ts:58`（Otter already has active session）
- `DOMAIN_ERROR_STATUS` 已映射 `conflict: 409`，无需修改映射表或前端
- 语义精确：消息 status 是资源状态，不是客户端输入；"资源当前状态不允许该操作" = conflict

**测试补充**: 现有 abort 测试（`send-message.test.ts:753+`）仅覆盖 happy path。需补充 4 个 error path 测试用例：
- message not found → 404
- invalid status → 409
- empty body → 400
- invalid talkingStonePassedTo → 400

**依赖**: `DomainError` 已在文件头部 import，零新增依赖。

---

#### #5 `callHistory` 上限

**文件**: `src/frameworks/agent/tool-call-circuit-breaker.ts:179`

**现状**: `callHistory` 数组在每次 `check()` 时 push，永不裁剪。

**实际影响**: ToolCallCircuitBreaker 是 per-invoke 生命周期，`maxToolCalls` 默认 40、硬限 43，实际增长有自然上界。但这是防御性加固。

**方案**:
```typescript
private static readonly MAX_HISTORY = 100;
// 在 push 后：
if (this.callHistory.length > ToolCallCircuitBreaker.MAX_HISTORY) {
  this.callHistory.shift();
}
```

**替代方案考量**: `detectSlidingWindowRepeat` 内部已做 `history.slice(-windowSize * repeatThreshold)`，只看最后 18 条。但 `logCircuitBreak` 和 `getCallHistory` 使用完整历史做诊断，保留合理上界（100）比完全截断更合适。

---

#### #6 `recentSegments` 上限

**文件**: `src/frameworks/agent/output-guard.ts:43`

**现状**: `recentSegments` 在每次积累片段时 push，永不裁剪。

**实际影响**: OutputGuard 也是 per-invoke 生命周期。`maxRepeatedSegments` 默认 50、streaming timeout 120s，实际增长有自然上界。

**方案**: 加上限常量 `MAX_SEGMENTS = 200`，push 后裁剪。

**替代方案考量**: 可改为 `Map<string, number>` 做出现次数计数，天然有界且 `segmentOccurrences` 从 O(n) 降为 O(1)。但改动范围更大，需验证 `recentSegments` 的语义（顺序是否重要）。当前选择最小改动方案。

---

#### #7 SchedulerService 注入 Logger

**文件**: `src/usecases/scheduler/scheduler-service.ts`

**现状**: `SchedulerServiceOptions` 缺少 `logger` 字段。两处错误处理用 `console.error`，有 `// eslint-disable-next-line no-console` 注释（团队已知违规）。

**方案**:
1. `SchedulerServiceOptions` 加 `logger: Logger`
2. 构造函数存 `private readonly logger: Logger`
3. 两处 `console.error` → `this.logger.error`，删除 eslint-disable 注释
4. `main.ts` 实例化处补传 logger

**依赖**: `Logger` 接口在 `@usecases/ports/logger`，usecases 层已广泛使用。

---

#### #8 DetailLevel 去重

**文件**: `src/interface-adapters/agent-runtime/otter-tool-client.ts:8`

**现状**: `DetailLevel = "summary" | "snippet" | "full"` 在两处独立定义：
- entities 层 `memory-entry.ts:50`（领域概念，规范位置）
- interface-adapters 层 `otter-tool-client.ts:8`（重复定义）

**方案**:
1. 删除 `otter-tool-client.ts:8` 的 `DetailLevel` 定义
2. 加 `import type { DetailLevel } from "@entities/memory/memory-entry"`
3. 该文件已有 `import type { Message } from "@entities/conversation/message"`，import 模式一致

**风险**: TypeScript 类型别名是结构化的，运行时零影响。grep 确认无外部消费者从 `otter-tool-client` 导入 `DetailLevel`。

---

### 第二批：模块边界修复（LOW-MED 风险，2 项）

#### #2 移除 config-service 模块级副作用

**文件**: `src/frameworks/config-service.ts:232`

**现状**: `export const config: AppConfig = Object.freeze(loadConfig())` 在模块 import 时立即执行文件系统读取。

**barrel 已有惰性方案**: `src/frameworks/config/index.ts` 用 `Proxy` + `initConfig()`/`getConfig()` 实现惰性初始化，不 re-export config-service 的 `config`。

**方案**:
1. 删除 `config-service.ts:232`。`loadConfig` 函数保留（`main.ts` 启动时用）。
2. 更新 `tests/frameworks/config-service.test.ts`：该文件第 17 行直接导入 `config`（`typeof import("../../src/frameworks/config-service").config`），第 130-143 行测试 `config` 是否 frozen 且结构正确。删除导出后测试编译失败。**处理方式**：删除该测试块——barrel 的 Proxy config 已有独立行为，测试 eager-load 的 frozen 属性是测实现细节而非正确性。

**风险评估（MEDIUM）**: 生产代码均通过 barrel 导入 config，无影响。风险在于测试文件的同步修改：删除 `config` 导出 + 删除对应测试块。风险来自改动范围（测试文件），而非语义差异。

---

#### #4 SSE 忙等待 → Promise 通知

**文件**: `src/interface-adapters/http/sse-streamer.ts:78-83`

**现状**: 队列为空时 `setTimeout(resolve, 10)` 轮询，每 10ms 唤醒一次。

**通知链路已存在但未接通**: `push()` 和 `close()` 已调用 `waiting?.()`，但 `processSSEQueue` 从未将 `resolve` 存入 `waiting`，而是用 `setTimeout` 轮询。

**方案**:
```typescript
// 替换当前的：
if (queue.length === 0) {
  await new Promise<void>((resolve) => { setTimeout(resolve, 10) });
  onWait();
  continue;
}
// 改为：
if (queue.length === 0) {
  await new Promise<void>((resolve) => { waiting = resolve; });
  continue;
}
```

删除 `onWait` 参数。调用处 `streamEvents` 删除 `() => { waiting = null; }` 传参。

**边界情况**: `close()` 在无人等待时调用 `waiting?.()` 是 no-op（waiting 为 null）——与当前行为一致。Promise resolve 后 `waiting` 不会被显式置 null，但下次循环若队列仍空会重新赋值 `waiting = resolve`，不会 double-resolve。

**测试补充**: 需覆盖 Promise 通知路径的边界场景：
- push 在等待中被调用 → 事件正确消费
- close 在等待中被调用 → 循环正确退出

---

### 第三批：架构层修复（MEDIUM 风险，1 项）

#### #3 PiSessionFactory 注入 OtterRepository

**文件**: `src/frameworks/agent/pi-session-factory.ts:393`

**现状**: `buildIdentityPrefix` 用 `this.cfg.db.prepare("SELECT name FROM otters WHERE id = ?")` 直接查 DB，绕过 Repository 抽象，违反 Clean Architecture 分层。

**方案**:
1. 构造函数 cfg 加 `otterRepo: OtterRepository`
2. `buildIdentityPrefix` 改为 `async`，用 `const otter = await this.otterRepo.getById(otterId)` 替代 raw SQL
3. 级联：`buildUserMessagePrefix` → async → `_executeWithSession` 中的调用加 `await`
4. `main.ts` 实例化处传入 `repos.otter`

**风险评估**:
- 方法签名从 sync 变 async，级联到 `_executeWithSession`（已是 async，影响有限）
- `OtterRepository.getById` 返回 `Promise<Otter | null>`，比 raw SQL 返回 `{ name: string }` 多了字段但用法不变（只取 `.name`）
- SqliteOtterRepository 内部也是 `this.db.prepare().get()`，性能无差异

**替代方案考量**: 可以在 `PiSessionFactory` cfg 中加一个更窄的接口 `Pick<OtterRepository, 'getById'>` 而非完整 `OtterRepository`，减少耦合。但当前构造函数已接收多个依赖，风格一致即可。

---

## 提交计划

```
Commit 1: [F20260729c113][quality][BugFix] abort() 错误类型修正 + 数据结构上界 + Logger 注入 + 类型去重
  - #1 abort DomainError
  - #5 callHistory 上限
  - #6 recentSegments 上限
  - #7 Scheduler Logger
  - #8 DetailLevel 去重

Commit 2: [F20260729c113][quality][BugFix] 消除模块级副作用 + SSE 事件驱动
  - #2 config 惰性初始化
  - #4 SSE promise 通知

Commit 3: [F20260729c113][quality][BugFix] PiSessionFactory 注入 OtterRepository 替代直接查 DB
  - #3 Repository 抽象
```

---

## 验证方式

- **#1**: 补充 4 个 error path 测试（message not found / invalid status / empty body / invalid talkingStonePassedTo），验证抛出 DomainError 且 kind 正确
- **#5/#6**: 单元测试验证 push 超限后数组长度不超 MAX
- **#7**: 检查 SchedulerService 构造接受 logger，错误走 logger.error
- **#8**: TypeScript 编译通过（类型引用正确）
- **#2**: 删除 config-service 测试块 + `npm test` 通过
- **#4**: 补充 Promise 通知路径测试（push/close 在等待中被调用），SSE 流式测试通过
- **#3**: 身份注入功能测试通过（name 正确注入到 prompt）
- **全量**: `npm test` + `npm run build` 通过

---

## 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| callHistory 上限值 | 100 | maxToolCalls=40 硬限 43，100 留足诊断缓冲 |
| recentSegments 上限 vs Map | 上限 200 | 最小改动；Map 改动大且需验证顺序语义 |
| config 副作用删除 vs 改懒加载 | 删除 | barrel 已有 Proxy 懒加载，源文件这行是遗留 |
| SSE 等待方式 | Promise 直接存 resolve | 通知链路已存在，只需接通 |
| OtterRepository 注入方式 | 完整接口注入 | 构造函数风格一致，不为单方法开窄接口 |
| abort kind 分配 | `conflict` 用于状态冲突 | 代码库已有 2 处 `conflict` + `DOMAIN_ERROR_STATUS` 已映射 409；语义精确匹配 |
| complete/fail kind 不一致 | 本次不改，属历史遗留 | `complete()`/`fail()` 对同类模式（"Cannot [verb] message with status"）用 `validation`(400)，`abort` 用 `conflict`(409)。`conflict` 语义更精确，后续 sweep 可统一 |
| config 测试处理 | 删除 frozen 测试块 | 测实现细节（frozen）而非正确性，barrel Proxy 已覆盖 |

---

## 不在范围

原始 issue #113 提到但本次不修复的问题：

| 问题 | 排除理由 |
|------|----------|
| 1.1 过度使用 `as` 类型断言 | 长期重构项，需逐处引入运行时验证（zod/io-ts），改动面大，不适合 bugfix |
| 2.2 错误静默吞没（store-memory / agent-invoker） | 需逐处评估错误语义（是否应上抛、重试、死信），单独 issue 跟踪 |
| 3.2 `activeSessions` Map 无界 | 依赖进程崩溃场景，已有 finally 清理；若需更稳健应加 TTL eviction，属功能增强 |
| 3.3 进程信号处理（缺 SIGTERM） | 功能增强，需评估 graceful shutdown 策略，单独 issue 跟踪 |
| 5.x 代码重复（术语搜索 / 系统消息创建） | 重构项，不影响正确性，单独 issue 跟踪 |
| 6.x SRP 违反（main.ts / send-message / pi-session-factory） | 大型重构，每个文件需独立拆分方案，不适合本次 |
| 7.x 命名不一致（Repository 方法 / PiSessionFactory 类名） | 命名规范统一需全仓 sweep，涉及 API 变更，单独 issue 跟踪 |

---

## 对抗检视记录

### 第一轮对抗检视

**检视方**: 架构师 agent（对抗性审查）
**日期**: 2026-07-29

**结果**: 有条件通过（8 项中 1 项 CONCERN）

| # | 评级 | 检视意见 | 决策 |
|---|------|----------|------|
| 1 | PASS | kind 应考虑 `conflict`(409)；需补 error path 测试 | 初版保持 `validation`；第二轮检视发现 `conflict` 已有 2 处使用，改为采纳 `conflict` |
| 2 | CONCERN | 测试文件直接导入 config 会 break；Proxy vs frozen 语义差异 | 采纳测试影响；拒绝语义差异论（过度推演），风险上调 MEDIUM 的理由是测试文件改动 |
| 3 | PASS | 需确认 `initAgentSessionFactory` 级联 | 采纳，实施时确认 |
| 4 | PASS | 需补 Promise 通知路径测试 | 采纳 |
| 5-8 | PASS | 无改进 | — |

### 第二轮对抗检视

**检视方**: 架构师 agent（对抗性审查）
**日期**: 2026-07-29

**结果**: 有条件通过（8 项中 1 项 REJECT）

| # | 评级 | 检视意见 | 决策 |
|---|------|----------|------|
| 1 | REJECT | "conflict 全仓未使用"是事实错误——已在 2 处生产代码使用 | 采纳：`Cannot abort with status` 改用 `conflict`(409) |
| 2 | PASS | 删除测试块决策正确 | — |
| 3 | PASS | 级联影响已正确评估 | — |
| 4 | PASS | Promise 通知方案正确 | — |
| 5-8 | PASS | 无改进 | — |
| 不在范围 | PASS | 排除理由充分，无遗漏高价值项 | — |

**阻塞项处理**: #1 kind 分配修正为 `conflict`，文档事实错误已修正。

### 第三轮对抗检视

**检视方**: 架构师 agent（最终审查）
**日期**: 2026-07-29

**结果**: 全部通过（8 项 PASS，无阻塞项）

| # | 评级 | 检视意见 | 决策 |
|---|------|----------|------|
| 1 | PASS | complete/fail 对同类模式用 `validation`，abort 用 `conflict` 存在不一致 | 补充设计决策记录：complete/fail 为历史遗留，后续 sweep 统一 |
| 2 | PASS | 测试文件 config 变量清理需连带处理 | 补充实施步骤 |
| 3 | PASS | 无新发现 | — |
| 4 | PASS | 建议补充调用处代码片段 | 文档已描述，实施时参照 |
| 5-8 | PASS | 无新发现 | — |

**新发现盲点**:
- barrel Proxy 的 `Object.keys()` / `JSON.stringify()` 行为与 frozen 对象不同（当前无代码使用，不在范围）
- #1 风险标 LOW 但优先级 P0 存在不一致（文档内部一致性问题）

---

*本方案经过三轮对抗检视，由 issue #113 检视报告驱动。*
