---
id: F20260804dglp
title: degenerate-loop-silence-fix
doc_type: feature

summary: |
  修复"大獭发言几十分钟无事件、只能人工中断"的缺陷。根因不是 LLM 慢，而是模型陷入退化重复（实测 8 条退化 entry，最大单条 552KB = 同一句话 ×6344）时系统零拦截零可见：OutputGuard 因字段访问 bug 从未生效（读 event.delta，实际在 event.assistantMessageEvent.delta），且退化文本被写回 session 历史形成污染飞轮。修复：矫正 delta 取值 + 首字节超时（冻结语义 pause、避让 compaction）+ 非对齐滑窗/distinct-ratio 双机制重复检测 + invoke 后清洗 session 文件斩断飞轮。

causal_links:
  from:
    - F20260727guard   # degenerate-output-guard：delta 字段 bug + resumeTimer 数学错误使其从未生效
    - F20260728cbwt    # circuit-breaker-event-driven：per-event 超时只覆盖工具执行，生成静默无兜底
  to: []

status: implemented
change_type: fix
tags: [agent, output-guard, degenerate-output, session-persistence, streaming, pi-sdk]
modules:
  - src/frameworks/agent/output-guard.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/degenerate-detector.ts
  - src/frameworks/agent/session-sanitizer.ts
---

# F20260804dglp: 退化输出死循环零拦截修复

## 背景

用户观测：大獭一次发言几十分钟，前端只收到十几二十个流式事件，感觉卡死。2026-08-04 当天共 7 次手动中断（日志 7 条 `Invocation aborted by user`：大獭 fdad20e2 有 3 条 dc2f9481/4796f4b7/cd4e9b0d，小獭 4 条）。

用户明确提出两个产品判断，作为本修复的约束：

1. **UI 只展示块级事件是有意设计**（追求用户看到的内容有意义），不改为 token 级流式；
2. **不允许用压低 max_tokens 上限的方式兜底**（因噎废食）。

## 根因分析（数据实锤）

### 现象重建（message_events 逐事件时间线）

以被中断的消息 `dc2f9481`（大獭，2026-08-04）为例：

```
07:49:17 ~ 07:50:09  正常节奏：6 次工具调用，间隔 6~17s
07:50:09 → 08:00:26  第一次静默 10 分钟（零事件，期间产出 190KB 退化块）
08:00:26 ~ 08:05:24  恢复调用但每次调用前都先落一条退化 entry，间隔渐长（153s/76s/32s/30s/7s）
08:05:24 → 08:30:20  第二次静默 25 分钟（零事件）
08:30:20.092         用户中断的瞬间，一条 552KB 的 assistant_text 一次性落盘
```

### 根因 1：模型退化重复，一个 text/thinking block 永不结束

大獭 session 文件（`data/sessions/2026-08-03T08-46-43-679Z_*.jsonl`，实测 1.88MB）中全量扫描到 **8 条**退化 entry（ratio = 100 字符非重叠 segment 的 distinct/total）：

| entry 前 8 位 | 时间(UTC) | 大小 | 落盘路径 | 模式 | ratio |
|---|---|---|---|---|---|
| b1714ddd | 08:00:26 | 190 KB | 正常完成（toolUse） | 精确重复 ×2709 | 0.006 |
| 833a7175 | 08:02:59 | 43 KB | 正常完成（toolUse） | 精确重复 ×606 | 0.169 |
| f71c0107 | 08:04:15 | 25 KB | 正常完成（toolUse） | 精确重复 ~×180（结尾模型自述 "OK I'm clearly in a loop"） | 0.534 |
| be2c597d | 08:04:47 | 9.7 KB | 正常完成（toolUse） | 精确重复，周期 67（结尾 "OK this is clearly a loop issue"） | 0.767 |
| 44996c93 | 08:05:17 | 9.5 KB | 正常完成（toolUse） | 精确重复 | 0.298（贴线） |
| f676b3b0 | 08:30:20 | 552 KB | abort 部分落盘 | 精确重复 ×6344 | 0.016 |
| 4e8c3ff3 | 08:44:23 | 153 KB | abort 部分落盘 | **近似重复（纯 thinking）** | 0.198 |
| be0c0d85 | 09:21:25 | 401 KB | abort 部分落盘 | 精确重复（当前叶节点） | 0.006 |

