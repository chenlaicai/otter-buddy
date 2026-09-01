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
import { detectPostMergeFixDensity } from "./post-merge-fix-density";

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
  detail?: SignalDetail;
  /** 置信度（Issue #644）：low = 大概率误报（如「干完没归档」的滞留），UI 折叠收纳不进主警报区。
   *  未标注 = normal（默认，走正常警报）。 */
  confidence?: SignalConfidence;
}

/** bug_recurrence 的结构化证据：窗口内该文件的全类型 commit 序列（时间升序） */
export interface BugRecurrenceDetail {
  kind: "bug_recurrence_commits";
  /** 窗口天数（重算口径的一部分，滑动窗口整体覆盖） */
  windowDays: number;
  /** 窗口内触碰该文件的全部 commit（不只 bugfix——交替节奏需要全类型） */
  commits: Array<SignalDetailCommit>;
}

/** post_merge_fix_density 的结构化证据（Issue #647：合并后修复密度，含高扇入排除清单） */
export interface PostMergeFixDensityDetail {
  kind: "post_merge_fix_density";
  /** 合入时刻（FID 最后 main commit，squash 流近似） */
  mergedAt: string;
  /** 分档窗口天数（按链规模：≤10→14天 / ≤30→21天 / 其他→30天） */
  windowDays: number;
  /** 窗口内触碰链文件（排除后）的 bugfix commit */
  fixCommits: Array<SignalDetailCommit>;
  /** 占比分母：窗口内触碰链文件（排除后）的全部相关 commit 数 */
  totalRelatedCommits: number;
  /** 占比（fixCommits.length / totalRelatedCommits） */
  fixRatio: number;
  /** 高扇入排除清单（不参与链级计数——清单可见不黑箱，文件级出血由 bug_recurrence 兜底） */
  excludedHighFaninFiles: string[];
}

