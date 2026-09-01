/**
 * SignalDetector: 信号检测引擎（Issue #399）
 *
 * 输入采集层数据，输出触发的信号列表。全确定性、无 LLM。
 * 信号定义以 signal-registry 为单一真相源，本文件只实现检测逻辑。
 */

import type { ParsedCommit } from "./commit-parser";

import type { CollectedHealingEvent } from "./healing-collector";
import type { FeatureChain } from "./chain-builder";
import { SIGNAL_REGISTRY } from "./signal-registry";
import type { SignalType, SignalSeverity } from "./signal-registry";

/** 检测出的信号实例 */
export interface DetectedSignal {
  type: SignalType;
  name: string;
  severity: SignalSeverity;
  /** 关联的 F 文档（如适用） */
  featureId: string | null;
  /** 关联的文件（如适用） */
  filePath: string | null;
  /** 证据（人类可读，确定性数据） */
  evidence: string;
  suggestedAction: string;
  /** 结构化证据详情（Issue #644）：窗口内全类型 commit 序列（bug●→fix● 交替时间轴的数据源）。
   *  Why 全类型而非仅 bugfix：只有 bugfix 画不出「引入-修复-回归-再修复」的交替节奏，
   *  前端时间轴需要 changeType 区分节点形态（观澜视觉方案 3.1）。窗口滑动时整体重算覆盖。 */
  detail?: SignalDetail | ScoreJumpDetail;
  /** 置信度（Issue #644）：low = 大概率误报（如「干完没归档」的滞留），UI 折叠收纳不进主警报区。
   *  未标注 = normal（默认，走正常警报）。 */
  confidence?: SignalConfidence;
}

/** bug_recurrence 的结构化证据：窗口内该文件的全类型 commit 序列（时间升序） */
export interface SignalDetail {
  kind: "bug_recurrence_commits";
  /** 窗口天数（重算口径的一部分，滑动窗口整体覆盖） */
  windowDays: number;
  /** 窗口内触碰该文件的全部 commit（不只 bugfix——交替节奏需要全类型） */
  commits: Array<SignalDetailCommit>;
}

/** score_jump 的结构化证据：最近两个完整快照日的关键值（环比骤变的分子分母留痕） */
export interface ScoreJumpDetail {
  kind: "score_jump_snapshots";
  /** 前一完整快照日（YYYY-MM-DD，本地时区） */
  previousDate: string;
  /** 今日快照日 */
  currentDate: string;
  /** 各指标的前日值（环比分母） */
  previousValues: Record<string, number>;
  /** 各指标的今日值（环比分子） */
  currentValues: Record<string, number>;
  /** 缺口填槽留痕（审视发现 1）：环比区间偏离信号级锚点的指标 -> 该指标实际比较的两日。
   *  Why 稀疏记录：未偏离的指标区间即锚点区间，不重复占体积；缺省 = 无填槽（旧行为兼容）。 */
  gapFilledKeys?: Record<string, { previousDate: string; currentDate: string }>;
}

export interface SignalDetailCommit {
  sha: string;
  date: string;
  /** commit 类型（BugFix / New Feature / Feature Update / Refactor / …，null=未识别） */
  changeType: string | null;
  message: string;
}

export type SignalConfidence = "normal" | "low";

