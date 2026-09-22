---
id: F20260922txre
title: 文本工具返回值历史层收缩：发送层投影（对齐 image-externalizer）
summary: 实现 #1093——文本 toolResult 进入 session 历史后无收缩机制，每轮 LLM request 全量重发，长任务下是上下文第一大头（现场实测单条 8.9K/12.9K/16.8K 字符）。对齐 F20260915iext 的发送层投影语义：当前 turn 的 toolResult 原样保留，上一 turn 及更早、超过 1000 字符的文本块投影为「开头 400 字符 + 收缩标记」；存储不动（session jsonl 原文保留，回读按 toolCallId 检索），只投影发给 LLM 的消息数组。纯函数无状态，同一挂点管道（pi.on("context")）扩展。
change_type: fix
capability_test: "n/a: 纯运行时投影逻辑（非 prompt/skill/协议层软代码），单测锁定全部行为契约（历史收缩/当轮保留/小结果不动/幂等/混合块/边界保守/zero-copy）"
created_in_conversation: b96c3215-f614-4417-93f9-c81c74c86e94
created_at: 2026-09-22
intent:
  problem: "文本 toolResult 进入 session 历史后以全文形态永久驻留到 compaction，每轮 LLM request 全量重发，长任务上下文被 toolResult 堆积撑爆（issue #1093 现场：3 轮对话 toolResult 已占 request 绝大部分体积）"
  expected_effect: "上一 turn 及更早、>1000 字符的 toolResult 文本块在发给 LLM 的消息数组中被投影为「开头 400 字符 + 收缩标记（含原字符数与回读路径）」；当前 turn 原样保留，session jsonl 存储不变；历史 toolResult 不再随轮数线性堆积"
  verify_by:
    type: behavior_check
tags: [ctx-quality, agent, context-projection, tool-result, tech-debt]
modules:
  - src/frameworks/agent/toolresult-externalizer.ts
  - src/frameworks/agent/image-externalizer.ts
  - src/frameworks/agent/model-runtime-registry.ts
  - tests/frameworks/agent/toolresult-externalizer.test.ts
---

# 文本工具返回值历史层收缩（#1093）

## 背景

2026-09-22 上下文注入面排查（对话 b96c3215，session 01a0c695 实测）识别的膨胀源：文本 toolResult 进入 session 历史后**每轮 LLM request 全量重发**，长任务下是上下文第一大头（远超用户消息包装的 ~0.9K 字符/条；单条工具返回值实测 8.9K / 12.9K / 16.8K 字符，仅 3 轮对话 toolResult 已占 request 绝大部分体积）。

历史脉络（三个先例/近亲）：

| 机制 | 状态 | 与本特性的关系 |
|---|---|---|
| F20260807tprt 单条 15K 截断 | ✅ 已有 | 管「单条」上限；不管历史层数量堆积 |
| F20260915iext 历史图片外置 | ✅ 已有 | **本特性对齐的先例**：发送层投影、存储不动、当轮保留 |
| #776 bash 输出堆积（已闭） | ✅ 已解 | 同根因族；bash toolResult 与文本 toolResult 同管道，本特性一并覆盖其历史层残留 |

文本 toolResult 的历史层收缩至今没有做——本特性补上这块。issue #1093 正文为方案蓝本，本文档记录实施与取舍。

## 设计取舍

### 机制识别检查点（issue 驱动未经 RA，动手前判定）

逐项打勾（清单见 troubleshooting skill 修法排序节）：

- ☐ 新增配置字段/枚举/开关 —— **未命中**：阈值为模块常量（PROJECT_MIN_CHARS / KEEP_HEAD_CHARS），不进 config
- ☐ 新增状态生命周期 —— **未命中**：纯函数无状态，无创建/存活/销毁
- ☐ 新增定时任务/后台进程 —— **未命中**
- ☐ 新增信号类型/消息格式 —— **边界项，判定未命中**：收缩标记是 F20260915iext 投影占位符（`[图片已外置 | …]`）既有语义在文本类型上的同类延伸，同一挂点、同一管道、同为「消息内容内的投影标记」，非新信号类型/新消息格式。留此论证供对抗审视核验：若检视认定属「新增消息格式」，则本条命中、走「命中清单但不涉净新增机制」通道——占位符不携带新协议语义、无消费方解析依赖（LLM 只读，无代码解析它），确证非净新增机制
- ☐ 新增持久化存储 —— **未命中**：不落新文件——session jsonl 本来就以原文持久化 toolResult（F20260915iext「存储不动」语义），二次落盘=纯复制 + 一致性负担
- ☐ 新增决策分支（结果被记住影响后续行为） —— **未命中**：投影是每请求实时确定性计算，不写回、不被记住
- ☐ 新增跨模块调用路径 —— **未命中**：复用 pi.on("context") 既有钩子管道（stripHistoricalThinking → externalizeHistoricalImages 链上追加一环），无新调用方/新挂点

