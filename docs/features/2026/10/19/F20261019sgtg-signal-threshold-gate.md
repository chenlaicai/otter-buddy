---
id: F20261019sgtg
title: "RHI density/hotspot 产出口径调整：双门 AND + 高扇入枢纽排除（#1051 方案 1）"
summary: "根治「产出-消费断链」——post_merge_fix_density 由「次数≥3 或 占比≥30%」的或门改为「次数≥3 且 占比≥15%」的双门，hotspot 复用 computeFanInExclusions 排除高扇入枢纽文件。实测 sqlite：52 条 open density 存量里绝大多数低于新阈值（达标者个位数，随 30 天窗口滑动，当日实测 8–9 条），16 条 open hotspot 存量全灭（全部指向 fan-in≥29 的枢纽）。观测落点区分写：hotspot 被排除的枢纽热度仍落 health_snapshots（distribution/file_hotspots，历史序列在，观测不丢）；density 的链级密度快照里无落点（只有全仓级 bugfix_ratio），被压掉的单链占比是有意静默。"
change_type: feature
capability_test: "n/a: 确定性检测器逻辑变更，由单元测试覆盖（tests/usecases/health/post-merge-fix-density.test.ts 16 例 / detect-signals.test.ts 含新增 fan-in 排除例），无 LLM 参与、无对话能力面"
created_in_conversation: 9993f9b1-bea7-41b6-9313-bc33ba23f77e
tags: [health, signals, rhi, tech-debt]
modules: [health]
created_at: 2026-10-19
intent:
  problem: "RHI density/hotspot 触发口径过宽：post_merge_fix_density 是或门（次数≥3 或 占比≥30%），次数门在大分母下失效——月产 200+ commit 的仓库里任何合入 30 天内的特性都能凑够 3 条 bugfix；hotspot 无 fan-in 意识，专报高扇入枢纽文件。实测 52 条 open 存量里 43 条占比仅 1–12%，16 条 open hotspot 全部指向 fan-in≥29 的枢纽（正是 density 主动排除的那批）。按现行消费规则这类 warning 永远聚合不成升级条件，是注定无人消费的清单"
  expected_effect: "signals 表 open 且 triage_status IS NULL 的 density+hotspot 由处置前 29 条降至**个位数**（新口径下仍达标的真信号，符合 #1051「归零或个位数」验收）。注意这是**随窗口滑动的活数字**：当日实测 8 条（前一日 9），因 evidence 被旧口径持续刷新、单链占比会随 30 天窗滑出滑入，故验收看「个位数」而非固定值；新口径对 52 条 open density 存量当日实测 8 条达标 / 44 条为旧或门口径噪音；16 条 open hotspot 全部指向 fan-in≥29 枢纽（新口径产出端即排除，合并后由 sweep 脚本退出）。低于阈值者合并后由 scripts/sweep-stale-signals.mjs 幂等清扫——该脚本两类都扫（density 按双门阈值、hotspot 按文件扇入），旧口径未合并前会回涨，见已知代价 1。"
  verify_by:
    type: metric_probe
causal_links:
  - "#1051"
  - "#1335"
  - "#1472"
---

# RHI density/hotspot 产出口径调整（#1051 方案 1）

## 目标

- 消除 RHI 信号里「注定无人消费」的产出：density/hotspot 改为**达阈值才产出 signal，否则不产出**（观测落点两类不同：hotspot 的枢纽热度仍落 `distribution/file_hotspots` 快照、观测不丢；density 的链级密度无快照落点，是有意静默，见下方）
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

**小分母不再有专门下限（检视建议 4 修复后）**：原实现设了 `RATIO_MIN_DENOMINATOR=5`（分母 <5 时强制占比置 0），在双门 AND 下造成**非单调悬崖**——3 bugfix/4 commit=75% 双门皆过却被拦杀，3/5=60% 反而触发（密度更高反而更不可能报警）。该下限的原顾虑「仅 1 条 bugfix → 100% 触发是荒谬的」在 AND 语义下已由次数门 ≥3 接管（1 条 bugfix 无论如何过不了次数门），故移除常量与下限，占比一律按实算。实测存量最小子分母为 15，移除对当前存量零影响。

