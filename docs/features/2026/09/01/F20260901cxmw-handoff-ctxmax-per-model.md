---
id: F20260901cxmw
title: "handoff 触发阈值按 otter 实际模型窗口计算（修复 128k 一刀切）"
summary: |
  F20260825hndf Phase 1 遗留的占位实现：getCtxMax 无条件返回 128k，handoff 触发线恒为
  0.7×128k=89.6k，与 otter 实际模型的 contextWindow 脱钩。双向缺陷：大窗口模型（如 1M）
  在真实窗口 8.5% 时就被交接，白白丢失上下文；小窗口模型（<128k）触发线可能超过真实窗口，
  交接失明。本修复将 getCtxMax 接上真实链路（otterId → modelAlias → modelPool.getContextWindow），
  走 usecases/ports 窄端口注入避免 interface-adapters 越层依赖 frameworks，含三级回退链与
  可观测日志。
change_type: fix
status: active
capability_test: "n/a: 确定性阈值解析逻辑，无 LLM 行为变更"
created_in_conversation: 9d326c9d-9818-40a2-9982-898315fe7aa4
from: F20260831hndp
---
# F20260901cxmw handoff 触发阈值按 otter 实际模型窗口计算

> 状态：已实现，待对抗审视
> 作者：ctxfix（glm）
> 日期：2026-09-01
> 触发：搭档「这个上下文阈值是个缺陷，我觉得很严重，必须得先修复」
> 前身：F20260825hndf（Phase 1 交付触发链路时留的占位）/ F20260831hndp（Phase 2 文档中 getCtxMax 注释「Phase 2 通过 modelPool.getContextWindow 获取精确值」从未接上）

## 1. 缺陷描述

`src/interface-adapters/agent-runtime/agent-invoker.ts` 的 `getCtxMax(otterId)`：

```ts
// 修复前（占位实现）
private async getCtxMax(_otterId: string): Promise<number | undefined> {
  // Phase 1：用默认值 128k；Phase 2 通过 modelPool.getContextWindow 获取精确值
  return DEFAULT_CTX_MAX;
}
```

otterId 参数被忽略，`HANDOFF_THRESHOLD = 0.7` 作用在恒定的 128k 上。

**双向后果**：

1. **大窗口模型交接过于频繁**：本地池 glm/mimo/mimo-vision/glm-flash 的 contextWindow 均为 1048576（1M），89.6k 触发线 = 真实窗口的 **8.5%**。每轮 pre-invoke 检查在 89.6k 就触发交接，上下文被过早抛弃。
2. **小窗口模型交接失明**：若池中存在 contextWindow < 128k 的模型，0.7×128k = 89.6k 可能超过真实窗口，`prevTokens >= ctxMax × 0.7` 永假——handoff 永不触发，或触发前就撞窗口墙。

## 2. 方案设计

### 2.1 窄端口注入（不越层）

AgentInvoker 在 interface-adapters 层，ModelPool 在 frameworks 层，不能直接 import。参照
`model-pool-like.ts` 窄接口模式与 buildHandoffPkg 的注入法（bootstrap 组装闭包注入）：

**新端口** `src/usecases/ports/otter-context-window-provider.ts`：

```ts
export interface OtterContextWindowProvider {
  getOtterContextWindow(otterId: string): number | undefined;
}
export const MIN_SENSIBLE_CTX_WINDOW = 8_000;
```

同步签名有意为之（与 OtterConfigProvider.getConfig 一致——SQLite 同步驱动）。

**组装**（`src/bootstrap/platforms.ts`）：

```ts
function buildCtxWindowProvider(modelPool: ModelPool, otterConfigProvider?: OtterConfigProvider): OtterContextWindowProvider {
  return {
    getOtterContextWindow: (otterId) => {
      const alias = otterConfigProvider?.getConfig(otterId)?.modelAlias;
      return modelPool.getContextWindow(alias); // null/undefined → 默认模型窗口（ModelPool 语义）
    },
  };
}
```

### 2.2 三级回退链

| 级 | 条件 | 结果 |
|---|------|------|
| 1 | otter 配了 modelAlias | `getContextWindow(alias)` |
| 2 | 没配 alias | `getContextWindow(undefined)` = 默认模型窗口 |
| 3 | 查出 undefined / 0 / < 8000 | `DEFAULT_CTX_MAX`（128k）兜底 |