export interface DetectOptions {
  /** bug_recurrence 窗口天数（默认 30） */
  recurrenceWindowDays?: number;
  /** bug_recurrence 触发次数（默认 3） */
  recurrenceThreshold?: number;
  /** hotspot 固定阈值（文件修改次数，默认 10；窗口内） */
  hotspotThreshold?: number;
  /** hotspot_imbalance 比率阈值（bugfix:feature，默认 2） */
  imbalanceRatio?: number;
  /** 检测窗口（commit 只统计窗口内的，默认 30 天） */
  windowDays?: number;
  /** behavior_defect 窗口天数（Issue #645 窗口化升级，默认 7——同型事件短期爆发才算复发风暴） */
  behaviorWindowDays?: number;
  /** 环比骤变阈值（Issue #645：五维/综合分单日 |Δ|≥此值报警，默认 10） */
  scoreJumpThreshold?: number;
  /** 环比骤变数据源（Issue #645）：读 health_snapshots 的 health_index 行。
   *  Why 注入端口而非直接依赖 repository：detect-signals 是纯函数层，DB 访问走端口注入，测试可换内存实现 */
  scoreHistorySource?: (lookbackDays: number) => Promise<Array<{ snapshot_date: string; metric_key: string; metric_value: number }>>;
  /** 环比骤变回看天数（默认 7：找上一完整日 + 短序列容错） */
  scoreJumpLookbackDays?: number;
  /** 检测器异常回调（审视发现 2）：score_jump 读快照失败时留痕，不静默吞。
   *  Why 回调而非注入 Logger：纯函数层不依赖具体日志端口，装配层（worker/app）自行接线。 */
  onDetectError?: (err: unknown) => void;
  /** 现在时刻（测试可注入） */
  now?: Date;
}

/** 带 ISO 日期的 commit 输入（ChainCommitInput 的解析前形态） */
export interface SignalCommitInput {
  sha: string;
  date: string;
  message: string;
  parsed: ParsedCommit;
  filesChanged: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 运行全部已实现信号检测
 * @param commits commit 流（采集+解析后）
 * @param chains 特性链（ChainBuilder 输出）
 * @param healingEvents healing 事件流（HealingCollector 输出，可为空）
 * @param docs F 文档（chain_stall 的文档状态校验，可为空——chains 已带 doc）
 */
export async function detectSignals(
  commits: SignalCommitInput[],
  chains: FeatureChain[],
  healingEvents: CollectedHealingEvent[],
  options: DetectOptions = {},
): Promise<DetectedSignal[]> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? 30;
  const windowStart = new Date(now.getTime() - windowDays * DAY_MS);
  const inWindow = commits.filter(c => new Date(c.date) >= windowStart);

  const signals: DetectedSignal[] = [];

  signals.push(...detectBugRecurrence(inWindow, options, now));
  signals.push(...detectChainStall(chains, now));
  signals.push(...detectHotspot(inWindow, options));
  signals.push(...detectBehaviorDefect(healingEvents, options, now));
  signals.push(...detectHotspotImbalance(inWindow, options));
  // Why await 在数组平铺后逐个 push：score_jump 是唯一异步检测器（快照读端口），
  // 失败降级为 [] 不阻断其余检测（传感器分离）——但异常经 onDetectError 留痕（审视发现 2），
  // 不静默吞：DB 长期故障会让 score_jump 无信号且无人知晓
  signals.push(...(await detectScoreJump(options).catch((err: unknown) => {
    options.onDetectError?.(err);
    return [];
  })));

  return signals;
}

/** bug_recurrence：同模块同文件 bugfix ≥N 次/窗口（窄门：不依赖语义聚类） */
function detectBugRecurrence(
  commits: SignalCommitInput[],
  options: DetectOptions,
  now: Date,
): DetectedSignal[] {
  const threshold = options.recurrenceThreshold ?? 3;
  const windowDays = options.recurrenceWindowDays ?? 30;
  const reg = SIGNAL_REGISTRY.bug_recurrence;

  // key: module + file -> bugfix commit 列表（窗口内）
  const byModuleFile = new Map<string, {
    module: string; file: string;
    shas: string[]; dates: Date[];
    /** 窗口内触碰该文件的全类型 commit（bug●→fix● 交替时间轴数据源，Issue #644） */
    allCommits: SignalDetailCommit[];
  }>();

  const recurrenceStart = new Date(now.getTime() - windowDays * DAY_MS);
  for (const c of commits) {
    if (c.parsed.changeType !== "BugFix" || !c.parsed.module) continue;
    const date = new Date(c.date);
    if (date < recurrenceStart) continue;

    // Set 防御（审视建议发现 4）：同 commit 的 filesChanged 若含重复文件名，
    // 不去重会双计 shas 抬高触发次数——当前 git --name-only 不重复，纯防御性收口
    for (const file of new Set(c.filesChanged)) {
      const key = `${c.parsed.module}\u0000${file}`;
      let entry = byModuleFile.get(key);
      if (!entry) {
        entry = { module: c.parsed.module, file, shas: [], dates: [], allCommits: [] };
        byModuleFile.set(key, entry);
      }
      entry.shas.push(c.sha.slice(0, 8));
      entry.dates.push(date);
    }
  }

  // 第二遍（Issue #644）：为触发文件收集窗口内全类型 commit，见 collectDetailCommits
  collectDetailCommits(commits, byModuleFile, recurrenceStart);

  const signals: DetectedSignal[] = [];
  for (const entry of byModuleFile.values()) {
    if (entry.shas.length >= threshold) {
      signals.push({
        type: reg.type,
        name: reg.name,
        severity: reg.severity,
        featureId: null,
        filePath: entry.file,
        evidence: `[${entry.module}] ${entry.file} 窗口 ${windowDays} 天内 bugfix ${entry.shas.length} 次（${entry.shas.join(", ")}）`,
        suggestedAction: reg.suggestedAction,
        detail: {
          kind: "bug_recurrence_commits",
          windowDays,
          commits: entry.allCommits,
        },
      });
    }
  }
  return signals;
}