### 2. hotspot：复用 computeFanInExclusions 排除枢纽

`src/usecases/health/detect-signals.ts` — `detectHotspot` 增加 `chains` 参数（调用点 `detectSignals` 本就持有 chains）：

```ts
const excludedSet = new Set(computeFanInExclusions(chains).map(x => x.file));
// ...
if (excludedSet.has(f)) continue;
```

**单一真相源**：排除清单复用 `computeFanInExclusions`（与 density 同一函数、同一 `FAN_IN_THRESHOLD=10`），不从 hotspot 自己的 30 天 commit 流独立计算——后者会与链构建窗口（60 天）形成双源漂移，这条理由 density 检测器里已有显式注释（检视建议 3）。

### 3. 存量处置

open 的 density 52 条 + hotspot 16 条逐条 dismiss，note 写判断结论（不处置必须是判断结论，不能是沉默）。**`hotspot_imbalance` 1 条（id 464，全仓 bugfix:feature 比率型）不在拍板的「density/hotspot」范围内，未处置**——它是另一个检测器，收编与否留给搭档终审。#1472 绑定的 3 条（#435/#436/#437）随口径调整退出，其关闭标准的次日观测项失去观测标的。

## 影响范围

- 后端：`src/usecases/health/post-merge-fix-density.ts`、`src/usecases/health/detect-signals.ts`
- 测试：`tests/usecases/health/post-merge-fix-density.test.ts`、`tests/usecases/health/detect-signals.test.ts`
- 数据：`signals` 表存量（52+16 条 open → dismissed；`hotspot_imbalance` 1 条未处置，见上）

**不受影响**：`rhi-scan-worker.ts`（只透传 windowDays，检测逻辑在 detectSignals）、`signal-registry.ts`（severity/name/suggestedAction 不变）、`signal-counts.ts`、`signal-pipeline.ts`、`health_snapshots` 表结构与写入路径。

## 设计取舍

**机制识别检查点判定**：未新增机制。两处改动都是**收窄既有机制的管辖边界**——density 收窄「什么算达阈值」，hotspot 收窄「什么文件算热点」。fan-in 排除机制本就存在（density 在用、有独立测试、有 evidence 透出契约），本次是把它应用到 hotspot，不是造新的。故 `Modification-Class: scope-reduction`，不触发机制预算四问。

**为什么是收窄而不是修 bug**：或门/无 fan-in 排除在当时的设计语境下都有其道理（早期仓库 commit 量小，3 条 bugfix 确实是信号）。但仓库规模变化后口径失真——这属于「机制的管辖边界需要重新划定」，即决策树②的典型场景。

**已知代价（诚实列出）**：
1. **density 可能变得很少触发**：新口径下 52 条存量里达标的仅个位数（当日实测 8 条、前一日 9 条，约 15–17%——**随 30 天窗口滑动的活数字**，单链占比会被旧口径扫描持续刷新）。#647 曾把 post_merge_fix_density 列为「PR2 的灵魂信号」，收窄后它可能长期静默。**缓解不是「仍进快照」**——health_snapshots 里只有全仓级 `bugfix_ratio` / `bugfix_count` / `bugfix_ratio_of_fid`，`chain_states` 也只是 active/orphan/regressed 计数，**没有 per-feature 的链级密度落点**（sqlite 实测），被压掉的单链占比在信号之外无历史序列，实时兑底只有 `/api/health/chains`。阈值是模块顶部常量，可单点回调；是否补链级快照行属后续事项（需补行过机制预算四问）。**此结论只适用于 density**：hotspot 被排除的枢纽热度仍落 `distribution/file_hotspots` 快照（74 行，metadata 完整携带被排除的枢纽文件），那里「观测不丢」成立。
2. **次数门下限不变**：`2/5 = 40%`（占比门过了但次数门 2<3）仍不产出——2 次事件是薄证据链，单点事件不构成「补丁摞补丁」的模式。（注：原稿举的「#465 即此形态」是错的，#465 实为 3/18 = 17%，属应存活真信号，见检视修复轮。）
3. **hotspot 排除依赖 chains 的扇入统计**：chains 为空时（如某些测试场景）不排除任何文件，行为退回原样——这是刻意的（无链数据就没有扇入事实可依），不是缺陷。