第 3 级的下限保护针对真实场景：`models-factory.ts:143` 注释实锤「contextWindow 缺省时 SDK 视为
0」——0 直接当窗口用会让阈值恒真（任何正数 tokens ≥ 0.7×0），与 F20260808ctxw 的
shouldCompact 恒真问题同源。下限 8000 取保守值：低于该值的 contextWindow 不构成可用窗口。

### 2.3 getCtxMax 重写

```ts
private getCtxMax(otterId: string): number {  // 同步化（原为 async 占位）
  const cached = this.resolvedCtxMax.get(otterId);
  if (cached !== undefined) return cached;
  const window = this.ctxWindowProvider?.getOtterContextWindow(otterId);
  const [resolved, source] = (window !== undefined && window >= MIN_SENSIBLE_CTX_WINDOW)
    ? [window, 'model-pool'] : [DEFAULT_CTX_MAX, 'fallback-128k'];
  this.resolvedCtxMax.set(otterId, resolved);
  this.logger.info('[handoff] ctxMax resolved', { otterId, ctxMax: resolved, source });
  return resolved;
}
```

要点：
- **按 otterId 缓存**：ModelPool 的 entries 启动后不可变；defaultAlias 可通过 settings 页运行时切换，仅影响无显式 modelAlias otter 的新解析（新 session 口径），已缓存的 otter 保持首解析值（cxrev 审视发现 #3 措辞精确化）。
- **断言策略（cxrev 审视发现 #2 补强）**：可观测性断言验证 structured data（ctxMax/source 字段值）而非仅 message 字符串——区分「正确回退 128k」与「错误使用 0」（两者 message 相同）。内联 createDataCapturingLogger 捕获 info(msg, data)，不改共享 helper（避免影响 24 处既有消费者）。
- **同步化**：原 async 签名是为未来查库预留的占位，实际链路（getConfig/Map.get）全同步，落地为同步调用（cxrev 审视焦点 3 核实：无时序竞态）。

### 2.4 注入点

- `AgentInvoker` 构造函数新增第 18 个可选参数 `ctxWindowProvider?: OtterContextWindowProvider`（缺省 undefined → 128k 兜底，兼容全部既有测试构造）
- `initAgentAndScheduler` 新增可选 options `modelPool` / `otterConfigProvider`
- `app.ts` 调用点传入（两者在 app.ts:213 已解构可用）

## 3. 改动清单

| 文件 | 改动 |
|------|------|
| `src/usecases/ports/otter-context-window-provider.ts` | 新增：窄端口 + MIN_SENSIBLE_CTX_WINDOW |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | getCtxMax 重写（真实链路+缓存+日志）、resolvedCtxMax Map、构造参数 +1、invokeConversationInner 消费点同步化、complexity disable 指令收窄 |
| `src/bootstrap/platforms.ts` | buildCtxWindowProvider 组装函数、initAgentAndScheduler 接 modelPool/otterConfigProvider |
| `src/app.ts` | 调用点传参 |
| `tests/interface-adapters/agent-invoker-handoff.test.ts` | 新增「ctxMax 按实际模型窗口解析」describe（5 用例） |

## 4. 影响面：修前修后触发线对比

本地模型池（config/config.yaml，2026-09-01）各模型的触发线变化：

| 模型 alias | contextWindow | 修前触发线（恒 128k） | 修后触发线 | 变化 |
|-----------|--------------|---------------------|-----------|------|
| mimo | 1048576 (1M) | 89600 | 734003 | **8.2×↑**（修前在 8.5% 窗口就交接） |
| mimo-vision | 1048576 (1M) | 89600 | 734003 | **8.2×↑** |
| glm | 1048576 (1M) | 89600 | 734003 | **8.2×↑** |
| glm-flash | 1048576 (1M) | 89600 | 734003 | **8.2×↑** |
| （假设）窗口 <128k 的模型 | 例 64000 | 89600（**永假，失明**） | 44800 | 从失明修复为正确触发 |
| （假设）未配 contextWindow | SDK 视为 0 | 89600 | 89600（兜底） | 不变，防止 0 恒真 |

部署后验证：grep `[handoff] ctxMax resolved`，确认每个 otter 的 ctxMax 与其模型窗口一致、source=model-pool。

## 5. 测试