模型陷入重复后该 block 永远写不完 → 没有 `message_end` → 块级事件设计下前端零可见 → 用户感知为"卡死"。552KB ≈ 13 万 output token。中断瞬间文本"涌出"是 SDK 在 abort 时把部分消息走 `message_end` 落盘所致（agent-session.js:355-366）。

**两个关键观察**：

1. **4e8c3ff3 是近似重复**：1533 个 segment 有 303 个 distinct（换措辞），精确匹配算法抓不到。它是活跃 compaction `f8a540c6` 的 `firstKeptEntryId`，必进每次调用上下文；且 abort 产生的 thinking 无 signature，按 anthropic-messages.js:898-908 转成纯文本发给 API——153KB 实打实占上下文。重建当前活体上下文：26 个 entry ~639KB，4e8c3ff3 + be0c0d85 两条占 87%。
2. **f71c0107/be2c597d 暴露了定长分段的结构性盲区**：实测重复单元周期可小至 **67**（素数）。周期 L 与分段长度互素时，非重叠分段的 distinct 上限 ≈ L → 短退化块 ratio 停在 0.5-0.8，任何固定尺（含双尺组合）都不存在普适覆盖。检测器必须用相位免疫的非对齐匹配（见修复 1 机制 A）。

### 根因 2：OutputGuard 是死代码（字段访问 bug）

SDK 事件结构（`pi-coding-agent/dist/core/extensions/types.d.ts:557-561`，运行时由 pi-agent-core agent-loop.js:221-225 发出）：

```ts
{ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: string, ... } }
```

otter 用的 `session.subscribe` 收到的是 agent-core 原始事件（agent-session.js:353 `_emit` 直接转发同一对象），顶层只有 `type/assistantMessageEvent/message`，无 `delta`。而 `output-guard.ts:202` 读外层 `event.delta` → 恒为 `undefined` → `check()` 从未执行（全仓库仅此一处调用，bug 自 OutputGuard 引入 commit 7302345 起存在）。后果：

- 退化重复检测从未运行（设计上就该早期触发 abort，实际烧到 552KB）；
- 120s 流式超时计时器从未 armed（`resetStreamingTimer` 只在 `check()` 内调用）。

即该系统为这种病准备的护栏从上线起就没工作过。

### 根因 2b：存量潜伏 bug——resumeTimer 的 pause 数学错误

`output-guard.ts:117-128` 的 `resumeTimer` 用 `elapsed = Date.now() - timerStartedAt` 计算剩余时间，**pause 期间时长被计入 elapsed**。任何超过 120s 的 pause（工具执行允许 600s、compaction 分钟级）结束后 remaining 被钳到 1s → 恢复后 1s 无 delta 必误杀。

今天没炸是因为根因 2 让计时器从未 armed；**修复字段 bug 后这个潜伏 bug 立刻活化**，长工具/compaction 后必误杀——恰好屠杀本修复最想保护的临界上下文 otter。必须随本次一并修复（pause 改冻结语义，见修复 2）。

### 根因 3：污染飞轮（高复发率的放大器）

退化文本写回 session 历史有**两条路径**：

1. **abort 部分落盘**（f676b3b0/4e8c3ff3/be0c0d85）：abort 时 SDK 把已生成的部分内容走 message_end 持久化；
2. **正常完成落盘**（b1714ddd/833a7175/f71c0107/be2c597d/44996c93）：模型重复完 preamble 后恢复并发起工具调用，stopReason=toolUse，退化文本随正常 message_end 落盘。

后续每次 invoke 全量携带这些自我重复内容，模型模仿历史，复发概率抬高。飞轮是**放大器而非唯一病因**：message_events 中存在更早的自发退化（07-27 aa9657f0 419KB、07-29 006cca3c 635KB，不同 otter 不同 session），mimo 确实会自发犯病。清洗降低复发率，但不能声称"清洗后不再复发"——运行时拦截（修复 1/2）才是兜底。

### 加重项：两道超时都管不到生成静默 + 健康零 delta 窗口盘点