## 检视修复轮（PR #1560 对抗审视，3 严重 + 4 建议）

检视獭-1560（mimo-pro，异模型）逐条核验，7 条全部收入，零驳回：

| # | 发现 | 修复 |
|---|---|---|
| 严重 1 | 9 条**应存活真信号**（占比 15–29%，id 446/465-468/473-476）被套「占比低于新阈值……误报」模板 dismiss，与实测自相矛盾 | 恢复 9 条为 open，note 改为「已达新双门口径、上轮系误判」；同键重复行（清扫-回涨周期产物）去重退出 |
| 严重 2 | PR 正文自称「52 + 16 + 1 条逐条 dismiss」，实际 imbalance 0 条（id 464 未处置） | PR 正文与本文档如实改口为「52 + 16」，#464 明确标注未处置 |
| 严重 3 | 「观测不丢（仍进 health_snapshots）」失实——快照实测无链级密度落点 | 三处声明（本 doc、密度检测器注释、热点检测器注释、PR 正文）全部改口；「链级密度入快照」记后续事项，是否补行需过机制预算四问 |
| 建议 4 | 小分母非单调悬崖 | 移除 `RATIO_MIN_DENOMINATOR` 下限，占比一律实算；新增回归「3 bugfix/4 commit = 75% 应触发」 |
| 建议 5 | 注释数字失实（23–50% → 实测 15–29%；40 条 39 条 → 52 条 43 条） | 已全部订正为 sqlite 实测值 |
| 建议 6 | 手工清扫 SQL 属补丁抵抗反面教材（upsert 只匹配 open，dismiss 后会被扫描重开新行） | 新增幂等脚本 `scripts/sweep-stale-signals.mjs`（dry-run 默认 / --apply / 事务 / 事务前备份 / 解析失败与扇入计算失败均 fail-loud）。**两类都扫**（delta 复核 C 项）：density 按双门阈值、hotspot 按文件扇入 ≥10（用与线上 computeFanInExclusions 同口径的 git log 重算），无差别扫全部 hotspot 会误杀非枢纽真热点。实测 dry-run：保留 9 / 清扫 59（43 density + 16 枢纽 hotspot）/ fail-loud 0 |
| 建议 7 | upsert re-fire 缺口需建 issue | 净增熔断生效中（open > 60），无勾选自发立案被拦——进候选池，由搭档终审勾选 |

修后实测：全量测试 398 文件 / 6252 例通过（含新增悬崖回归）；tsc --noEmit 通过。

## Delta 复核（第二轮，范围 A/B/C）

检视獭-1560 二次复核维持 request-changes，3 项 delta 严重，全部成立，全收：

| # | 发现 | 修复 |
|---|---|---|
| **A** | 严重 2 修复不彻底 + **修复声明失实**：特性文档 :106/:112 仍写「hotspot_imbalance 1 条逐条 dismiss」「52+16+1 → dismissed」，而修复轮表声称「本文档如实改口为 52+16」——声明改了、正文没改，是初轮严重 2 的原形态复发 | 两处正文已改（并注明 id 464 未处置及原因）；修复轮表相应行同步 |
| **B** | **把真声明改成假声明**：修复轮新写的「诚实声明：health_snapshots 无文件热度落点」是假的——`distribution/file_hotspots` 快照行实存（sqlite 实测 74 行，metadata 完整携带 app.ts×66、platforms.ts×58、agent-invoker.ts×57），快照代码见 `snapshot-rows.ts` + `metrics-calculator.ts` | 拆成两条各自核实的声明：**hotspot = 观测不丢为真**（枢纽热度仍落快照）；**density = 链级密度确无落点**（快照只有全仓级 `bugfix_ratio`，`chain_states` 只是 active/orphan/regressed 计数）。三处声明（密度注释、热点注释、doc）均按此拆分 |
| **C** | sweep 脚本只扫 density；注释声称回涨的 16 条枢纽 hotspot「被合并后首轮扫描自然覆盖」——upsert 从不关存量行，机制上不存在；注释引用的 `--include-hotspot` 参数根本不存在（parseArgs 会 exit(2)）；commit message「43+16 由 sweep 退出」与脚本行为矛盾 → **照声明路径走到终点，验收断言打不到 9 条目标** | 脚本改名 `sweep-stale-signals.mjs` 并**补上 hotspot 清扫**：按文件扇入 ≥10 退出（用与线上 `computeFanInExclusions` 同口径的 `git log` 重算，而非无差别扫全部——那会误杀非枢纽真热点）。幽灵参数引用与「自然覆盖」假声明一并删除。实测 dry-run：保留 9 / 清扫 59（43 density + 16 枢纽 hotspot，扇入 29–65）/ fail-loud 0 |

