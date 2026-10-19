---
id: F20261019sgtg
title: "RHI density/hotspot 产出口径调整：双门 AND + 高扇入枢纽排除（#1051 方案 1）"
summary: "根治「产出-消费断链」——post_merge_fix_density 由「次数≥3 或 占比≥30%」的或门改为「次数≥3 且 占比≥15%」的双门，hotspot 复用 computeFanInExclusions 排除高扇入枢纽文件。实测 sqlite：52 条 open density 存量消除 43 条（存活 9），16 条 open hotspot 存量全灭（全部指向 fan-in≥29 的枢纽）。未达阈值的链/文件仍进 health_snapshots 快照，观测不丢、警报位释放。"
change_type: feature
capability_test: "n/a: 确定性检测器逻辑变更，由单元测试覆盖（tests/usecases/health/post-merge-fix-density.test.ts 16 例 / detect-signals.test.ts 含新增 fan-in 排除例），无 LLM 参与、无对话能力面"
created_in_conversation: 9993f9b1-bea7-41b6-9313-bc33ba23f77e
tags: [health, signals, rhi, tech-debt]
modules: [health]
created_at: 2026-10-19
causal_links:
  - "#1051"
  - "#1335"
  - "#1472"
---

# RHI density/hotspot 产出口径调整（#1051 方案 1）

## 目标

- 消除 RHI 信号里「注定无人消费」的产出：density/hotspot 改为**达阈值才产出 signal，否则只进 health_snapshots 快照**
- 存量 open 信号逐条 dismiss 留痕（不处置必须是判断结论，不能是沉默）

## 非目标

- 不动处置管道（triage 状态机 / aging worker / 已有的 dismiss 语义）
- 不动 bug_recurrence / chain_stall / behavior_defect / hotspot_imbalance 的口径
- 不关闭 #1472（其关闭标准含次日观测项，属大獭/搭档判断）
- 不改信号的 severity 分级、置信度标注机制

## 背景：产出-消费断链

#1051 的来历一句话：RHI 检测器每小时产出大量 warning 级信号，而消费规则（critical 逐条处置 + warning 聚集 ≥5 才升级）对**天然分散**的 warning 永远触发不了——105 条超龄没人管（9/29 实测）。体检獭发现这个断链后建 #1051 请拍板。搭档授权技术域，大獭拍板**方案 1**（调产出阈值 + 存量 dismiss），方案 2（降频）只是把噪音从日报挪到周报，方案 3（观察池）会保留一个 105 条的常驻清单、恰好是这次要治的病。

## 案发现场（实测锚点）

### density：次数门在大分母下形同虚设

`post-merge-fix-density.ts` 原为**或门**——`if (bugfixHits < 3 && ratio < 0.3) return null`，任意一道门过就报。sqlite 实测 52 条 open 存量：

```
363|13/236 = 6%   371|17/235 = 7%   385|8/230 = 3%   401|3/209 = 1%   424|3/223 = 1%  …
──────────────────────────── 噪音群 / 真信号群之间的清晰断层 ────────────────────────────
6/30 = 20%   6/21 = 29%   5/25 = 20%   5/28 = 18%   3/18 = 17%   3/15~3/20 = 15-20%
```

**43/52 条只过了次数门**——占比 1–12%，分母 40–236 条 commit。在月产 200+ commit 的仓库里，任何合入 30 天内的特性都会凑够 3 条 bugfix。噪音群（1–12%）与真信号群（15–29%）之间有清晰断层，15% 恰好落在断层内。

且信号每轮扫描仍命中就累加计数（`countSignalOccurrences`），窗口没滑出就永不自清——实测同一组信号 6 天内从 18 涨到 85，涨的全是噪音频次。

### hotspot：检测器与 density 自相矛盾

open 的 16 条 hotspot **全部**指向高扇入枢纽文件，实测近 60 天 fan-in：

| 文件 | fan-in | 修改次数 |
|---|---|---|
| src/app.ts | 65 | 19 |
| src/bootstrap/platforms.ts | 56 | 19 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 55 | 29 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 53 | 24 |
| web/src/pages/conversation/index.tsx | 50 | 23 |
| src/frameworks/agent/pi-session-factory.ts | 50 | — |
| src/frameworks/agent/bash-safety-guard.ts | 47 | — |
| …（其余 9 条 fan-in 29–45） | | |

**这正是 `post_merge_fix_density` 用 `FAN_IN_THRESHOLD=10` 主动排除的那批文件**（其 evidence 明写「已排除高扇入文件 82 个：src/app.ts×65、platforms.ts×56…」）。同一仓库，一个检测器认定「枢纽文件被碰是常态、对它全是噪音」，另一个却拿它报警——hotspot 从来没有 fan-in 意识。

## 方案设计

### 1. density：或门 → 双门 AND

`src/usecases/health/post-merge-fix-density.ts`

```ts
// 旧
if (bugfixHits < FIX_COUNT_THRESHOLD && ratio < FIX_RATIO_THRESHOLD) return null;
// 新
if (bugfixHits < FIX_COUNT_THRESHOLD || ratio < FIX_RATIO_THRESHOLD) return null;
```

`FIX_RATIO_THRESHOLD` 由 `0.3` 调至 `0.15`（取自实测分布断层）。