/** Issue #644 第二遍收集：为已触发的 (module, file) 填充窗口内全类型 commit 序列（时间升序）。
 *  Why 全类型：只有 bugfix 画不出「引入-修复-回归-再修复」交替节奏，前端时间轴需要 changeType
 *  区分节点（观澜视觉方案 3.1）。窗口滑动时随扫描整体重算覆盖（非 append）。 */
function collectDetailCommits(
  commits: SignalCommitInput[],
  byModuleFile: Map<string, { allCommits: SignalDetailCommit[] }>,
  recurrenceStart: Date,
): void {
  for (const c of commits) {
    const date = new Date(c.date);
    if (date < recurrenceStart) continue;
    // module 无法解析的 commit 不参与（与第一遍口径一致：module null 直接 skip）
    if (!c.parsed.module) continue;
    // 与第一遍同样的 Set 防御：重复文件名不重复入 detail（避免时间轴重复节点）
    for (const file of new Set(c.filesChanged)) {
      const key = `${c.parsed.module}\u0000${file}`;
      const entry = byModuleFile.get(key);
      if (!entry) continue; // 未达 bugfix 阈值的文件无 entry，不浪费内存
      entry.allCommits.push({
        sha: c.sha.slice(0, 8),
        // date 归一为 Z 格式 ISO（审视建议发现 5）：与 chainDetail 端点的 toISOString()
        // 统一序列化契约，前端两路数据排序/分组不踩 localeCompare 语义差
        date: new Date(c.date).toISOString(),
        changeType: c.parsed.changeType,
        message: c.message,
      });
    }
  }
  for (const entry of byModuleFile.values()) {
    entry.allCommits.sort((a, b) => a.date.localeCompare(b.date));
  }
}

/** 从未有关联 commit 的文档状态（零 commit 是常态，不应触发滞留信号） */
const DOC_NEVER_STARTED_STATUSES = new Set(["draft", "proposed", "design"]);

/** 僵尸链阶梯（Issue #645）：30/60/90 天三级，证据文案随档位变化供每日任务分拣 */
const ZOMBIE_LADDER = [
  { minDays: 90, label: "90 天+ 建议归档" },
  { minDays: 60, label: "60 天 红档" },
  { minDays: 30, label: "30 天 黄档" },
] as const;

function zombieLadderLabel(idleDays: number): string {
  for (const step of ZOMBIE_LADDER) {
    if (idleDays >= step.minDays) return step.label;
  }
  return ZOMBIE_LADDER[ZOMBIE_LADDER.length - 1]!.label;
}