**结论**：判定不含净新增机制 → 修法排序默认 ①②③，本特性取 **①（在既有机制语义内修：缺啥补啥）**，Modification-Class: `narrow-fix`。

### 修法排序：为什么是①，不是②③④

- **①（选定）**：F20260915iext 建立了「发送层投影 + 存储不动 + 当轮保留 + 历史投影」的完整机制语义，缺的只是文本类型的覆盖——把 image 块的投影扩展到 text 块，是既有机制内的缺项补齐
- **② 收窄管辖**：没有一个「过宽的机制」可收窄——问题恰是投影机制覆盖面不足，方向相反
- **③ 删除机制**：toolResult 全文驻留是「无机制」而非「有机制」，无可删对象
- **④ 新增机制（issue 蓝本的「完整原文落盘」部分被否）**：issue 建议把原文写到 session 同目录/workspace 的外置文件。核对存储真相后否决——session jsonl（`data/sessions/<ts>_<id>.jsonl`，pi-session-factory.ts:998 `sessionDir`）已原文持久化每个 toolResult，外置文件是对已有存储的复制，新增「文件生命周期 + 一致性 + 清理」一套机制只为省一次 grep。按机制预算精神（R20260828pntr：要一个函数别给一个框架），回读走「grep session jsonl（按本条 toolCallId）或重新执行原工具」，零新机制达成同等效果

### 参数取舍

| 参数 | 值 | 理由 |
|---|---|---|
| PROJECT_MIN_CHARS（投影门槛） | 1000 | ≤1K 的结果（短确认、小列表）信息密度高、体积无害，投影反而丢信息加标记；膨胀主力是 8.9K-16.8K 级别的大结果 |
| KEEP_HEAD_CHARS（保留头部） | 400 | 头部 400 字符≈前 3-6 行/首 2-4 句，足够唤起「这条当时是什么」；对标 image 占位符摘录 150 字（文本结果无「所见」可摘，头部即内容本身，故放宽） |
| 收缩标记 | ~90 字符 | 含原字符数 + 回读路径提示；投影后总长 ≤~500 < 门槛 1000，天然幂等 |

**Age 语义（与 F20260915iext 完全对齐）**：turn 边界 = 最后一条非 assistant/toolResult 消息（user/compactionSummary 等）；边界之后（当前 turn，含 invoke 内多步工具链）原样保留——模型在链中还要回看刚拿到的结果；跨 turn 后价值衰减才投影。不做 K 轮延迟（issue 里「如 K 轮前」是建议值）：K=1 与图片先例一致，且缩得越晚省得越少。

**稳定性（前缀缓存友好）**：投影结果确定性（同输入同输出）；一条结果只在「跨 turn 那一刻」变更一次，之后长期稳定——与 image 投影同款的一次性抖动，不逐轮改写历史。

### 回读设计（占位符里的「怎么拿回全文」）

收缩标记提示两条回读路径：
1. **grep session jsonl**：完整原文在 session 历史 jsonl（存储不动），按本条 toolCallId 检索——LLM 在 API 结构里可见 tool_use_id，可直接喂给 grep 工具
2. **重新执行原工具**：read/grep 等检索类结果天然可重放（重新 read 同一文件/重跑同一查询）

被否的备选：ALS 注入精确 sessionFile 路径进占位符（省一次 ls/grep 定位）——需要扩展 OtterInvokeContext + 装配链透传（~10 行跨 2 文件 plumbing），对「回读」这一低频路径过重；toolCallId 检索已可达，按最简原则不取。若实测回读频发再补。

### 负面向条目（本次变更破坏了什么旧契约 / 绕过了什么既有保护）

- **破坏的旧契约**：LLM 对「历史 toolResult 全文可见」的隐式契约被收缩——跨 turn 后只能看到开头 400 字符。这是本变更的目的本身（全文价值不足以抵每轮重发的成本），恢复路径即上节回读设计；对「旧结果里藏的细节后来又要用」的场景，代价是一次 grep/重跑
- **绕过的既有保护**：无——F20260807tprt 的 15K 单条截断仍在（投影发生在其下游历史层）、isError 透传不动、halt/tool_call 守卫不动、退化检测不动；session jsonl/UI 回放/审计/compaction 摘要均消费原文（存储不动）

### 非目标

- assistant 文本/用户消息的历史收缩（体量远小于 toolResult；用户消息已由 #1094 delta 化）
- 分级处理/笔记化收缩（issue 方案第 2 条「可选进阶」）——本期不做，等基线数据说话
- 生长曲线的线上长期观测（issue 验收第 1 条的 ≥30 轮前瞻对比）——本期以真实 session 回放测量代替（见验证节），线上观测另行排期