- 熔断器 per-event 超时（`circuit-breaker-helpers.ts:23`）明确"只计工具执行时间"，`tool_execution_end` 即 clear；
- OutputGuard 流式超时见根因 2，从未 armed；
- 即使修好字段 bug，计时器也只在**收到第一个 delta 后**才启动——首字节前（排队 + prefill，大獭上下文已 374k token）的挂死无覆盖；
- **健康但零 delta 的窗口**（计时器必须避让，否则误杀）：
  - pre-prompt / post-turn auto-compaction（agent-session.js:776/860-863）：SDK 内部 LLM 摘要调用，分钟级零 delta；事件对 compaction_start/end 已验证配对完整（取消/abort/成功/异常四路径均有 end）；
  - auto-retry 退避（agent-session.js:2120-2165 `_prepareRetry`）：retryable error 后指数退避 sleep，默认 maxRetries=3、baseDelayMs=2000，累计最长 ~14s——目前小于 120s 是侥幸成立，配置调大即破，需订阅 auto_retry_start/end 一并 pause；
  - provider 层 HTTP 重试默认 maxRetries=0（anthropic-messages.js:368），默认配置下不构成窗口，已验证无需处理。

### 为什么 Claude Code 直连 mimo 无此问题

非参数差异（pi-ai 请求构造核查：`stream: true` 正常、温度走默认、无错误参数）。差别在：Claude Code 真流式 UI 下重复第 5 秒即被人看见并打断，且打断残渣不会完整留在长期上下文反复放大（有 compaction）。otter-buddy 三条全反：块级事件看不到过程 + guard 失效 + 残渣写回历史。

## 修复方案

### 修复 1：OutputGuard delta 取值矫正 + 双机制重复检测（output-guard.ts + 新增 degenerate-detector.ts）

**取值矫正**：`attachOutputGuard` 订阅处改读嵌套结构，text/thinking/toolcall 三类 delta 都作为活跃信号：

```ts
case "message_update": {
  const ame = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
  if (ame?.delta) guard.onDelta(ame.delta, ame.type, onAbort);
  break;
}
```

**块边界**：`text_start`/`thinking_start` 事件到达时重置检测器累积（跨块不清零会稀释延迟检出；不清零不产生假阳性，但触发点进一步推迟）。

**检测分工**（避免误伤）：

- text_delta / thinking_delta：作活跃信号 + 进重复检测（thinking 也会退化，4e8c3ff3 即纯 thinking 退化）；
- toolcall_delta：**只作活跃信号，不进重复检测**——合法大文件写入（夹具、迁移脚本）可能含大量相似窗口，会误触发。

**检测器（关键）**：抽共享模块 `degenerate-detector.ts`，运行时 guard 与离线清洗共用同一实现。**双机制**：

**机制 A——非对齐精确重复检测（任意周期、相位免疫）**：
- 对累积文本做 stride-1 的 100 字符滑窗，滚动哈希（djb2，与 tool-call-circuit-breaker 的 contentDigest 同源）按窗口计数；
- **任一窗口的出现次数 ≥ maxWindowRepeats（初始 50）** 即判退化；
- 原理：周期 L 的失控循环中，同一窗口每 L 字符重现一次，块长 N 时单窗口计数 ≈ N/L，与分段相位无关——L=67、L∈[70,200]、任意 L 全覆盖（定长分段方案的盲区对机制 A 不存在）；
- 判据取"单窗口计数"而非"累计重复位置数"（实施期修正，见审视记录第四轮）：良性"整段复述两遍"单窗口计数=2、ASCII 表格框线计数≈边框行数，均远低于 50，不误伤；
- 触发点：块长 ≥ 100 + 50×L 时触发——L=67 约 3.5KB、L=87 约 4.5KB，精确重复秒级拦截；
- 内存控制：Map 只存数字哈希计数，容量随块长线性（KB 级），有上限截断。

**机制 B——distinct-ratio（近似重复专用）**：
- 100 字符非重叠分段，块 ≥ 最小阈值（初始 5KB）且 distinct/total ≤ 0.3 即判退化；
- 专抓换措辞的近似重复（4e8c3ff3 ratio 0.198，触发累积 ~100KB）；
- 阴性安全距离实测：110 个 ≥5KB 合法块全量扫描，最低 ratio 0.838，无假阳性；中文信息密度高，distinct 更接近 1.0，只会更安全。

**8 条真实 entry 的覆盖映射**：全部 8 条实测均由机制 A 抓获（含周期 67 的 be2c597d；4e8c3ff3 虽整体是近似重复，但其内部仍含逐字相同的长跨度窗口，单窗口计数 ≥50 命中）。机制 B 作为近似重复的兜底保留。离线清洗器同机制、参数放宽（无运行时误杀代价）。

