/**
 * ChainBuilder: 特性链构建器（Issue #398）
 *
 * 从 commit 解析结果 + F 文档构建 FeatureChain（不依赖 frontmatter from 字段——
 * 存量覆盖率仅 3.3%，冷启动策略：以 commit 中的 FID 为主数据源）。
 *
 * F20260902sigm 链路信号模型重构（docStatus 退役）：
 * - 判据 100% 来自 git/PR 事实，零字段消费（feature 文档 status 不再参与判定）
 * - state 四值：active / stalled（=pr-stalled 投影）/ regressed / orphan
 * - zombie 删除（链是开放结构，不预言未来）；doc-only 判死删除（零 commit 是常态）
 * - signals 信号清单可叠加（挂几个报几个）；state 是 signals 的兼容投影（Phase 2 收敛）
 *
 * 信号定义：
 * - pr-stalled: 链上存在 open PR ∧ 该 PR >7 天无推进（无新 commit/review/comment）
 * - regressed:  链最新 commit 是 BugFix 且触碰链内更早 commit 引入的文件（无 inFlight 前提，
 *               合入后修 bug 恰是最常见的回退场景——T4 修复漏报）
 * - doc-gap:    合入 commit 的 FID 在 docs/features 无文档（原 orphan 定义不变）
 */

import type { ParsedCommit } from "./commit-parser";
import type { CollectedFeatureDoc } from "./feature-doc-collector";
import type { OpenPrInfo } from "./pr-collector";

export type ChainState = "active" | "stalled" | "regressed" | "orphan";

/** 链路信号 id（全部实时派生，不落库） */
export type ChainSignalId = "pr-stalled" | "regressed" | "doc-gap";

/** 单条链路信号（事实 + 证据） */
export interface ChainSignal {
  id: ChainSignalId;
  /** 人类可读证据（确定性事实，无生命周期叙事） */
  evidence: string;
  /** pr-stalled：停滞的 open PR 明细 */
  stalledPrs?: Array<{ number: number; url: string | null; daysSinceActivity: number }>;
  /** regressed：触发判定的 BugFix commit */
  regressedBy?: { sha: string; filesTouched: number };
}

/** 特性链（一个 FID 一条链） */
export interface FeatureChain {
  featureId: string;
  state: ChainState;
  /** 信号清单（可叠加；state 是兼容投影——stalled↔pr-stalled / regressed↔regressed / orphan↔doc-gap / active↔[]） */
  signals: ChainSignal[];
  /** 链上全部 commit（时间升序） */
  commits: Array<{
    sha: string;
    date: Date;
    message: string;
    changeType: string | null;
    filesChanged: string[];
    /** PR 号（commit 尾部 (#N) 解析；无则 null）。#646 推进器高置信归档判定用 */
    prNumber: number | null;
  }>;
  /** 首次出现（链上最早 commit 日期），orphan 链可能无文档 createdAt */
  firstSeenAt: Date | null;
  /** 最后活动（链上最新 commit 日期） */
  lastCommitAt: Date | null;
  /** 距最后活动的天数（now - lastCommitAt） */
  daysSinceLastCommit: number | null;
  /** 链上 commit 总数 */
  commitCount: number;
  /** BugFix commit 数 */
  bugfixCount: number;
  /** 链触碰过的文件集合（regressed 判定用） */
  touchFiles: Set<string>;
  /** 关联文档（orphan 时为 null） */
  doc: CollectedFeatureDoc | null;
  /** 链上 view 失败的 open PR 数（观测性：降级时可观测） */
  unknownPrCount: number;
}

export interface ChainBuildOptions {
  /** 现在时刻（默认 new Date()，测试可注入） */
  now?: Date;
  /** pr-stalled 阈值天数（默认 7——open PR 是显式开放的工作，7 天零 review 零 commit 即值得提醒） */
  stalledPrDays?: number;
  /** open PR 数据（PrCollector 采集；缺省时 pr-stalled 信号缺席——检测器缺失 ≠ 系统健康） */
  openPrs?: OpenPrInfo[];
}