/** chain_stall：特性链滞留（复用 ChainBuilder 的 stalled/zombie 判定） */
function detectChainStall(chains: FeatureChain[], now: Date): DetectedSignal[] {
  const reg = SIGNAL_REGISTRY.chain_stall;
  return chains
    .filter(c => c.state === "stalled" || c.state === "zombie")
    // Why: draft/proposed 文档从未有 commit 是常态（孤儿文档），不应触发 critical 信号
    .filter(c => {
      if (c.commitCount === 0 && DOC_NEVER_STARTED_STATUSES.has(c.doc?.status ?? "draft")) return false;
      return true;
    })
    .map(c => {
      // Why: daysSinceLastCommit 为 null 表示从未有 commit（doc-only 链），用 createdAt 代替
      const stallDays = c.daysSinceLastCommit ?? (
        c.doc?.createdAt
          ? Math.floor((now.getTime() - new Date(c.doc.createdAt).getTime()) / DAY_MS)
          : null
      );
      // Issue #644 置信规则甲：stalled ∧ 有 commit → low（实查 18/18 为「干完没归档」误报，
      // 大概率活已干完只是文档没归档）；zombie 与 doc-only 滞留保持 normal（异常更实）。
      // zombie/doc-only 不降置信：30 天无 commit 且对话零提及更接近真异常。
      const confidence: SignalConfidence =
        c.state === "stalled" && c.commitCount > 0 ? "low" : "normal";
      return {
        type: reg.type,
        name: reg.name,
        severity: reg.severity,
        featureId: c.featureId,
        filePath: null,
        evidence: c.state === "zombie"
          ? `${c.featureId} 僵尸链：30 天无 commit 且近 30 天对话零提及（doc status=${c.doc?.status ?? "?"}；滞留 ${stallDays} 天，${zombieLadderLabel(stallDays ?? 0)}）`
          : `${c.featureId} 滞留 ${stallDays} 天无 commit（doc status=${c.doc?.status ?? "?"}）`,
        suggestedAction: reg.suggestedAction,
        confidence,
      };
    });
}

/**
 * 测试文件判定：tests/ 目录、__tests__/ 目录、.test./.spec. 后缀。
 * Why: 测试文件随功能代码联动修改是正常节奏，不等于源码热点。
 */
function isTestFile(filePath: string): boolean {
  return /(^|\/)tests?\//i.test(filePath)
    || /(^|\/)__tests__\//i.test(filePath)
    || /\.test\.[^/]+$/i.test(filePath)
    || /\.spec\.[^/]+$/i.test(filePath);
}

/** hotspot：文件修改次数超阈值（窗口内全类型 commit 计数，排除测试文件） */
function detectHotspot(
  commits: SignalCommitInput[],
  options: DetectOptions,
): DetectedSignal[] {
  const threshold = options.hotspotThreshold ?? 10;
  const reg = SIGNAL_REGISTRY.hotspot;

  const fileCounts = new Map<string, number>();
  for (const c of commits) {
    for (const f of c.filesChanged) {
      // Why: 测试文件联动修改是正常节奏，混入热点会稀释信号质量
      if (isTestFile(f)) continue;
      fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }
  }

  const signals: DetectedSignal[] = [];
  for (const [file, count] of fileCounts) {
    if (count > threshold) {
      signals.push({
        type: reg.type,
        name: reg.name,
        severity: reg.severity,
        featureId: null,
        filePath: file,
        evidence: `${file} 窗口内被修改 ${count} 次（阈值 ${threshold}）`,
        suggestedAction: reg.suggestedAction,
      });
    }
  }
  return signals;
}

/** behavior_defect：同一 errorType healing event 窗口内复发（Issue #645 窗口化升级）。
 *  Why 窗口限制：原全量聚合无窗口，历史遗留事件会永久累计——"同型事件 ≥3 次/7 天才算复发风暴"
 *  （合议定稿 §1.2：实查 degenerate 57 次/12 天为此升级后第一天就该报警的模式）。
 *  聚合按窗口内次数降序排序，聚类优先处置（最密类型排最前）。 */