**如实写明触发点**：精确重复在块长 100+50×L 处触发（机制 A，秒级）；纯近似重复（不含逐字相同窗口）由机制 B 在 ~100KB 累积触发（增量场景存在重复前导期）。能兜住 552KB 级失控。常数最终用真实夹具调定（见验证 3）。

### 修复 2：超时体系重构（pi-session-factory.ts + output-guard.ts）

**pause 一律改冻结语义（修存量 bug）**：pause 时记 pausedAt，resume 时 `timerStartedAt += pauseDuration`（或等价地保存剩余时间重建）。存量 `resumeTimer` 的 elapsed 算法一并修掉，纳入本次修复范围。

**pause 状态机改 ref-count（原因集合）**：首字节/滑动两类计时器 × 工具/compaction/auto-retry 三类 pause 源存在叠加组合（如 compaction pause 期间到达 tool_execution_end），单一 boolean 有交叉 resume 风险，用原因集合计数，清空才 resume。

**计时器体系**：

- `armFirstByteTimer(abort)` 在 `_executeWithSession` 调 `session.prompt()` **之前** arm，覆盖排队 + prefill；收到第一个 delta（任意类型）后切换为 per-delta 滑动超时。`session.prompt()` 一次调用涵盖整个 agent loop（含内部 compaction/retry 续跑），arm 一次管全程；
- **compaction_end / auto_retry_end 后都 re-arm 首字节窗口**：两者后续跑的都是冷请求全量 prefill（retry 退避续跑对 374k 上下文重新 prefill，与首字节 300s 的设定物理原因相同），沿用滑动剩余会误杀；
- `firstByteTimeoutMs` 初始值 300s（**定为初始值而非结论**；补 time-to-first-delta 埋点日志，后续按观测调）；per-delta `streamingTimeoutMs` 维持 120s；均走 `appConfig.circuitBreaker` 配置树；
- `OutputGuardMetadata.reason` union 扩 `first_byte_timeout`；agent-invoker 的 `[output-guard]` 归因前缀对新 reason 天然正确，无需改 invoker。

**健康窗口避让**：

- 订阅 `compaction_start`/`compaction_end`、`auto_retry_start`/`auto_retry_end` 作 pause/resume（ref-count 计入原因集合）；
- **SDK 事件改名/不发的兜底**：超时 fire 前查一次 `session.isCompacting()`（agent-session.js:647 已暴露），true 则不 fire 并重新 arm——廉价防御；
- 边界规则：tool_execution_start 的 pause 优先于首字节计时器（首个 delta 前就执行工具时按工具执行处理）。

### 修复 3：session 文件清洗，斩断飞轮（新增 session-sanitizer.ts）

`_executeWithSession` 的 finally 里 `session.dispose()` 之后（dispose 已验证无任何文件写，agent-session.js:556-571），对 session jsonl 做幂等清洗：

- **扫描范围**：当前活跃分支路径（从叶节点沿 parentId 回溯，同 buildSessionPath 语义，session-manager.js:124-145）上的全部 assistant entry——不是物理尾部（关键污染 entry 4e8c3ff3 距文件尾 25 行）。非活跃分支不进上下文（buildContextEntries 只走叶路径，已验证），不洗；
- 对 text/thinking 块跑修复 1 的共享检测器（离线参数放宽）；
- 命中则**原位替换**为占位符（如 `[输出异常重复，已截断。原始长度 552KB]`），entry id/parentId 不动，append-only 树结构与 compaction 的 firstKeptEntryId 引用不受破坏（已核实 SessionManager 稳态写入是 appendFileSync 按路径追加、open() 全量重解析，无缓存 fd/offset）；
- **thinkingSignature 规则**：命中的 thinking 块若带 `thinkingSignature`，连同 signature 字段一起清除——只换内容留 signature 会导致真 Anthropic 端点签名校验 400，该 otter 此后每次 invoke 必挂（当前 mimo 数据全部无 signature，但规则必须防未来 provider 变更）；
- 写盘策略：**临时文件 + 原子 rename + .bak 备份（同名覆盖，只留最近一份，避免每 invoke 积一份多 MB 备份）**；
- 无论成功/abort/异常路径都执行。

