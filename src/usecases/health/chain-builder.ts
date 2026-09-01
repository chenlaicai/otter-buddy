/**
 * ChainBuilder: 特性链构建器（Issue #398）
 *
 * 从 commit 解析结果 + F 文档构建 FeatureChain（不依赖 frontmatter from 字段——
 * 存量覆盖率仅 3.3%，冷启动策略：以 commit 中的 FID 为主数据源）。
 *
 * 五态判定（特性文档 F20260824rhib 状态机）：
 * - active:    文档 status∈{draft,proposed,design,development} ∧ 最后 commit ≤14 天
 * - stalled:   同上 ∧ 最后 commit >14 天
 * - regressed: 链上最新 N 个 commit 是 BugFix 且触碰链内 feature 引入的文件
 * - zombie:    30 天无 commit ∧ 近 30 天对话消息中 FID 出现次数 = 0
 * - orphan:    commit 的 FID 在 docs/features 找不到文档
 *
 * 优先级：orphan > zombie > regressed > stalled > active（病态优先，一次判定取最严重态）。
 */

import type { ParsedCommit } from "./commit-parser";
import type { CollectedFeatureDoc } from "./feature-doc-collector";

export type ChainState = "active" | "stalled" | "regressed" | "zombie" | "orphan";

/** 特性链（一个 FID 一条链） */
export interface FeatureChain {
  featureId: string;
  state: ChainState;
  /** 链上全部 commit（时间升序） */
  commits: Array<{
    sha: string;
    date: Date;
    message: string;
    changeType: string | null;
    filesChanged: string[];
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
}

export interface ChainBuildOptions {
  /** 现在时刻（默认 new Date()，测试可注入） */
  now?: Date;
  /** stalled 阈值天数（默认 14） */
  stalledDays?: number;
  /** zombie 阈值天数（默认 30） */
  zombieDays?: number;
  /** zombie 判定的 FID 提及计数（近 N 天消息中 FID 出现次数；默认 null=不判定提及，只看 commit 间隔。
   *  传入后：提及 >0 则不判 zombie（有人在聊它） */
  fidMentionCounts?: Map<string, number>;
}

/** commit 需要的最小字段（GitLogCollector 输出 + parseCommits 结果合并形态） */
export interface ChainCommitInput {
  sha: string;
  /** ISO 日期字符串 */
  date: string;
  message: string;
  parsed: ParsedCommit;
  filesChanged: string[];
}

// 实查（Issue #644）：docs/features 存在 41 篇 status: active 的文档（如 F20260829gvid）。
// active 不在白名单时被当终态，静默豁免病态判定（现网判定盲区）——收编为在途状态参与判定。
// 注：值域系统性归一（8 种值 + 行内注释变体）见 Issue #646 值域契约，此处为最小止血。
const ACTIVE_DOC_STATUSES = new Set(["draft", "proposed", "design", "development", "active"]);
const DAY_MS = 24 * 60 * 60 * 1000;

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
    stalledDays: options.stalledDays ?? 14,
    zombieDays: options.zombieDays ?? 30,
    fidMentionCounts: options.fidMentionCounts,
  };

  const docById = new Map(docs.map(d => [d.id, d]));
  const chains = new Map<string, FeatureChain>();

  aggregateCommits(chains, commits, docById);
  deriveChainStats(chains, ctx);
  appendDocOnlyChains(chains, docs, ctx);

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
    });
    for (const f of c.filesChanged) chain.touchFiles.add(f);
    if (c.parsed.changeType === "BugFix") chain.bugfixCount++;
  }
}

function newEmptyChain(featureId: string, doc: CollectedFeatureDoc | null): FeatureChain {
  return {
    featureId,
    state: "active",
    commits: [],
    firstSeenAt: null,
    lastCommitAt: null,
    daysSinceLastCommit: null,
    commitCount: 0,
    bugfixCount: 0,
    touchFiles: new Set<string>(),
    doc,
  };
}

/** Pass 2：时间序 + 派生计数 + 状态判定 */
function deriveChainStats(chains: Map<string, FeatureChain>, ctx: ChainCtx): void {
  for (const chain of chains.values()) {
    chain.commits.sort((a, b) => a.date.getTime() - b.date.getTime());
    chain.commitCount = chain.commits.length;
    chain.firstSeenAt = chain.commits[0]?.date ?? null;
    chain.lastCommitAt = chain.commits[chain.commits.length - 1]?.date ?? null;
    chain.daysSinceLastCommit = chain.lastCommitAt
      ? Math.floor((ctx.now.getTime() - chain.lastCommitAt.getTime()) / DAY_MS)
      : null;
    chain.state = classifyChain(chain, ctx);
  }
}

