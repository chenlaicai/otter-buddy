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
}

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
  signals.push(...detectChainStall(chains));
  signals.push(...detectHotspot(inWindow, options));
  signals.push(...detectBehaviorDefect(healingEvents, options));
  signals.push(...detectHotspotImbalance(inWindow, options));

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
  const byModuleFile = new Map<string, { module: string; file: string; shas: string[]; dates: Date[] }>();

  for (const c of commits) {
    if (c.parsed.changeType !== "BugFix" || !c.parsed.module) continue;
    const date = new Date(c.date);
    const recurrenceStart = new Date(now.getTime() - windowDays * DAY_MS);
    if (date < recurrenceStart) continue;

    for (const file of c.filesChanged) {
      const key = `${c.parsed.module}\u0000${file}`;
      let entry = byModuleFile.get(key);
      if (!entry) {
        entry = { module: c.parsed.module, file, shas: [], dates: [] };
        byModuleFile.set(key, entry);
      }
      entry.shas.push(c.sha.slice(0, 8));
      entry.dates.push(date);
    }
  }

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
      });
    }
  }
  return signals;
}

/** chain_stall：特性链滞留（复用 ChainBuilder 的 stalled/zombie 判定） */
function detectChainStall(chains: FeatureChain[]): DetectedSignal[] {
  const reg = SIGNAL_REGISTRY.chain_stall;
  return chains
    .filter(c => c.state === "stalled" || c.state === "zombie")
    .map(c => ({
      type: reg.type,
      name: reg.name,
      severity: reg.severity,
      featureId: c.featureId,
      filePath: null,
      evidence: c.state === "zombie"
        ? `${c.featureId} 僵尸链：30 天无 commit 且近 30 天对话零提及（doc status=${c.doc?.status ?? "?"}）`
        : `${c.featureId} 滞留 ${c.daysSinceLastCommit} 天无 commit（doc status=${c.doc?.status ?? "?"}）`,
      suggestedAction: reg.suggestedAction,
    }));
}

/** hotspot：文件修改次数超阈值（窗口内全类型 commit 计数） */
function detectHotspot(
  commits: SignalCommitInput[],
  options: DetectOptions,
): DetectedSignal[] {
  const threshold = options.hotspotThreshold ?? 10;
  const reg = SIGNAL_REGISTRY.hotspot;

  const fileCounts = new Map<string, number>();
  for (const c of commits) {
    for (const f of c.filesChanged) {
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

/** behavior_defect：同一 errorType healing event 复发（复用 HealingCollector 聚合） */
function detectBehaviorDefect(
  healingEvents: CollectedHealingEvent[],
  options: DetectOptions,
): DetectedSignal[] {
  const threshold = options.recurrenceThreshold ?? 3;
  const reg = SIGNAL_REGISTRY.behavior_defect;

  const byType = new Map<string, string[]>();
  for (const e of healingEvents) {
    if (!byType.has(e.errorType)) byType.set(e.errorType, []);
    byType.get(e.errorType)!.push(e.id);
  }

  const signals: DetectedSignal[] = [];
  for (const [errorType, ids] of byType) {
    if (ids.length >= threshold) {
      signals.push({
        type: reg.type,
        name: reg.name,
        severity: reg.severity,
        featureId: null,
        filePath: null,
        evidence: `errorType=${errorType} 复发 ${ids.length} 次（阈值 ${threshold}）`,
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