选择 post-invoke 文件清洗而非 SDK 扩展钩子（`message_end` 的 `MessageEndEventResult.message` 替换机制，agent-session.js:468-485 已验证在持久化前生效）的原因：扩展装载走 ResourceLoader 发现 + trust 语义，存在静默不装载的风险——正是本次要修的那类故障模式；文件清洗完全在 otter 控制面内，可单测、确定性执行。SDK 钩子作为已知备选记录在案。

### 修复 4：存量污染清理（离线一次性）

已确认污染范围（全量扫描，非"顺带"）：

- 大獭 fdad20e2：8 条退化 entry（见根因 1 表）；
- 小獭 e830723a：500KB/588KB 退化 entry；0da52f67：364KB/112KB 退化 entry；
- 更早 otter（07-27 aa9657f0、07-29 006cca3c）如在役也纳入。

**运行前提（防竞态）**：SDK 稳态写入是 appendFileSync 追加，清洗器是全量读-改-写——若在服务运行且有进行中 invoke 时执行，回写会丢掉交错期间新追加的 entry，导致 parentId 悬空、session 树断裂。因此：

- 必须在**停服**（或至少目标 otter 无活跃 invoke，复用 per-otter 锁）下执行；
- 临时文件 + 原子 rename + .bak 备份；
- 用修复 3 的同一清洗器实现，做成可独立运行的脚本。

### DB 侧副本的处置结论（无需清洗）

messages/messages_fts 无退化文本（dc2f9481 的 body 仅 32 字节）；message_events 现存 8 条 >50KB 退化 payload（最大 635KB），只用于前端回放、**不回 LLM 上下文**，不做处理。当前活跃 compaction 摘要（f8a540c6，10.9KB）实测无重复片段，摘要污染不构成残余向量。

### 明确不做

- 不改 UI 事件粒度（块级事件是用户确认的产品设计）；
- 不设 max_tokens 上限（用户明确否决）；
- 不动熔断器 per-event 超时的职责边界（工具执行 vs 生成静默的分工维持现状，生成静默由修复 1/2 覆盖）；
- 不排查 mimo 模型侧参数调优（repetition_penalty 等）——自愈机制先行，模型调优作为后续独立议题。

## 验证

1. **guard 单测**：构造嵌套 `message_update` 事件（text_delta/thinking_delta/toolcall_delta），断言 delta 被累积、退化触发 abort、120s 无 delta 触发 streaming_timeout、toolcall_delta 只重置计时器不进重复检测、text_start/thinking_start 重置块边界；
2. **避让与计时语义用例**：compaction_start（或 auto_retry_start）后计时器 pause、end 后 resume，期间超时**不** fired；ref-count 叠加组合（compaction pause 期间 tool_execution_end）不交叉 resume；**pause 冻结语义：工具/compaction 时长 > streamingTimeoutMs 后 resume 不误触发**（存量 resumeTimer bug 回归测试）；compaction_end 与 auto_retry_end 后均 re-arm 首字节窗口；isCompacting() 兜底用例（收不到事件时 fire 前查询阻止误杀）；
3. **检测器夹具**：8 条真实退化 entry 全量做阳性夹具——7 条精确重复断言**机制 A 命中**（重点：周期 67 的 be2c597d、贴线的 44996c93），4e8c3ff3 断言**机制 B 命中**；用项目内大型合法文件（大 write content、代码、表格）做阴性夹具；调定 K/min/ratio 常数；
4. **清洗器单测**：含退化的 jsonl 样本，断言原位替换且 entry 树结构（id/parentId 链、compaction firstKeptEntryId 引用）不变；带 thinkingSignature 的块连 signature 一起清除；
5. **离线流程演练**：停服 → 跑存量清洗脚本 → 校验 .bak 与树完整性 → 起服后大獭下次 invoke 上下文不含重复段（上下文体积从 ~639KB 降到正常量级）；
6. **回归**：健康对话（工具调用正常节奏、含 compaction 触发）不触发任何 guard/清洗。

## 对抗审视记录

### 第一轮（2026-08-04，独立 agent 对抗审视）：2 致命 + 3 严重 + 6 建议，全部采纳