/** Pass 3：只有文档没有 commit 的 FID 也建链（doc-only 链） */
function appendDocOnlyChains(
  chains: Map<string, FeatureChain>,
  docs: CollectedFeatureDoc[],
  ctx: ChainCtx,
): void {
  for (const doc of docs) {
    if (chains.has(doc.id)) continue;
    const chain = newEmptyChain(doc.id, doc);
    chain.firstSeenAt = doc.createdAt ? new Date(doc.createdAt) : null;
    // 审视发现 3：doc-only 链无 commit，daysSinceLastCommit=null（语义准确）；
    // stalled/zombie 判定用 createdAt 自算的间隔（classifyDocOnly 内部），不经过此字段
    chain.daysSinceLastCommit = null;
    chain.state = classifyDocOnly(doc, ctx);
    chains.set(doc.id, chain);
  }
}

type ChainCtx = {
  now: Date;
  stalledDays: number;
  zombieDays: number;
  fidMentionCounts?: Map<string, number>;
};

/** 五态判定（病态优先级：orphan > zombie > regressed > stalled > active） */
function classifyChain(chain: FeatureChain, ctx: ChainCtx): ChainState {
  // orphan：commit 的 FID 无文档
  if (!chain.doc) return "orphan";

  const inFlight = ACTIVE_DOC_STATUSES.has(chain.doc.status ?? "draft");

  if (isZombie(chain, ctx)) return "zombie";
  if (inFlight && isRegressed(chain)) return "regressed";
  if (inFlight && idleOver(chain.daysSinceLastCommit, ctx.stalledDays)) return "stalled";

  return "active";
}

function idleOver(days: number | null, threshold: number): boolean {
  const idle = days ?? Number.POSITIVE_INFINITY;
  return idle > threshold;
}

/** zombie：在途 ∧ ≥zombieDays 无 commit ∧ 提及 Map 显式记录为 0（未传 Map / Map 无此 key = 未查询，不判——冷启动安全） */
function isZombie(chain: FeatureChain, ctx: ChainCtx): boolean {
  if (!ACTIVE_DOC_STATUSES.has(chain.doc?.status ?? "draft")) return false;
  const idle = chain.daysSinceLastCommit ?? Number.POSITIVE_INFINITY;
  if (idle < ctx.zombieDays) return false;
  const counts = ctx.fidMentionCounts;
  if (!counts?.has(chain.featureId)) return false;  // 未查询不判（区分"查过 0 次"与"没查"）
  return counts.get(chain.featureId) === 0;
}

/** regressed：最新 commit 是 BugFix 且它触碰的文件在本链更早 commit 中出现过（窄门：文件交集即证据） */
function isRegressed(chain: FeatureChain): boolean {
  if (chain.commits.length < 2) return false;
  const last = chain.commits[chain.commits.length - 1];
  if (last.changeType !== "BugFix") return false;
  const priorFiles = new Set(chain.commits.slice(0, -1).flatMap(c => c.filesChanged));
  return last.filesChanged.some(f => priorFiles.has(f));
}

/** doc-only 链（无 commit）的状态：文档在途但从未有 commit → stalled/zombie 判定 */
function classifyDocOnly(doc: CollectedFeatureDoc, ctx: ChainCtx): ChainState {
  const status = doc.status ?? "draft";
  if (!ACTIVE_DOC_STATUSES.has(status)) return "active"; // 终态文档（implemented 等）视为稳定

  const createdDays = doc.createdAt
    ? Math.floor((ctx.now.getTime() - new Date(doc.createdAt).getTime()) / DAY_MS)
    : 0;
  const counts = ctx.fidMentionCounts;
  const queried = counts?.has(doc.id) ?? false;  // 区分"查过 0 次"与"没查"
  const zeroMention = queried && counts!.get(doc.id) === 0;

  if (createdDays >= ctx.zombieDays && zeroMention) return "zombie";
  if (createdDays > ctx.stalledDays) return "stalled";
  return "active";
}