## 实施要点

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/toolresult-externalizer.ts | 新增 | `externalizeHistoricalToolResults(msgs)` 纯函数：历史区（idx < turn 边界）toolResult 的 text 块 >1000 字符 → 头 400 字符 + `…` + 收缩标记；其余原样 |
| src/frameworks/agent/image-externalizer.ts | 修改 | 导出 `findTurnBoundary`（原模块私有，零行为改动）供文本投影复用同一边界语义 |
| src/frameworks/agent/model-runtime-registry.ts | 修改 | context 钩子链追加一环：`externalizeHistoricalToolResults(externalizeHistoricalImages(stripHistoricalThinking(msgs)))`（+1 import，+1 行调用） |
| tests/frameworks/agent/toolresult-externalizer.test.ts | 新增 | 行为契约单测 |

收缩标记模板（稳定不变，幂等与缓存稳定性依赖它）：

```
{头 400 字符}…

[工具返回值已投影：原 {N} 字符。历史层收缩仅保留开头；完整原文在 session 历史 jsonl，可按本条 toolCallId 检索回读，或重新执行原工具获取]
```

幂等性：投影产物（≤~500 字符）< 门槛 1000，重复投影天然跳过；zero-copy 快路径（无变化返回原数组，与 image-externalizer 同款）。

## 验证

- 单测（tests/frameworks/agent/toolresult-externalizer.test.ts，11 用例）：历史大结果收缩（头+标记+原字符数）/ 当轮保留 / invoke 内工具链保留 / 历史小结果不动（zero-copy）/ 幂等 / 混合块只动 text / 无边界保守保留 / isError 元数据保留 / 多块独立收缩 / assistant 大文本不动 / 真实结构字段不破坏；全量回归 3690/3690 绿（270 文件）
- **失败证据（bugfix 硬规则，修复前 vs 修复后对照）**：新增机制无「修复前失败单测」可言，按 5a 走「最小复现/诊断脚本」固化——回放脚本（见附录）对真实 session jsonl 逐 turn 重算发送面 toolResult 文本体积，before 列即修复前基线（无投影、全文驻留），after 列即修复后投影生效：

| 真实 session | turns | 末态发送面 before | after | 压缩 |
|---|---|---|---|---|
| 01a0c695（issue #1093 现场，22 turns/417 msgs） | 22 | 380,584 | 72,254 | **-81.0%** |
| 01a0a7eb（长任务，15 turns/405 msgs） | 15 | 155,243 | 45,462 | **-70.7%** |
| 01a05bc6（重工具链 session，4 turns/478 msgs） | 4 | 279,446 | 65,906 | **-76.4%** |

  增长曲线（01a0c695，逐 turn 发送面 chars）：修复前 turn#15→#22 为 364K→379K 持续爬升；修复后同期 62.8K→71.3K，斜率显著压平（剩余增长来自当轮新结果与小结果，属预期）。issue 验收第 1 条的 ≥30 轮线上前瞻对比以本次真实回放代替，线上长期观测另行排期（非目标节）
- **预期 vs 实际**：预期（历史层削减 70%+、当轮零损失、幂等）全部命中，无偏离/反转
- 最简实现检查：已过——仓库既有实现（image-externalizer 投影模式 + findTurnBoundary 复用）→ stdlib（slice）→ 零新依赖、零新配置、单文件纯函数；相对 issue 蓝本的「落盘外置」少一套文件生命周期机制
- 前缀缓存：投影只动历史段消息数组，system prompt 链路（before_agent_start）零接触；确定性投影 + 一次性变更（见设计取舍）

## 附录：回放脚本（可重跑）

依赖：`npx tsx`（devDeps 既有）。用法：`npx tsx replay.ts <session.jsonl>`；before 列跑在无投影的历史行为上（= 修复前基线），after 列跑在本特性 `externalizeHistoricalToolResults` 上（真实实现，非重算近似）。

```ts
import fs from "node:fs";
import { externalizeHistoricalToolResults } from "<worktree>/src/frameworks/agent/toolresult-externalizer";

function toolResultChars(messages: any[]): number {
  let n = 0;
  for (const m of messages) {
    if (m?.role === "toolResult" && Array.isArray(m.content)) {
      for (const c of m.content) if (c?.type === "text" && typeof c.text === "string") n += c.text.length;
    }
  }
  return n;
}

const file = process.argv[2];
const messages: any[] = [];
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const e = JSON.parse(line);
    if (e.type === "message" && e.message?.role) messages.push(e.message);
  } catch { /* 非 JSON 行跳过 */ }
}

const isBoundary = (m: any) => m.role !== "assistant" && m.role !== "toolResult";
for (let k = 0; k < messages.length; k++) {
  if (!isBoundary(messages[k])) continue;
  const prefix = messages.slice(0, k + 1); // k 之前全部为历史区
  const before = toolResultChars(prefix);
  const after = toolResultChars(externalizeHistoricalToolResults(prefix));
  console.log(`turn before=${before} after=${after} saved=${before - after}`);
}
```