/** commit 需要的最小字段（GitLogCollector 输出 + parseCommits 的结果合并形态） */
export interface ChainCommitInput {
  sha: string;
  /** ISO 日期字符串 */
  date: string;
  message: string;
  parsed: ParsedCommit;
  filesChanged: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 默认 pr-stalled 判定阈值（天）。Issue #636 B4 语义延续：展示层文案引用同一真相源，防两处漂移。
 *  F20260902sigm：语义从「commit 停滞 14 天」改为「open PR 无推进 7 天」——open PR 是显式
 *  开放的工作，7 天零 review 零 commit 即值得提醒（方案 R7，options 可配） */
export const DEFAULT_STALLED_PR_DAYS = 7;

/**
 * 构建全部特性链
 * @param commits commit 列表（任意顺序，内部按日期排序）
 * @param docs F 文档列表（FeatureDocCollector 输出）
 */
export function buildFeatureChains(
  commits: ChainCommitInput[],
  docs: CollectedFeatureDoc[],
  options: ChainBuildOptions = {},
): FeatureChain[] {
  const ctx = {
    now: options.now ?? new Date(),
    stalledPrDays: options.stalledPrDays ?? DEFAULT_STALLED_PR_DAYS,
    prsByFid: groupPrsByFid(options.openPrs ?? []),
  };

  const docById = new Map(docs.map(d => [d.id, d]));
  const chains = new Map<string, FeatureChain>();

  aggregateCommits(chains, commits, docById);
  deriveChainStats(chains, ctx);
  appendDocOnlyChains(chains, docs);

  return [...chains.values()];
}

/** Pass 1：按 FID 聚合 commit（无 FID 的跳过） */
function aggregateCommits(
  chains: Map<string, FeatureChain>,
  commits: ChainCommitInput[],
  docById: Map<string, CollectedFeatureDoc>,
): void {
  for (const c of commits) {
    const fid = c.parsed.featureId;
    if (!fid) continue;

    let chain = chains.get(fid);
    if (!chain) {
      chain = newEmptyChain(fid, docById.get(fid) ?? null);
      chains.set(fid, chain);
    }

    chain.commits.push({
      sha: c.sha,
      date: new Date(c.date),
      message: c.message,
      changeType: c.parsed.changeType,
      filesChanged: c.filesChanged,
      prNumber: c.parsed.prNumber,
    });
    for (const f of c.filesChanged) chain.touchFiles.add(f);
    if (c.parsed.changeType === "BugFix") chain.bugfixCount++;
  }
}

function newEmptyChain(featureId: string, doc: CollectedFeatureDoc | null): FeatureChain {
  return {
    featureId,
    state: "active",
    signals: [],
    commits: [],
    firstSeenAt: null,
    lastCommitAt: null,
    daysSinceLastCommit: null,
    commitCount: 0,
    bugfixCount: 0,
    touchFiles: new Set<string>(),
    doc,
    unknownPrCount: 0,
  };
}

type ChainCtx = {
  now: Date;
  stalledPrDays: number;
  prsByFid: Map<string, OpenPrInfo[]>;
};

/** open PR 按 FID 分组（一对多：跨链 PR 挂到每条命中链） */
function groupPrsByFid(prs: OpenPrInfo[]): Map<string, OpenPrInfo[]> {
  const map = new Map<string, OpenPrInfo[]>();
  for (const pr of prs) {
    for (const fid of pr.featureIds) {
      const list = map.get(fid);
      if (list) list.push(pr);
      else map.set(fid, [pr]);
    }
  }
  return map;
}

/** Pass 2：时间序 + 派生计数 + 信号判定 + state 投影 */
function deriveChainStats(chains: Map<string, FeatureChain>, ctx: ChainCtx): void {
  for (const chain of chains.values()) {
    chain.commits.sort((a, b) => a.date.getTime() - b.date.getTime());
    chain.commitCount = chain.commits.length;
    chain.firstSeenAt = chain.commits[0]?.date ?? null;
    chain.lastCommitAt = chain.commits[chain.commits.length - 1]?.date ?? null;
    chain.daysSinceLastCommit = chain.lastCommitAt
      ? Math.floor((ctx.now.getTime() - chain.lastCommitAt.getTime()) / DAY_MS)
      : null;
    chain.signals = classifySignals(chain, ctx);
    chain.state = projectState(chain);
  }
}

/** Pass 3：只有文档没有 commit 的 FID 也建链（doc-only 链）——稳定，无信号（F20260902sigm R6） */
function appendDocOnlyChains(
  chains: Map<string, FeatureChain>,
  docs: CollectedFeatureDoc[],
): void {
  for (const doc of docs) {
    if (chains.has(doc.id)) continue;
    const chain = newEmptyChain(doc.id, doc);
    chain.firstSeenAt = doc.createdAt ? new Date(doc.createdAt) : null;
    // doc-only 链无 commit，daysSinceLastCommit=null（语义准确）；零 commit 是本仓常态而非病态
    chain.daysSinceLastCommit = null;
    chains.set(doc.id, chain);
  }
}

/** 信号判定（可叠加）：pr-stalled / regressed / doc-gap */
function classifySignals(chain: FeatureChain, ctx: ChainCtx): ChainSignal[] {
  const signals: ChainSignal[] = [];

  // doc-gap：commit 的 FID 无文档（方案原名 orphan，信号名按「引用缺口」收编）
  if (!chain.doc) {
    signals.push({
      id: "doc-gap",
      evidence: `commit 提及 ${chain.featureId} 但 docs/features 未找到对应特性文档（${chain.commitCount} commits 无引用）`,
    });
  }

  // regressed：最新 commit 是 BugFix 且触碰链内更早 commit 引入的文件（窄门：文件交集即证据）
  // F20260902sigm T4：删除 inFlight 前提——合入后修 bug 恰是最常见的回退场景，不再漏报
  const regressed = findRegressed(chain);
  if (regressed) {
    signals.push({
      id: "regressed",
      evidence: `链尾出现 BugFix ${regressed.sha.slice(0, 8)} 触碰 ${regressed.filesTouched} 个链内文件`,
      regressedBy: regressed,
    });
  }

  // pr-stalled：链上存在 open PR ∧ 超过阈值天数无推进（commit/review/comment 全静默）
  const stalled = findPrStalled(chain, ctx);
  if (stalled) {
    signals.push(stalled);
  }

  return signals;
}

/** state = signals 的兼容投影（Phase 2 待 web 消费完全切换后收敛删除） */
function projectState(chain: FeatureChain): ChainState {
  if (chain.signals.some(s => s.id === "doc-gap")) return "orphan";
  if (chain.signals.some(s => s.id === "regressed")) return "regressed";
  if (chain.signals.some(s => s.id === "pr-stalled")) return "stalled";
  return "active";
}

/** regressed 证据：最新 commit 是 BugFix ∧ 触碰链内更早 commit 的文件集 */
function findRegressed(chain: FeatureChain): { sha: string; filesTouched: number } | null {
  if (chain.commits.length < 2) return null;
  const last = chain.commits[chain.commits.length - 1]!;
  if (last.changeType !== "BugFix") return null;
  const priorFiles = new Set(chain.commits.slice(0, -1).flatMap(c => c.filesChanged));
  const touched = last.filesChanged.filter(f => priorFiles.has(f));
  if (touched.length === 0) return null;
  return { sha: last.sha, filesTouched: touched.length };
}

/** pr-stalled 判定：链上 open PR 的 lastActivity 距今超过阈值。viewFailed PR 不参与判定但计数可观测 */
function findPrStalled(chain: FeatureChain, ctx: ChainCtx): ChainSignal | null {
  const prs = ctx.prsByFid.get(chain.featureId);
  if (!prs || prs.length === 0) return null;

  // viewFailed PR：不参与停滞判定（未知数据不猜），但计数可观测
  const unknownCount = prs.filter(pr => pr.viewFailed).length;
  chain.unknownPrCount += unknownCount;

  // 只对 view 成功的 PR 判定停滞
  const stalled = prs
    .filter(pr => !pr.viewFailed)
    .map(pr => ({ pr, days: daysSince(pr.lastActivityAt, ctx.now) }))
    .filter(({ days }) => days !== null && days > ctx.stalledPrDays);
  if (stalled.length === 0) return null;

  const detail = stalled.map(({ pr, days }) => ({
    number: pr.number,
    url: pr.url,
    daysSinceActivity: days!,
  }));
  const list = detail.map(d => `#${d.number}（${d.daysSinceActivity} 天无推进）`).join("、");
  return {
    id: "pr-stalled",
    evidence: `open PR ${list} 超过 ${ctx.stalledPrDays} 天无新 commit/review/comment`,
    stalledPrs: detail,
  };
}

/** ISO 时间距今天数（null/非法时间 → null：无 lastActivity 数据时不猜） */
function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / DAY_MS);
}