新增 5 用例（`agent-invoker-handoff.test.ts` → describe「F20260901cxmw：ctxMax 按实际模型窗口解析」）：

1. **200k 窗口**：100k tokens 修前误触发（≥89600）、修后不触发（<140000）——验证阈值随窗口抬升
2. **64k 小窗口**：50k tokens 修前不触发（<89600，失明场景）、修后正确触发（≥44800）——验证失明修复
3. **provider 返回 undefined**：回退 128k，100k 触发——回退链第 3 级
4. **provider 返回 0**：回退 128k（不用 0 当窗口），50k 不触发；同时断言 `[handoff] ctxMax resolved` 日志存在且仅一条（缓存生效 + 可观测）——回退链第 3 级下限保护
5. **provider 未注入**：保持 128k 兼容行为——构造兼容性

Mock 策略（D1）：`mockCtxWindowProvider` 形状与 platforms.ts 生产闭包同构（真实 Map 存窗口、
getOtterContextWindow 签名一致）；断言策略（D7）：触发断言用 buildHandoffPkg/restartSession
副作用，不绑定调用参数。

既有 7 用例全数保持通过（构造函数追加可选参数向后兼容）。

## 6. 验证（质量门四件套，2026-09-01 10:14 worktree 实测；处置轮复跑见 §8）

| 门 | 命令 | 结果 |
|----|------|------|
| tsc | `npx tsc --noEmit` | exit 0 |
| eslint | 改动 5 文件定向 | exit 0（仅 platforms.ts:1 unused-disable warning，git stash 基线复跑证实 pre-existing 于 main） |
| vitest handoff | `npx vitest run tests/interface-adapters/agent-invoker-handoff.test.ts` | 12/12 passed，exit 0 |
| vitest full | `npx vitest run` | 193 files / 2396 tests passed，exit 0 |

**最简实现检查**：已过。考虑过「扩展 ModelPoolLike 加 getContextWindow」——需改 frameworks 公共端口 + 全部 mock 实现，影响面更大；新窄端口文件 39 行，与 buildHandoffPkg 注入法同模式。缓存用 Map 而非每次查询，避免热路径重复解析。

## 7. 边界与已知限制

- **不动 PR #639**：该 PR 也改 agent-invoker.ts（合成闭包读 directText 修复），保持 OPEN 不碰；同文件冲突由后合入方 rebase 解决。
- **不回改历史文档**：本缺陷的来龙去脉记录在本文档（新建），frontmatter from: F20260831hndp。
- **HANDOFF_THRESHOLD 不变**（0.7）：只修窗口口径，不动阈值本身。

## 8. 审视处置（cxrev 对抗审视，0 严重 / 4 建议）

处置记录（作者逐条走决策树，四分类响应）：

| # | 发现 | 更好/更差 | 处置 | 落点 |
|---|------|----------|------|------|
| 1 | 特性文档 §6 时间戳笔误（2026-09-10:14） | 更好 | **接受并修复** | §6 标题改为 2026-09-01 10:14 |
| 2 | 日志断言只验 message 不验 structured data（ctxMax/source） | 更好 | **接受并修复** | 用例 1/4 补 `toMatchObject({ ctxMax, source })` 断言；内联 createDataCapturingLogger（不动共享 helper，避免影响 24 处既有消费者） |
| 3 | 缓存注释「条目不可变」措辞不精确（defaultAlias 可运行时切） | 更好 | **接受并修复** | 代码注释 + 本档 §2.4/§7 改为「entries 不可变；defaultAlias 可切，仅影响无显式 alias otter 的新解析」 |
| 4 | PR 含 wxsp merge 范围混合 | 更差 | **反驳（附证据）** | 合并是 D10 教训标准动作；wxsp 已在 main（PR #638），本 PR 合入后 diff 即收敛为本修复内容；已按 cxrev 建议在 PR 描述补「含 wxsp merge，该部分变更见 #638」 |

处置轮质量门（2026-09-01 10:38）：tsc 0 / eslint 0 / vitest handoff 12/12 / CI 待推后验证。
- **默认 alias 运行时切换**：切换后无显式 alias otter 的**新解析**用新默认窗口；已缓存的 otter 保持首解析值（cxrev 审视 #3 已精确化：entries 不可变、defaultAlias 可切，切换仅影响新 session 口径的解析）。影响方向保守：新默认窗口更大时 handoff 更晚触发、更小时更早触发。