**本轮修复纪律**：每条改口附机械核对输出（grep 定位 + sqlite 实测），声明-正文-脚本-验收四者一致性自查过后才交。

## 末轮文案修正（二次 delta 的 3 条残留，检视明示改完即放行）

| # | 残留 | 修复 |
|---|---|---|
| 1 | delta 建议 C 被派工未销：`post-merge-fix-density.ts` 里两行旧注释仍在（引用已删常量 `RATIO_MIN_DENOMINATOR`，且与紧随其后的新注释自相矛盾；grep 全仓唯一命中就是它） | 两行已删 |
| 2 | **B 病轻度现身**：sweep 脚本注释与 `--apply` 会写进 59 条持久留痕的 note 都写「与 density **复用** computeFanInExclusions **单一真相源**」——实际是同口径镜像重算（同阈值、同 60 天窗，但从 git log 独立算，并未调用该函数） | 两处改为「同口径但非同一函数，本脚本从 git log 独立镜像重算」。会在持久留痕里的那句尤其不能留假话 |
| 3 | `expected_effect` 的「9 条」是时间敏感数字：10-20 实测已漂到 8（id=476 随滑窗 15%→14% 出双门），evidence 被旧口径持续刷新、单链占比随 30 天窗滑出滑入 | 前向性声明（summary / `expected_effect` / 已知代价 1 / 验证）统一改为「个位数（当日实测 8–9）」并显式注明是随窗口滑动的活数字；各轮的历史记录保留当时数字不动（它们是带日期的事实记录）

## 验证

- 已过最简实现检查：生产代码无新文件、无新依赖；最重的改动是 `detectHotspot` 加一个参数，复用既有 `computeFanInExclusions` 而非重写扇入统计。另新增一次性运维脚本 `scripts/sweep-stale-signals.mjs`（检视建议 6：把手工清扫 SQL 入仓为幂等脚本，避免补丁抵抗；delta 复核 C 项后补上 hotspot 清扫）。
- 单元测试：`post-merge-fix-density.test.ts` 16 例通过（含新增「#1051 噪音形态不产出：3 bugfix / 111 commit = 3%」核心回归）；`detect-signals.test.ts` 通过（含新增「hotspot：高扇入枢纽文件排除（与 density 单一真相源）」，带对照组验证非枢纽源码文件仍正常报警）
- 类型检查：`npx tsc --noEmit` 通过
- 存量实测（分日跑，数字随窗口滑动）：2026-10-19 首跑 52 条 open density 达标 9 / 低于阈值 43；10-20 复跑达标 8 / 清扫 60（id=476 随滑窗从 15% 落到 14% 出双门）。**验收以「个位数」为准而非固定值**。16 条 open hotspot 全部指向 fan-in≥29 的枢纽，全部消除
- 断言（#1051 验收）：实施后 `signals` 表 open 且 `triage_status IS NULL` 的 density/hotspot 归零或个位数（sqlite 实测输出附 PR）

## 关联

- **#1051** — 本特性的拍板来源（方案 1），PR 描述写 `Fixes #1051`
- **#1335** — 其关闭标准「阈值口径（双门参数）写入检测器配置或特性文档，且首批 5 条按新口径完成重裁（留观察/dismiss 有明确记录）」由本 PR 的口径落地 + 存量 dismiss 留痕共同满足（是否关闭由搭档判断）
- **#1472** — 三条 F 文档回看定性已落 issue 评论（结论：均非生成回路，真问题在检测器口径，归口本 PR）

> 🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 存量执行獭
