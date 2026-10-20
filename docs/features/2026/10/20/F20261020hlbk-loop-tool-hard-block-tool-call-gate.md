---
id: F20261020hlbk
title: 循环工具硬熔断：tool_call 门物理截断 + 检测器报警粘滞标记，堵死"穿插 speak 重置"逃逸
doc_type: feature
created: 2026-10-20
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [guard, loop, circuit-breaker, tool-call, incident-fix]
modules:
  - src/frameworks/agent/model-runtime-registry.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/frameworks/agent/pi-session-factory.ts
  - tests/frameworks/agent/model-runtime-registry.test.ts
  - tests/frameworks/agent/circuit-breaker-helpers.test.ts
change_type: fix
summary: |
  #1556：create_linked_resource 强迫性循环调用（约 40 条垃圾 fact 污染产物流），根因是循环
  检测器只"提示不阻断"。检测器 ToolCallCircuitBreaker 挂在 tool_execution_start（派发后），
  只能 steer（建议）或 session.abort()（整轮中断，且 circuit_break: 类 abort 可重试致循环复活），
  物理上无法阻断单次调用；且 steerStrikes 在任何一次穿插正常调用后清零，"首次 speak 停手声明后
  复又发作"正是靠穿插 speak 重置升级计数。本修复把检测器报警接到唯一的物理阻断钩子 tool_call
  （返回 {block, reason}，haltToolCallGuard 同款）：报警时按签名记进 per-turn 粘滞 Map，tool_call
  门查到即物理阻断该工具后续调用（speak/yield 豁免保逃生）。粘滞 Map 不被穿插调用清零，堵死
  "speak 重置"逃逸；per-turn 作用域对齐假设 A「硬熔断该工具至回合结束」。
causal_links:
  from:
    - F20260716bte2
    - F20260728cbwt
    - F20260806cbsx
---

## 1. 背景与问题现象

### 1.1 事故现场（issue #1556，2026-10-19 同对话两次发作）

- **发作 1**（闭环分流獭）：本意建定时复查任务，`create_linked_resource` 连续误调约 10 次，产生垃圾占位条目。
- **发作 2**（封顶獭）：约 30 条垃圾 fact。首次 speak 停手声明后复又发作；滑动窗口检测器 K=6/M=3 多次报警未物理截断，直到本轮才停。自报根因：「检测器报警被当作需要回应的信号继续调用工具回应」。

合计约 40 条垃圾条目污染产物流（linked_resources），交付物零污染但台账被污染，多数已人工归档。

### 1.2 验收标准（AC）

- **AC1**：同型循环在检测器报警后无法继续调用该工具（物理截断）。
- **AC2**：残留垃圾条目清理完成。

### 1.3 修复方向（issue 假设）

- **假设 A**：同工具连续相似调用 ≥6 次时引擎层硬熔断该工具至回合结束（当前提示性拦截不够）。
- 假设 B（预防）：create_linked_resource 描述加负向提示「定时/轮询载荷勿走本工具」。
- 假设 C（清理）：垃圾条目批量化清理通道。

本特性对准 **假设 A + AC1（物理截断）**。B 是模型层预防（另一关注点），C 是运营清理（AC2，多已人工归档）。

## 2. 根因分析（检测器为何"只提示不阻断"）

系统有两个工具拦截层，循环检测器接错了层：

| 层 | 位置 | 能力 | 循环检测器 |
|----|------|------|-----------|
| `tool_call`（派发**前**） | `model-runtime-registry.ts:115` `pi.on("tool_call")` → `haltToolCallGuard` | **可物理阻断**单次调用（返回 `{block, reason}`，SDK 生成 isError tool result，工具不执行） | **从未接达** |
| `tool_execution_start`（派发**后**） | `circuit-breaker-helpers.ts:266` `circuitBreaker.check()` | 只能 `steer`（建议）或 `session.abort()`（整轮中断） | 检测器在此 |

三个结构性缺陷叠加：

1. **检测点太晚、只能建议**：`ToolCallCircuitBreaker` 挂在 `tool_execution_start`（工具**派发后**）。steer 是纯建议（`circuit-breaker-helpers.ts:278` `session.steer(...)`），工具照常执行——「只提示不阻断」。
2. **terminate 可重试、循环复活**：escalate 到 terminate 走 `doAbort("circuit_break:ignored_steer")`（整轮 `session.abort()`），但 `isRetryableGuardAbort` 对 `circuit_break:` 一律返回 true（`retry-policy.ts:15`）——abort 后整轮重启、循环复活。
3. **steerStrikes 被穿插清零**：`evaluate()` 在任何一次 allow 后 `steerStrikes = 0`（`tool-call-circuit-breaker.ts`）。发作 2 的「首次 speak 停手声明后复又发作」正是靠穿插 speak（allow）重置升级计数，terminate 永远到不了。

结论：唯一能物理阻断单次调用的钩子是 `tool_call`（`{block, reason}`，`haltToolCallGuard` 已在用），但循环检测器从未把它的「检测到循环」裁决接到这条阻断链路上。假设 A「硬熔断该工具」正是补这条缺失的执行臂。