function detectBehaviorDefect(
  healingEvents: CollectedHealingEvent[],
  options: DetectOptions,
  now: Date,
): DetectedSignal[] {
  const threshold = options.recurrenceThreshold ?? 3;
  const windowDays = options.behaviorWindowDays ?? 7;
  const reg = SIGNAL_REGISTRY.behavior_defect;

  const windowStart = new Date(now.getTime() - windowDays * DAY_MS);
  const byType = new Map<string, { count: number; lastAt: Date }>();
  for (const e of healingEvents) {
    // Why createdAt 口径：open 事件被修复前 resolvedAt 为 null，复发聚合以发生时刻为准
    const at = new Date(e.createdAt);
    if (Number.isNaN(at.getTime()) || at < windowStart) continue;
    const entry = byType.get(e.errorType);
    if (entry) {
      entry.count++;
      if (at > entry.lastAt) entry.lastAt = at;
    } else {
      byType.set(e.errorType, { count: 1, lastAt: at });
    }
  }

  // 窗口内次数降序：同型复发聚类按密度排序，最值得优先处置的排最前（Issue #645 聚合排序）
  const ranked = [...byType.entries()]
    .filter(([, v]) => v.count >= threshold)
    .sort((a, b) => b[1].count - a[1].count);

  return ranked.map(([errorType, v]) => ({
    type: reg.type,
    name: reg.name,
    severity: reg.severity,
    featureId: null,
    filePath: null,
    evidence: `errorType=${errorType} 窗口 ${windowDays} 天内复发 ${v.count} 次（阈值 ${threshold}，最近一次 ${v.lastAt.toISOString().slice(0, 10)}）`,
    suggestedAction: reg.suggestedAction,
  }));
}

/** score_jump 环比比较的纯计算部分（拆分以控函数复杂度）：per-key 跳空回溯。 */
interface JumpResult { key: string; prev: number; curr: number; delta: number; from: string; }

/** 指标级序列 → 各指标与「自己的上一有值日」的环比差。缺口填槽（审视发现 1）：
 *  某指标比信号级更稀疏——锚点日缺该维度行（如 D5 无活跃链 null 不落行）时，
 *  回溯到它自己的上一有值日，而非整维度静默跳过。缺日 ≠ 骤变 0。 */
function computeJumps(
  rows: Array<{ snapshot_date: string; metric_key: string; metric_value: number }>,
  currentDate: string,
  previousDate: string,
  threshold: number,
): { jumped: JumpResult[]; gapFilledKeys: Record<string, { previousDate: string; currentDate: string }> } {
  const series = new Map<string, Array<{ date: string; value: number }>>();
  for (const r of rows) {
    if (!SCORE_JUMP_KEYS.has(r.metric_key)) continue;
    let list = series.get(r.metric_key);
    if (!list) {
      list = [];
      series.set(r.metric_key, list);
    }
    list.push({ date: r.snapshot_date, value: r.metric_value });
  }
  for (const list of series.values()) {
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 日期降序
  }

  const jumped: JumpResult[] = [];
  const gapFilledKeys: Record<string, { previousDate: string; currentDate: string }> = {};
  for (const key of SCORE_JUMP_KEYS) {
    const list = series.get(key);
    // 当前日无值：该维度当日未采集（如 D5 无活跃链），无分子不比（与锚点语义一致）
    if (!list || list.length < 2 || list[0]!.date !== currentDate) continue;
    const prev = list[1]!; // 该指标自己的上一有值日（缺口填槽）
    const delta = list[0]!.value - prev.value;
    if (Math.abs(delta) >= threshold) {
      jumped.push({ key, prev: prev.value, curr: list[0]!.value, delta, from: prev.date });
      // 仅当实际比较区间偏离信号级锚点时留痕（稀疏记录：未偏离的不重复占体积）
      if (prev.date !== previousDate) gapFilledKeys[key] = { previousDate: prev.date, currentDate };
    }
  }
  return { jumped, gapFilledKeys };
}

