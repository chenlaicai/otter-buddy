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
| 2 | 模块级副作用读取文件系统 | `config-service.ts:232` | LOW-MED | P1 |
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
- 其余 3 处 → kind: `"validation"`

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

**方案**: 删除 `config-service.ts:232`。`loadConfig` 函数保留（`main.ts` 启动时用）。

**风险评估**: grep 确认无文件直接从 `config-service` 导入 `config`（均通过 barrel）。但需注意测试文件中是否有直接 import——需在 worktree 中 grep 确认。

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

- **#1**: 单元测试验证 abort 抛出 DomainError 且 kind 正确
- **#5/#6**: 单元测试验证 push 超限后数组长度不超 MAX
- **#7**: 检查 SchedulerService 构造接受 logger，错误走 logger.error
- **#8**: TypeScript 编译通过（类型引用正确）
- **#2**: `npm test` 通过（config 惰性加载不影响启动）
- **#4**: SSE 流式测试通过（事件不丢失、close 正确终止）
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

---

*本方案基于架构师视角对抗性审查，由 issue #113 检视报告驱动。*