## 3. 机制识别检查点判定（修法决策树前置）

逐项核对（偏严清单），设计为「复用既有 ALS store 生命周期 + 既有 `tool_call {block,reason}` 杠杆 + 既有检测器」：

| 清单项 | 命中？ | 论证 |
|--------|--------|------|
| 新增配置字段/枚举/开关 | ✗ | 复用既有 `maxConsecutiveIdentical` 等阈值，无新配置 |
| 新增状态生命周期（创建→存活→销毁） | ⚠ 偏严视角命中 | `loopBlockedTools` 是 per-turn Map（随 store 生灭）——复用既有 per-invoke store 生命周期，无独立 registry / 无新 endInvoke；但确有创建→存活→销毁 |
| 新增定时任务/后台进程 | ✗ | 无 |
| 新增信号类型/消息格式 | ✗ | 复用既有 `tool_call` 的 `{block, reason}`（haltToolCallGuard 同款） |
| 新增持久化存储（DB/配置/记忆/文件） | ✗ | 纯内存 Map，不落任何持久层 |
| 新增决策分支（结果被记住并影响后续） | ⚠ 偏严视角命中 | 「签名记入 Map → 阻断后续」是 per-turn 内存分支（不写 DB/配置/记忆/文件，属清单 carve-out「纯运行时临时」）；但它确实在后续影响行为 |
| 新增跨模块调用路径 | ⚠ 偏严视角命中 | detector→Map→gate 的数据流；走既有 store→gate 通道 + 既有 attachGuards 链，但 detector 报警→门阻断是新的执行链 |

**判定：偏严视角下「状态生命周期 / 决策分支 / 跨模块路径」三项有命中 → 保守定级 ④ 机制新增（修法决策树④），避免「声明 narrow-fix 但 diff 实增机制」的高严重度。**

理由：本修复新增了检测器此前**没有**的「按工具/签名硬熔断」执行能力（原只有 steer→terminate，无 per-tool block）。虽复用既有 store、既有 `{block}` 杠杆、既有检测器，但「循环→物理阻断单工具」是新行为/新执行机制，诚实定级为 ④。机制预算四问已答（见 §5.5），重对抗门（治本/治标）并入代码审视一轮（同一检视獭同轮追加治本/治标三问）。`Modification-Class: mechanism-addition`。

> 若对抗审视重判为 ① narrow-fix（认为纯属既有机制执行面补全），则 commit 声明改 `narrow-fix`，特性文档 §3 补一句「为何命中清单但不涉净新增机制」——两种判定均已有材料（四问 + 上表论证），不会裸奔。

## 4. 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 阻断落点 | `tool_call` 门（物理阻断，工具不执行） | 仅 steer（现状）/ terminate 整轮 abort | `tool_call` 是唯一能物理阻断单次调用的钩子；steer 是建议、terminate 可重试致循环复活 |
| 阻断粒度 | 按签名（`buildToolSignature`） | 按工具名 / 按整轮 abort | 签名粒度对 create_linked_resource（签名==工具名，常量）== 工具级（精确命中事故）；对 bash 等带参工具是「该命令」级，避免「git commit 循环→全 bash 被封」的过度阻断回归。假设 A「硬熔断该工具」对事故工具即签名==工具名 |
| 触发时机 | 检测器报警（steer/terminate）即记，粘滞不被穿插清零 | 继续走 steerStrikes 升级 | 粘滞 Map 独立于 steerStrikes，堵死「穿插 speak 重置」逃逸（发作 2 根因） |
| 作用域 | per-turn（store 随 execute 生灭） | 永久 / 跨 turn | 对齐假设 A「硬熔断该工具至回合结束」；跨 turn 复发交由假设 B 预防 |
| 逃生口 | `speak` / `yield` 豁免 | 全工具可阻断 | 报告 + 交棒是硬熔断后的唯一逃生通道（F20260806cbsx 教训：不能阻断报告/收尾） |
| 状态载体 | 既有 `OtterInvokeContext` store 上的 per-turn Map | 新 singleton registry（仿 haltRegistry） | 复用既有 store 生命周期与 store→gate 通道，最小新增面（registry 会引入独立生命周期 + endInvoke 管理） |

## 5. 方案设计

### 5.1 数据流

```
execute() ──创建 store{…, loopBlockedTools: Map}──┐
  │                                              │（同一 Map 引用）
  ├─ attachGuards({…, loopBlockedTools})          │
  │    └─ attachCircuitBreaker 订阅 tool_execution_start
  │         circuitBreaker.check() 报警(steer/terminate)
  │           → loopBlockedTools.set(签名, reason)   ← 写
  │                                              │
  └─ session.prompt() → tool_call 门              │
       haltToolCallGuard ?? loopBlockGuard        │
         → buildToolSignature(签名) 查 Map ────────┘ ← 读
         → 命中且非 speak/yield → {block, reason}（工具不执行）
```

### 5.2 改动点