/** score_jump：五维/综合分单日环比骤变（Issue #645）。
 *  Why 「最近两个完整日」口径：当日行会被扫描反复覆盖（replaceForDate 同日重写），
 *  含当日值的环比在一天内多次扫描间不稳定；前日快照已封版，分母稳定。
 *  Why 分子含当日（大獭裁决保留）：score_jump 语义是骤变报警——当日骤变当天就该报，
 *  不等次日封版；一天内多次扫描的告警不稳定是可接受代价（报警偏向灵敏）。
 *  Why 作为检测器走 signal 管道：每日检查任务消费 open 信号自动深挖（issue 原文），
 *  骤变报警必须出现在 open 信号流里，否则消费者要另开一条取数路径。 */
async function detectScoreJump(options: DetectOptions): Promise<DetectedSignal[]> {
  const reg = SIGNAL_REGISTRY.score_jump;
  const threshold = options.scoreJumpThreshold ?? 10;
  const lookback = options.scoreJumpLookbackDays ?? 7;
  const source = options.scoreHistorySource;
  if (!source) return []; // 端口未注入（CLI/纯函数测试场景）：跳过检测

  const rows = await source(lookback);
  if (rows.length === 0) return [];

  // 日期降序去重取信号级锚点：「当前日」与「前一完整日」（分母基准）。
  //  Why 锚点仍取 dates[1]：无缺口时它就是「上一有值日」，与缺口填槽结果一致；
  //  有缺口时作 fallback 与留痕基准，各指标实际比较区间可独立回溯到更早的有值日
  const dates = [...new Set(rows.map(r => r.snapshot_date))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (dates.length < 2) return [];
  const currentDate = dates[0]!;
  const previousDate = dates[1]!;

  const { jumped, gapFilledKeys } = computeJumps(rows, currentDate, previousDate, threshold);
  if (jumped.length === 0) return [];

  const parts = jumped
    .map(j => `${j.key} ${j.prev}→${j.curr}（${j.delta > 0 ? "+" : ""}${j.delta}${j.from === previousDate ? "" : `，基日 ${j.from} 缺口回溯`}`)
    .join("；");

  const previousValues: Record<string, number> = {};
  const currentValues: Record<string, number> = {};
  for (const j of jumped) {
    previousValues[j.key] = j.prev;
    currentValues[j.key] = j.curr;
  }

  return [{
    type: reg.type,
    name: reg.name,
    severity: reg.severity,
    featureId: null,
    filePath: null,
    evidence: `${previousDate}→${currentDate} 单日环比 |Δ|≥${threshold}：${parts}`,
    suggestedAction: reg.suggestedAction,
    detail: {
      kind: "score_jump_snapshots",
      previousDate,
      currentDate,
      previousValues,
      currentValues,
      ...(Object.keys(gapFilledKeys).length > 0 ? { gapFilledKeys } : {}),
    },
  }];
}

/** score_jump 参与环比的指标键：五维 + 综合分 */
const SCORE_JUMP_KEYS = new Set(["D1", "D2", "D3", "D4", "D5", "overall"]);


/** hotspot_imbalance：bugfix:feature 比率失衡（窗口内 changeType 计数） */
function detectHotspotImbalance(
  commits: SignalCommitInput[],
  options: DetectOptions,
): DetectedSignal[] {
  const ratioThreshold = options.imbalanceRatio ?? 2;
  const reg = SIGNAL_REGISTRY.hotspot_imbalance;

  let bugfix = 0;
  let feature = 0;
  for (const c of commits) {
    if (c.parsed.changeType === "BugFix") bugfix++;
    else if (c.parsed.changeType === "New Feature" || c.parsed.changeType === "Feature Update") feature++;
  }

  // 窗口内 feature 数为 0 时不触发（避免小样本误报；特性文档口径是"持续 2 周"，MVP 单窗口近似）
  if (feature === 0 || bugfix / feature <= ratioThreshold) return [];

  return [{
    type: reg.type,
    name: reg.name,
    severity: reg.severity,
    featureId: null,
    filePath: null,
    evidence: `窗口内 bugfix:feature = ${bugfix}:${feature}（比率 ${(bugfix / feature).toFixed(1)} > ${ratioThreshold}）`,
    suggestedAction: reg.suggestedAction,
  }];
}