/** 结构化证据联合（按 kind 判别；新增信号类型在此扩展） */
export type SignalDetail = BugRecurrenceDetail | PostMergeFixDensityDetail;

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
  /** behavior_defect 窗口天数（healing 事件只统计窗口内的，默认 7；Issue #645 窗口化升级）。
   *  命名对齐 rhi-scan-worker 的 windowDays 先例（信号检测窗口天数的既有叫法） */
  behaviorWindowDays?: number;
  /** behavior_defect 触发次数（同 errorType 窗口内，默认 3；独立于 recurrenceThreshold——
   *  两检测器阈值语义不同源，共用参数会在调参时互相牵连） */
  behaviorThreshold?: number;
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
export function detectSignals(
  commits: SignalCommitInput[],
  chains: FeatureChain[],
  healingEvents: CollectedHealingEvent[],
  options: DetectOptions = {},
): DetectedSignal[] {
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
  // Issue #647：合并后修复密度（链级「哪个特性不对劲」——高扇入排除后）。
  // 用全量 commits 而非 inWindow：合入窗口的右端点是链各自的合入时刻，不随检测窗口滑动
  signals.push(...detectPostMergeFixDensity(commits, chains, { now }));

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

/** chain_stall：特性链滞留（复用 ChainBuilder 的 stalled/zombie 判定）。Issue #645：
 *  zombie 分支升级为阶梯分档（severity/evidence/action 按天数分档，见 zombieLadder），
 *  stalled 分支保持 #644 规则甲语义不变 */
function detectChainStall(chains: FeatureChain[], now: Date): DetectedSignal[] {
  return chains
    .filter(c => c.state === "stalled" || c.state === "zombie")
    // Why: draft/proposed 文档从未有 commit 是常态（孤儿文档），不应触发 critical 信号
    .filter(c => {
      if (c.commitCount === 0 && DOC_NEVER_STARTED_STATUSES.has(c.doc?.status ?? "draft")) return false;
      return true;
    })
    .map(c => (c.state === "zombie" ? zombieLadderSignal(c, now) : stalledSignal(c, now)));
}

/** 滞留天数：有 commit 用 daysSinceLastCommit；doc-only 链（null）用 createdAt 自算 */
function stallDaysOf(c: FeatureChain, now: Date): number | null {
  return c.daysSinceLastCommit ?? (
    c.doc?.createdAt
      ? Math.floor((now.getTime() - new Date(c.doc.createdAt).getTime()) / DAY_MS)
      : null
  );
}

/** stalled 分支（#644 置信规则甲）：stalled ∧ 有 commit → low（大概率「干完没归档」误报） */
function stalledSignal(c: FeatureChain, now: Date): DetectedSignal {
  const reg = SIGNAL_REGISTRY.chain_stall;
  const stallDays = stallDaysOf(c, now);
  const confidence: SignalConfidence = c.commitCount > 0 ? "low" : "normal";
  return {
    type: reg.type,
    name: reg.name,
    severity: reg.severity,
    featureId: c.featureId,
    filePath: null,
    evidence: `${c.featureId} 滞留 ${stallDays} 天无 commit（doc status=${c.doc?.status ?? "?"}）`,
    suggestedAction: reg.suggestedAction,
    confidence,
  };
}

/** zombie 分支：阶梯分档（#645）+ normal 置信（#644：30 天无 commit 且零提及更接近真异常） */
function zombieLadderSignal(c: FeatureChain, now: Date): DetectedSignal {
  const reg = SIGNAL_REGISTRY.chain_stall;
  const days = stallDaysOf(c, now);
  const ladder = zombieLadder(days);
  return {
    type: reg.type,
    name: reg.name,
    severity: ladder.severity,
    featureId: c.featureId,
    filePath: null,
    evidence: `${c.featureId} 僵尸链（${ladder.label}）：${ladder.days} 天无 commit 且近 30 天对话零提及（doc status=${c.doc?.status ?? "?"}）`,
    suggestedAction: ladder.suggestedAction,
    confidence: "normal",
  };
}

/** 僵尸链阶梯（Issue #645）：30-60 黄（warning）/ 60-90 红（critical）/ ≥90 建议归档。
 *  现状是二值判定（zombie=30 天 critical），阶梯后每日任务可按 severity 自动路由：
 *  warning → 观察，critical → 复盘，≥90 → 拆归档 issue。边界口径：[30,60) 黄 /
 *  [60,90) 红 / ≥90 归档档（仍为 critical，evidence 与 suggestedAction 升级为归档语义）。
 *  isZombie 保证进来的链 ≥zombieDays（默认 30）；<60 全部落黄档（防御性兜底，含
 *  doc-only 链 createdAt 缺失致 stallDays=null 的极端情况）。 */
function zombieLadder(
  stallDays: number | null,
): { severity: "warning" | "critical"; label: string; days: number; suggestedAction: string } {
  const days = stallDays ?? 0;
  if (days < 60) {
    return {
      severity: "warning",
      label: "黄档 30-60 天",
      days,
      suggestedAction: "观察或链复盘：确认是暂停还是废弃",
    };
  }
  if (days < 90) {
    return {
      severity: "critical",
      label: "红档 60-90 天",
      days,
      suggestedAction: "强制链复盘：90 天内归档或重启，否则进入归档档",
    };
  }
  return {
    severity: "critical",
    label: `归档档 ≥90 天`,
    days,
    suggestedAction: `建议归档：创建归档 issue 并将 F-doc status 置为 archived（${days} 天无活动，每日任务可自动拆 issue）`,
  };
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

/** behavior_defect：同一 errorType healing event 复发（Issue #645 窗口化升级）。
 *  Why 窗口化而非全量聚合：healing 库 degenerate 57 次/12 天是全库最高频模式，
 *  全量聚合下它永久占用警报位，无法区分「历史遗留」与「最近在恶化」——升级后
 *  同型 ≥3 次/7 天才报，第一天就会对 degenerate 报警（这正是本项的存在意义）。 */
function detectBehaviorDefect(
  healingEvents: CollectedHealingEvent[],
  options: DetectOptions,
  now: Date,
): DetectedSignal[] {
  const threshold = options.behaviorThreshold ?? 3;
  const windowDays = options.behaviorWindowDays ?? 7;
  const windowStart = new Date(now.getTime() - windowDays * DAY_MS);
  const reg = SIGNAL_REGISTRY.behavior_defect;

  // key: errorType -> 窗口内事件（时间升序，聚合按时间排序——趋势证据可见）
  const byType = new Map<string, CollectedHealingEvent[]>();
  for (const e of healingEvents) {
    const createdAt = new Date(e.createdAt);
    // 审视 A2：Invalid Date 的 valueOf()=NaN，NaN < x 恒 false——直接比较拦不住非法时间，
    // 必须显式 Number.isFinite 拦截（非法时间事件不进窗口，否则排序 comparator 返回 NaN 顺序不定）
    const t = createdAt.getTime();
    if (!Number.isFinite(t) || t < windowStart.getTime()) continue; // 窗口外/非法时间不参与
    let list = byType.get(e.errorType);
    if (!list) {
      list = [];
      byType.set(e.errorType, list);
    }
    list.push(e);
  }
  for (const list of byType.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  const signals: DetectedSignal[] = [];
  for (const [errorType, events] of byType) {
    if (events.length >= threshold) {
      const first = events[0]!;
      const last = events[events.length - 1]!;
      signals.push({
        type: reg.type,
        name: reg.name,
        severity: reg.severity,
        featureId: null,
        filePath: null,
        evidence: `errorType=${errorType} ${windowDays} 天内复发 ${events.length} 次（阈值 ${threshold}，${first.createdAt.slice(0, 10)} ~ ${last.createdAt.slice(0, 10)}）`,
        suggestedAction: reg.suggestedAction,
      });
    }
  }
  return signals;
}

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