1. **`model-runtime-registry.ts`**
   - `OtterInvokeContext` += `loopBlockedTools: Map<string, string>`（签名→阻断理由）。
   - 新增纯函数 `loopBlockGuard(store, toolName, input)`（镜像 `haltToolCallGuard`）：`speak`/`yield` 豁免；`buildToolSignature(toolName, input)` 命中 Map → `{block, reason}`；否则 undefined（fail-open）。
   - `pi.on("tool_call")` 改为 `haltToolCallGuard(...) ?? loopBlockGuard(...)`。

2. **`circuit-breaker-helpers.ts`**
   - `AttachGuardsParams` / `attachCircuitBreaker` += `loopBlockedTools`。
   - 订阅 handler 中 `circuitBreaker.check()` 返回 `steer`/`terminate`（循环报警）且工具非 speak/yield 时，`loopBlockedTools.set(buildToolSignature(toolName, e.args), reason)`。检测器类本身不动（保持纯检测）。

3. **`pi-session-factory.ts`**
   - 每 execute 新建 `loopBlockedTools: Map`，入 store，并传给 `attachGuards`。

### 5.3 关键性质

- **物理截断**：`tool_call` 返回 `{block, reason}` → 工具不执行（SDK 生成 isError tool result），无垃圾产物。对准 AC1「报警后无法继续调用该工具（物理截断）」。
- **粘滞逃逸堵死**：Map 独立于 `steerStrikes`，一次报警后签名记入，穿插 speak（allow）不会清零——「复又发作」的 relapse 调用被物理阻断（直接修发作 2）。
- **签名一致**：写入用 `buildToolSignature(toolName, e.args)`（tool_execution_start），读取用 `buildToolSignature(toolName, event.input)`（tool_call）。对 create_linked_resource（rawToolSignature 落 `return toolName`，常量签名）二者恒等 == "create_linked_resource"，事故场景稳健。
- **报警边界**：检测在 `tool_execution_start`，故报警那次（如第 6 次）已执行，第 7+ 次被门阻断——对准 AC「报警后无法继续调用」与假设 A「≥6 次时硬熔断」（熔断阈值即 maxConsecutiveIdentical=5 → 第 6 次报警）。

### 5.4 逃生与失效面

- `speak` / `yield` 永不阻断——硬熔断后獭仍能报告 + 交棒（F20260806cbsx：不能阻断报告/收尾）。
- fail-open：store / `loopBlockedTools` 缺失时放行（镜像 haltToolCallGuard）。
- 已知限制（非本特性回归）：①「恰 5 次 + 变化 speak 交替」模式可能同时逃过连续（<6）与滑窗（speak digest 各异）检测——那是**检测灵敏度**问题，非本修复的**执行**缺口（AC1 针对执行）；②模型反复调同一阻断工具只产生 bounded isError 噪声、零副作用，远优于现状产垃圾，且 yield 强制交棒是兜底。

### 5.5 机制预算四问（判 ④ 机制新增，必答）

- ① **谁需要它**：被 create_linked_resource 等工具强迫性循环困住的海獭（封顶獭/闭环分流獭）——检测器报警但模型层自纠失败；搭档 chen——产物流被约 40 条垃圾 fact 污染需人工清理。
- ② **失败后果**：用户可感知——产物流被垃圾条目污染（搭档可见、需人工归档）；反之若误伤（把正常工具当循环拦），獭该回合内无法用该工具（可感知功能受限，但 speak/yield 逃生口保留）。
- ③ **后续机制**：`loopBlockedTools`（per-turn Map）可能出错：(a) 误判正常重复为循环 → 缓解：沿用既有 maxConsecutiveIdentical=5 阈值（本就判 6 连发为病理）、签名粒度避免全工具误伤、speak/yield 豁免；(b) 签名写读不一致致漏拦 → 缓解：常量签名工具（create_linked_resource）恒等，且漏拦是 fail-open（不劣于现状）；(c) 跨 turn 复发 → 由假设 B 预防。
- ④ **退役条件**：若模型层自我纠错可靠（报警后自纠率达标、循环不再复发），或 SDK `tool_call` 门原生支持循环硬熔断，本粘滞 Map 可退役回落纯检测。

## 6. 验证

- **集成用例（直攻主场景，非单测传 id）**：`attachCircuitBreaker` 派发 `tool_execution_start` ×N 命中 create_linked_resource 循环 → 断言 `loopBlockedTools` 记入该签名 → `loopBlockGuard` 对后续 create_linked_resource 返回 `{block}`（工具不执行）→ speak/yield 仍放行。
- **负向验证（证非恒真，非空断言）**：注掉 `attachCircuitBreaker` 的 mark 写入 → 上述集成用例失败；恢复 → 通过。
- **单元用例**：`loopBlockGuard` 命中阻断 / speak、yield 豁免 / store 缺失 fail-open。
- **回归**：既有 `tool-call-circuit-breaker` / `circuit-breaker-helpers` / `halt-injection-wiring` 用例不回归。
- AC2（残留垃圾条目清理）：事故台账已由大獭批量归档（见记忆 2026-10-19），剩 3 条已消费 fact 无害暂留；本 PR 聚焦 AC1 代码修复。