**双门语义的由来**：#1335 的关闭标准原文是「阈值口径（**双门参数**）写入检测器配置或特性文档，且首批 5 条按新口径完成重裁」——「双门」本就是两道门都要过的语义，原实现的或门与此不符。

**小分母行为变化（显式声明）**：`RATIO_MIN_DENOMINATOR=5` 保护仍保留（分母 <5 时占比置 0），但 AND 语义下**小分母窗口不再由次数门单支把关**——分母 <5 的薄证据链（<5 条 commit）不再产出信号，落快照。这是收窄，符合方案 1「达阈值才产出」。

### 2. hotspot：复用 computeFanInExclusions 排除枢纽

`src/usecases/health/detect-signals.ts` — `detectHotspot` 增加 `chains` 参数（调用点 `detectSignals` 本就持有 chains）：

```ts
const excludedSet = new Set(computeFanInExclusions(chains).map(x => x.file));
// ...
if (excludedSet.has(f)) continue;
```

**单一真相源**：排除清单复用 `computeFanInExclusions`（与 density 同一函数、同一 `FAN_IN_THRESHOLD=10`），不从 hotspot 自己的 30 天 commit 流独立计算——后者会与链构建窗口（60 天）形成双源漂移，这条理由 density 检测器里已有显式注释（检视建议 3）。

### 3. 存量处置

open 的 density 52 条 + hotspot 16 条 + hotspot_imbalance 1 条逐条 dismiss，note 写判断结论（不处置必须是判断结论，不能是沉默）。#1472 绑定的 3 条（#435/#436/#437）随口径调整退出，其关闭标准的次日观测项失去观测标的。

## 影响范围

- 后端：`src/usecases/health/post-merge-fix-density.ts`、`src/usecases/health/detect-signals.ts`
- 测试：`tests/usecases/health/post-merge-fix-density.test.ts`、`tests/usecases/health/detect-signals.test.ts`
- 数据：`signals` 表存量（52+16+1 条 open → dismissed）

**不受影响**：`rhi-scan-worker.ts`（只透传 windowDays，检测逻辑在 detectSignals）、`signal-registry.ts`（severity/name/suggestedAction 不变）、`signal-counts.ts`、`signal-pipeline.ts`、`health_snapshots` 表结构与写入路径。

## 设计取舍

**机制识别检查点判定**：未新增机制。两处改动都是**收窄既有机制的管辖边界**——density 收窄「什么算达阈值」，hotspot 收窄「什么文件算热点」。fan-in 排除机制本就存在（density 在用、有独立测试、有 evidence 透出契约），本次是把它应用到 hotspot，不是造新的。故 `Modification-Class: scope-reduction`，不触发机制预算四问。

**为什么是收窄而不是修 bug**：或门/无 fan-in 排除在当时的设计语境下都有其道理（早期仓库 commit 量小，3 条 bugfix 确实是信号）。但仓库规模变化后口径失真——这属于「机制的管辖边界需要重新划定」，即决策树②的典型场景。

**已知代价（诚实列出）**：
1. **density 可能变得很少触发**：新口径下 52 条存量仅 9 条存活（17%）。#647 曾把 post_merge_fix_density 列为「PR2 的灵魂信号」，收窄后它可能长期静默。缓解：未达阈值仍进 health_snapshots（观测不丢）；阈值是模块顶部常量，可单点回调。
2. **小分母高占比形态退出**：如 2/5 = 40%（合入后 5 条 commit 里 2 条是修）——占比门过了但次数门没过，不再产出。实测样本 #465 即此形态。判断依据：2 次事件是薄证据链，单点事件不构成「补丁摞补丁」的模式，落快照合理。
3. **hotspot 排除依赖 chains 的扇入统计**：chains 为空时（如某些测试场景）不排除任何文件，行为退回原样——这是刻意的（无链数据就没有扇入事实可依），不是缺陷。

## 验证

- 已过最简实现检查：无新文件、无新依赖、无新常量类型；最重的改动是 `detectHotspot` 加一个参数。复用既有 `computeFanInExclusions` 而非重写扇入统计。
- 单元测试：`post-merge-fix-density.test.ts` 16 例通过（含新增「#1051 噪音形态不产出：3 bugfix / 111 commit = 3%」核心回归）；`detect-signals.test.ts` 通过（含新增「hotspot：高扇入枢纽文件排除（与 density 单一真相源）」，带对照组验证非枢纽源码文件仍正常报警）
- 类型检查：`npx tsc --noEmit` 通过
- 存量实测：新口径模拟（次数≥3 且 占比≥15%）→ 52 条 open density 存活 9 条、消除 43 条；16 条 open hotspot 全部指向 fan-in≥29 的枢纽，全部消除
- 断言（#1051 验收）：实施后 `signals` 表 open 且 `triage_status IS NULL` 的 density/hotspot 归零或个位数（sqlite 实测输出附 PR）

## 关联

- **#1051** — 本特性的拍板来源（方案 1），PR 描述写 `Fixes #1051`
- **#1335** — 其关闭标准「阈值口径（双门参数）写入检测器配置或特性文档，且首批 5 条按新口径完成重裁（留观察/dismiss 有明确记录）」由本 PR 的口径落地 + 存量 dismiss 留痕共同满足（是否关闭由搭档判断）
- **#1472** — 三条 F 文档回看定性已落 issue 评论（结论：均非生成回路，真问题在检测器口径，归口本 PR）

> 🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 存量执行獭
