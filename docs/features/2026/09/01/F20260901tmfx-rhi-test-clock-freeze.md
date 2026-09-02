---
id: F20260901tmfx
title: "#605 rhi-scan-worker 测试时间敏感 flaky 治理：时钟冻结 + 窗口对齐陷阱实证"
summary: Issue #605「chain_states 断言随日内时间翻转」的根因确认与修复。系统性时间旅行实验证伪了 issue 的「日内判定窗口跨界」假说（无法复现）；确认 fixture「now - offset」相对时间构造是非确定性土壤，且「绝对固定时间戳」方向存在 git --since committer date 过滤的窗口错位陷阱。修复采时钟冻结（真实时钟快照），零生产代码改动。
change_type: fix
status: development
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# #605 rhi-scan-worker 测试时间敏感 flaky 治理

## 背景与现象

Issue #605（daily-review，8/30 大獭在 #604 全量测试时发现）：
`tests/usecases/health/rhi-scan-worker.test.ts`「snapshotSink 注入后 scanOnce 写入指标快照」用例：

- 8/30 16:09:03 跑：绿
- 16:10:54 及之后多次重跑：红，同一断言（:156）

```
expect(JSON.parse(chainStates.metadata!)).toEqual({ stalled: 1, active: 1 })
实际: { stalled: 1, regressed: 1 }
```

Issue 给出两个修复方向：首选「只改测试」（种子时间戳改绝对固定时间 + 判定窗口参数化）；备选生产代码时钟依赖注入。

## 根因确认（实验为主，推翻 issue 推断）

### 实验设计

issue 假说「种子用 now-offset 相对时间，跨过判定窗口的日内边界（疑 2 小时粒度）」。为验证，用 `vi.setSystemTime` 做时间旅行复现（mock 范围覆盖 fixture 构造 + 用例执行全程，比真实运行更严格）：

| # | 实验 | 代码基线 | 结果 |
|---|---|---|---|
| 1 | 24 整点扫描（含 16:10 CST 边界点） | HEAD（含 #658） | 全绿 |
| 2 | 24 整点扫描 | f7e785d0（8/30 翻红现场代码，#597） | 全绿 |
| 3 | 61 分钟级采样（16:00–17:00 CST，覆盖 16:09→16:10 翻换边界） | HEAD | 全绿 |
| 4 | 真实时钟当日重跑 | f7e785d0 | 全绿 |
| 5 | 纸上推演 | — | 见下 |

### 纸上推演（chain-builder.ts 逐条排除）

- fixture 5 个 commit：`now - 5d + seq*1h`；判定 `daysSinceLastCommit = floor((now - last)/day)`。**now 与种子同步移动 → daysSince 恒等于 4，远离 stalled 阈值 14**——「天粒度窗口跨界」在相对构造下数学上不成立。
- `isRegressed`（chain-builder.ts:216）**纯结构判定**：最新 commit 是否 BugFix + 文件交集，无任何时间参与。active→regressed 翻转不可能由日内时刻触发。
- 唯一刻度小于天的比较是字符串字典序（`c.date >= windowStart`，60 天窗口），种子与窗口同向移动，不产生日内翻转。

### 结论

1. **「日内时间敏感」假说证伪**：翻转无法在受控时间旅行下复现（85 个时间点 + 历史基线 + 真实时钟均绿）。8/30 16:10 的「持续红」更可能是 #601 同族的随机/环境性 flaky 在当时的残留（#601 定性见 F20260830fx62：author date 秒级平局致排序漂移，#597 的 1h 递增已治），与具体时刻的因果性无法证实。置信度：中高（复现实验 85 点全绿 + 判定代码逐条排除；无法穷尽 8/30 当时的环境状态）。
2. **非确定性土壤确认**：fixture 用 `Date.now()` 相对构造，种子随运行时刻漂移、用例间真实时钟流逝引入偏差——这是 #595/#601/#605 三次 flaky 的共同土壤，无论 8/30 具体诱因是哪个，都值得治本。

## 方案：时钟冻结（只改测试，零生产代码）

issue 首选方向的落地，但**否决了「绝对固定时间戳」子方案**——实证发现窗口错位陷阱：

### 陷阱：git --since 按 committer date 过滤

`git log --since` 用 **committer date**（子进程真实时钟，`vi.setSystemTime` 摸不到）过滤，而 fixture 的 `--date` 只设 **author date**（mock 时钟派生）。若把冻结点设为绝对固定时间（如 2026-09-01），半年后重跑：mock 时钟 9 月 vs 真实时钟次年 3 月，偏离 > 60 天采集窗口 → fixture 被整体滤空。**实测**：冻结在 `2026-12-31`（偏离真实 ~4 个月）时 7/10 用例翻红（commitCount=0、metricsStored 17≠19 等）。

### 修复（tests/usecases/health/rhi-scan-worker.test.ts）

```ts
const CLOCK_SNAPSHOT = new Date();  // 模块加载时快照
// beforeAll:
vi.useFakeTimers();
vi.setSystemTime(CLOCK_SNAPSHOT);
// afterAll:
vi.useRealTimers();
```

- **冻结**：单次运行内全部 `Date.now()` 派生值恒定——种子间隔严格 1h（无写文件耗时漂移）、判定窗口与种子无相对漂移、用例间无时钟流逝。该文件全部 10 用例共享该冻结。
- **快照而非固定**：冻结点与真实时钟偏差仅毫秒级，git `--since`（committer date）窗口永不错位。
- 顺带收益：`bugfix_median_interval_days` 断言从 `toBeCloseTo(1/24, 3)`（容忍 fixture 写文件耗时）收紧为严格 `toBe(1/24)`——冻结后间隔精确 1h。
- 第二个 describe（costOutputSink 装配回归）断言无时间语义，不冻结，保持原样。

## 验证

- 目标文件：**5 连跑全绿**；TZ=UTC / America/New_York / Pacific/Kiritimati 三时区全绿（时区无关）
- 冻结点敏感性：固定绝对冻结点 5 个时间戳（含 8/30 16:09/16:10 边界两侧）均绿；冻结在偏离真实时钟 >60 天时复现窗口错位翻红（7/10）——反证「快照」选择的必要性
- 全量 vitest 197 files / 2460 tests 全绿；tsc --noEmit 0 错误；eslint（改动文件）0 error
- 最简实现检查：已过——vi.useFakeTimers/setSystemTime 为 vitest 平台原生能力，无新增依赖、无生产代码改动、净 diff +11/-6 行（含注释）
- pre-existing 声明：无（全量测试一次通过，无失败需归因）

## 影响范围

- 仅 `tests/usecases/health/rhi-scan-worker.test.ts` 一个文件
- 未触碰 `src/usecases/health/rhi-scan-worker.ts`（与并行 #647/#652 口径改动零冲突）
- 未触碰计数逻辑、confidence/severity 语义

## 取舍

- **不做判定窗口参数化**（issue 首选方向的后半句）：实验已证伪窗口跨界机制，参数化是防御不存在的问题，徒增生产代码面——与「以测试确定性为完成判据、不为改而改」的边界约束一致。
- **不做生产代码时钟注入**：同上，无证据表明生产判定逻辑有问题。
- 残余风险：若 8/30 的真实诱因是环境随机性（如文件系统 mtime、git 进程调度），冻结时钟后该类诱因是否被完全覆盖无法穷尽证明——以「任意时刻跑结果一致」为验收的连续重跑 + 多时区实验作经验性保障。