- 【致命 F1】近似重复盲区：检测器从精确匹配升级为 distinct-ratio（否则活体上下文里最关键的 4e8c3ff3 抓不到）；
- 【致命 F2】计时器与 SDK 内部 compaction 相撞：增加 compaction_start/end 暂停机制（否则误杀临界上下文的健康调用）；
- 【严重 S1】根因数据修正：3 条→6 条退化 entry、4 次→7 次中断、规模递增叙事删除、1.4MB→1.88MB、补充正常 toolUse 落盘路径；
- 【严重 S2】弱化因果叙事：存在更早的自发退化（07-27/07-29），飞轮是放大器不是唯一病因；
- 【严重 S3】修复 4 补运行前提：停服/持锁、原子 rename、全量扫描升级为必做；
- 【建议】toolcall_delta 只作活跃信号、300s 定为初始值+埋点、扫描范围定义为活跃分支路径、DB 副本处置结论、frontmatter modules 修正、验证补 4 用例。

### 第二轮（2026-08-04，独立架构 agent 全新审视）：1 致命 + 3 严重 + 6 建议，全部采纳

- 【致命 F1】pause/resume 计时数学错误：存量 resumeTimer 把 pause 时长计入 elapsed，字段修复落地即活化成长工具/compaction 后的确定性误杀 → pause 全部改冻结语义，存量 bug 纳入修复范围，补回归用例（新增根因 2b）；
- 【严重 S1】distinct-ratio 结构性盲区：定长非重叠分段对互素周期失效（自家根因表的 f71c0107/be2c597d 就抓不到）→ 改双尺方案（后被第三轮证伪，见下）；退化 entry 计数 6→8；
- 【严重 S2】thinkingSignature 清洗规则缺失 → 命中带 signature 的 thinking 块连 signature 一起清除（防签名校验 400 硬故障）；
- 【严重 S3】健康零 delta 窗口盘点不全 → auto_retry_start/end 纳入 pause；fire 前查 isCompacting() 做 SDK 事件改名兜底；
- 【建议】compaction_end 后 re-arm 首字节窗口、pause 状态机改 ref-count、text_start/thinking_start 块边界重置、reason union 扩 first_byte_timeout、验证 2 文案笔误修正、.bak 同名覆盖。

### 第三轮（2026-08-04，轻量收尾复核）：2 严重 + 2 建议，全部采纳

- 【严重 S1】双尺（100/137）方案被自家夹具实测证伪：周期 L 与尺互素时 ratio 随尺单调上升，137 素数与几乎所有 L 互素、对盲区零贡献；be2c597d 实测周期 67（素数），不存在普适固定尺组合 → 检测器改为**机制 A（stride-1 滑窗滚动哈希、非对齐匹配、任意周期相位免疫）+ 机制 B（distinct-ratio 抓近似重复）**双机制；精确重复触发点回到 ~5KB 秒级；
- 【严重 S2】auto_retry_end 后未 re-arm 首字节窗口，与 compaction_end 处理不对称（retry 续跑同样是冷请求全量 prefill）→ 补 re-arm 规则与验证用例；
- 【建议】现象重建首行修正（静默后调用间隔 153s/76s/32s，不能整段标"正常节奏"）；周期区间表述对齐实测（含 67）。

### 第四轮（2026-08-04，实施期验证修正）：机制 A 判据收紧

实现完成后用全部 29 个真实 session 文件（64 个 ≥5KB assistant 块）做全量验证，发现初版机制 A（累计重复位置数 ≥50）误伤面过大（58/64 检出）：良性"整段复述两遍"（单窗口计数=2，但重复位置数≈块长一半）和 ASCII 表格框线（同构边框行）都会累计到 50 次命中。判据收紧为**单窗口出现次数 ≥50** 后：检出降到 24/64，人工逐条核对 24 条全部为真退化（最小 9KB 周期 67），良性复述与表格全部正确逃逸；8 条根因 entry 保持全检出。配置字段相应命名 maxWindowRepeats。

## 实施验证结果（2026-08-04）

- `npx tsc --noEmit` 通过；`npx vitest run` 全量 958 通过（含新增 detector 11 + guard 22 + sanitizer 8）；
- 阳性：8 条真实退化 entry 全检出（机制 A），含周期 67 盲区条目与 153KB 近似重复 thinking；
- 阴性：全部 session 文件 64 个 ≥5KB 块扫描，良性块（复述两遍/ASCII 表格/正常分析）零误伤；
- 离线脚本 `scripts/sanitize-sessions.mjs` dry-run：6 个文件 24 块命中，与人工核对一致；
- 存量清洗（--apply）需在主仓停服后执行，本 PR 不含该操作。
