/**
 * SignalDetector: 信号检测引擎（Issue #399）
 *
 * 输入采集层数据，输出触发的信号列表。全确定性、无 LLM。
 * 信号定义以 signal-registry 为单一真相源，本文件只实现检测逻辑。
 */

import type { ParsedCommit } from "./commit-parser";

import type { CollectedHealingEvent } from "./healing-collector";
import type { FeatureChain } from "./chain-builder";
import { detectPostMergeFixDensity } from "./post-merge-fix-density";
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
  detail?: SignalDetail;
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
  signals.push(...detectChainStall(chains));
  signals.push(...detectHotspot(inWindow, options));
  signals.push(...detectBehaviorDefect(healingEvents, options, now));
  signals.push(...detectHotspotImbalance(inWindow, options));
  // Issue #647：合并后修复密度（「哪个特性不对劲」，排除清单后；文件级 bug_recurrence 兑「哪里在出血」）
  signals.push(...detectPostMergeFixDensity({ commits: inWindow, chains, now }).signals);

  return signals;
}

/** 非逻辑载体文件：类型定义 / 装配组装 / 测试——修复「复发」计数的噪声面（#1214）。
 *  Why 排除：types.ts 等类型文件被多特性被动触碰是架构使然（类型修改必然扩散），
 *  组装/测试文件同理——它们不是「同一根因反复修」的载体，计入只会稀释信号区分度。 */
function isNonLogicCarrier(filePath: string): boolean {
  if (isTestFile(filePath)) return true;
  const base = filePath.split("/").pop() ?? "";
  // 检视发现 4：types 规则收窄到 src 根 + bootstrap/——全仓 basename 排除会误伤
  // src/frameworks/weixin/types.ts 等 runtime 常量载体（262 行含 WEIXIN_* 导出）。
  // 深层域 types.ts 不排除：纯类型文件（如 agent-turn-orchestrator/types.ts，存量信号 222）
  // 3 events 达阈时翻回触发——「类型定义反复修」达阈报警是可接受的边界形态（如实记录，非静音）
  if (/(^|\/)bootstrap\//.test(filePath)) return true;   // 启动装配目录整体（含其 types.ts）
  if (/^src\/types?\.[cm]?[jt]s$/i.test(filePath)) return true; // src 根装配类型；深层域 types.ts 不排除——见 weixin 回归锚
  // #1012 修法 c 补全：schema 演进载体——migration.ts/schema.ts 的 N 修 = N 个独立 schema 演进，
  // 被动累加非同一根因反复修（与 types/测试同属「载体噪声」，归因报告 10/23 条盲区中 4 条是它们）
  if (/^(src\/frameworks\/db\/)?(migration|schema)\.[cm]?[jt]s$/i.test(filePath)) return true;
  // 转发桶（barrel：重导出 .ts/.js）——不含 .tsx/.jsx（delta D1：web/src/pages/*/index.tsx
  // 是页面主组件不是 barrel，存量最大热点信号 5（11 事件）曾被误静音，回退并加回归锚）
  return /^index\.[cm]?(t|j)s$/i.test(base)
    || /^(platforms|usecases|main)\.[cm]?[jt]s$/i.test(base); // 组装/入口（src 根的组装文件）
}

/** #1214：触发判据——独立修复事件数（同 PR 去重 + 无 PR 号按 sha 计） */
function countDistinctEvents(entry: { prs: Set<number>; noPrShas: Set<string> }): number {
  return entry.prs.size + entry.noPrShas.size;
}

/** #1012 修法 c：severity 分级——
 *  「主体同一 issue」= 最大 issue 引用数 ≥ 窗口内事件数一半 → critical（同根因修复系列，
 *  #1160 五连 / #1207 集群形态）；跨 issue 分散 → warning（热点活跃假象）；
 *  无任何 issue 锚点 → critical（防漏报默认）。
 *  分级而非过滤：warning 仍出信号（可观察），只是不进 critical 主警报区。
 *  判据细节：prs 也计入 issueRefCounts 统计（squash 流 PR 号是唯一锚点）。「主体线」
 *  是严格过半（maxRef * 2 > events）：3 修全引用同一 issue 时主体计数 3 > 1.5 过线；
 *  「2 修同 issue + 1 修独立」混合态 2 ≤ 1.5 不过线判 warning（主体不占优即不按真
 *  腐烂报）；纯分散（各修仅带自己 PR 号）计数 1 不过线判 warning。为何用占比而非
 *  issueRefs.size：同系列 commit 各有不同 PR 号，size 口径会把同系列误判成分散（测试实证）。 */
function classifyRecurrenceSeverity(
  entry: { prs: Set<number>; noPrShas: Set<string>; shas: string[] },
  issueRefCounts: Map<number, number>,
  threshold: number,
): SignalSeverity | null {
  const events = countDistinctEvents(entry);
  if (events < threshold) return null;
  if (issueRefCounts.size === 0) return "critical"; // 无锚点默认 critical 防漏报
  const maxRef = Math.max(...issueRefCounts.values());
  if (maxRef * 2 > events) return "critical"; // 主体同一 issue（严格过半）= 同根因系列
  return "warning"; // 跨 issue 分散 / 主体不占优 = 热点活跃假象
}

/** #1214：evidence 文案——「N 个不同修复事件 + PR 清单 + 首末修复日期」语义澄清。
 *  文案分支（检视发现 3）：纯 PR / 纯无 PR / 混合三形态各自不冗余。
 *  #1012 修法 c：追加系列归因数据（关联 issue 清单），severity 判据可见。 */
function buildRecurrenceEvidence(
  entry: { module: string; file: string; prs: Set<number>; noPrShas: Set<string>; issueRefCounts: Map<number, number>; shas: string[]; dates: Date[] },
  windowDays: number,
): string {
  const events = countDistinctEvents(entry);
  const prList = [...entry.prs].sort((a, b) => a - b).map(p => `#${p}`);
  const prCount = prList.length;
  const noPrCount = entry.noPrShas.size;
  // 检视发现 3：三形态各说一次——纯 PR「PR #a, #b」；纯无 PR「N 个无 PR 号 commit」；
  // 混合「PR #a, #b + M 个无 PR 号 commit」（不再出现「无 PR 号 commit + N 个无 PR 号 commit」冗余）
  let eventText: string;
  if (prCount > 0 && noPrCount === 0) {
    eventText = `PR ${prList.join(", ")}`;
  } else if (prCount === 0 && noPrCount > 0) {
    eventText = `${noPrCount} 个无 PR 号 commit`;
  } else {
    eventText = `PR ${prList.join(", ")} + ${noPrCount} 个无 PR 号 commit`;
  }
  const times = entry.dates.map(d => d.getTime());
  const first = new Date(Math.min(...times)).toISOString().slice(0, 10);
  const last = new Date(Math.max(...times)).toISOString().slice(0, 10);
  const issueList = [...entry.issueRefCounts.keys()].sort((a, b) => a - b).map(i => `#${i}`);
  const seriesText = issueList.length > 0 ? `；关联 issue ${issueList.join(", ")}（${issueList.length} 个）` : "";
  return `[${entry.module}] ${entry.file} 窗口 ${windowDays} 天内 ${events} 个不同修复事件（${eventText}；bugfix commit ${entry.shas.length} 个，首末修复 ${first}→${last}${seriesText}）`;
}

/** bug_recurrence：同模块同文件 bugfix ≥N 个不同修复事件/窗口（窄门：不依赖语义聚类）。
 *  #1214 口径修订（承接 #1012 根因分析）：
 *  - 修复事件去重：同 PR 号的多 commit 计 1 事件；无 PR 号 commit 各计 1 事件
 *    （noPrShas 非去重——git log sha 唯一，Set 只是容器；措辞是「各计」非「去重」）。
 *    前提显式化（检视发现 5）：squash/rebase 合入使 commit message 带 (#N)——
 *    merge-commit 流的中间 commit 无 PR 号会各计 1 事件（当前 321/322 带 PR 号，
 *    若未来改 merge-commit 流需重评此口径）
 *  - 适用面如实声明（检视发现 1）：squash 惯例下「同 PR 多 commit」当前为 0 例，
 *    去重是面向多 commit PR/rebase 形态的口径正确性保障，不是本 PR 的主要收益；
 *    假聚集主形态（同一根因跨 PR 系列）由后续 severity 分级/系列归因 issue 承载
 *  - 非逻辑载体排除：types（收窄到 bootstrap 装配路径，检视发现 4——全仓
 *    basename 排除会误伤 weixin/types.ts 等 runtime 常量载体）/转发桶/组装/测试
 *  - occurrences 语义澄清：evidence 报独立修复事件数 + PR 清单 + 首末修复日期
 *  #1012 修法 c（2026-10-05）：severity 分级 + 载体排除补全——
 *  - 系列归因分级：同一 issue 反复修 ≥threshold → critical（真腐烂——#1160 五连形态）；
 *    跨 issue 分散 ≥threshold → warning（热点活跃假象）。分级而非过滤（归因报告推荐：
 *    「同一 bug 修了又坏」仅 2/23=9%，一刀切 critical 让告警失去区分度）
 *  - 载体排除补全：migration.ts/schema.ts 入非逻辑载体（schema 演进 N 修 = N 个独立演进，
 *    被动累加非根因反复——归因报告口径盲区 10 条中 4 条是它们）
 *  - 分键仍为 module+file 不变（归因报告建议改 file_path 唯一——本 PR 不动：
 *    存量 23 条中无 module 裂分实例，改动收益存疑，留给后续复核） */
function detectBugRecurrence(
  commits: SignalCommitInput[],
  options: DetectOptions,
  now: Date,
): DetectedSignal[] {
  const threshold = options.recurrenceThreshold ?? 3;
  const windowDays = options.recurrenceWindowDays ?? 30;
  const reg = SIGNAL_REGISTRY.bug_recurrence;

  // key: module + file -> bugfix PR 记录（窗口内，同 PR 去重 + 系列归因数据源）
  const byModuleFile = collectBugfixByFile(commits, now, windowDays);

  // 第二遍（Issue #644）：为触发文件收集窗口内全类型 commit，见 collectDetailCommits
  collectDetailCommits(commits, byModuleFile, new Date(now.getTime() - windowDays * DAY_MS));

  const signals: DetectedSignal[] = [];
  for (const entry of byModuleFile.values()) {
    // #1012 修法 c：分级判据——同系列达阈 critical，分散达阈 warning，未达阈不出信号
    const severity = classifyRecurrenceSeverity(entry, entry.issueRefCounts, threshold);
    if (severity !== null) {
      signals.push({
        type: reg.type,
        name: reg.name,
        severity,
        featureId: null,
        filePath: entry.file,
        evidence: buildRecurrenceEvidence(entry, windowDays),
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

/** #1214：第一遍收集——窗口内 bugfix commit 按模块/文件聚合（同 PR 去重 + 非逻辑载体排除）。
 *  从 detectBugRecurrence 拆出控复杂度（lint max-complexity）。 */
interface BugfixFileEntry {
  module: string;
  file: string;
  prs: Set<number>;              // #1214：去重后的独立 PR 集（触发判据之一）
  noPrShas: Set<string>;         // 无 PR 号的 commit（squash 前本地修复），按 sha 去重计 1 次/事件
  /** #1012 修法 c：窗口内 bugfix commit 的 issue 引用计数（系列归因数据源）。
   *  「主体同一 issue」= 同一根因修复系列（真腐烂——#1160 五连、#1207 集群实测形态）；
   *  跨 issue 分散修复是高迭代热点。
   *  Why 计数而非 Set：同一系列的 commit 各有不同 PR 号（squash 1:1），Set 口径会把
   *  同系列误判成分散；计数 + 主体占比判据才能区分。Why 不用 featureId（delta 纠错）：
   *  本仓 FID↔PR 严格 1:1（全历史实测），FID 判据 critical 分支生产不可达。 */
  issueRefCounts: Map<number, number>;
  shas: string[];
  dates: Date[];
  /** 窗口内触碰该文件的全类型 commit（bug●→fix● 交替时间轴数据源，Issue #644） */
  allCommits: SignalDetailCommit[];
}

function collectBugfixByFile(
  commits: SignalCommitInput[],
  now: Date,
  windowDays: number,
): Map<string, BugfixFileEntry> {
  const byModuleFile = new Map<string, BugfixFileEntry>();
  const recurrenceStart = new Date(now.getTime() - windowDays * DAY_MS);
  for (const c of commits) {
    if (c.parsed.changeType !== "BugFix" || !c.parsed.module) continue;
    const date = new Date(c.date);
    if (date < recurrenceStart) continue;

    // Set 防御（审视建议发现 4）：同 commit 的 filesChanged 若含重复文件名，
    // 不去重会双计 shas 抬高触发次数——当前 git --name-only 不重复，纯防御性收口
    for (const file of new Set(c.filesChanged)) {
      // #1214：非逻辑载体不参与复发计数（types/组装/测试——被动触碰非根因载体）
      if (isNonLogicCarrier(file)) continue;
      const key = `${c.parsed.module}\u0000${file}`;
      let entry = byModuleFile.get(key);
      if (!entry) {
        entry = { module: c.parsed.module, file, prs: new Set(), noPrShas: new Set(), issueRefCounts: new Map(), shas: [], dates: [], allCommits: [] };
        byModuleFile.set(key, entry);
      }
      entry.shas.push(c.sha.slice(0, 8));
      entry.dates.push(date);
      // #1214：同 PR 去重——squash 前链式修复算 1 个 PR 复发事件；无 PR 号的按 sha 计
      if (c.parsed.prNumber !== null) entry.prs.add(c.parsed.prNumber);
      else entry.noPrShas.add(c.sha);
      // #1012 修法 c：系列归因数据源——message 内 issue 引用计数（#1160 五连形态）
      for (const m of c.message.matchAll(/#(\d+)/g)) {
        const n = Number(m[1]);
        entry.issueRefCounts.set(n, (entry.issueRefCounts.get(n) ?? 0) + 1);
      }
    }
  }
  return byModuleFile;
}

/** Issue #644 第二遍收集：为已触发的 (module, file) 填充窗口内全类型 commit 序列（时间升序）。
 *  Why 全类型：只有 bugfix 画不出「引入-修复-回归-再修复」交替节奏，前端时间轴需要 changeType
 *  区分节点（观澜视觉方案 3.1）。窗口滑动时随扫描整体重算覆盖（非 append）。 */
function collectDetailCommits(
  commits: SignalCommitInput[],
  byModuleFile: Map<string, Pick<BugfixFileEntry, "allCommits"> & { allCommits: SignalDetailCommit[] }>,
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

/** chain_stall：特性链滞留（F20260902sigm：读 chain.signals 的 pr-stalled 信号——
 *  病态判据 100% 来自 PR 事实，docStatus 不再参与；zombie/doc-only 判死已删）。
 *  一个链挂多个停滞 PR 时逐条出信号（挂几个报几个，不合并不取最严重） */
function detectChainStall(chains: FeatureChain[]): DetectedSignal[] {
  const reg = SIGNAL_REGISTRY.chain_stall;
  const out: DetectedSignal[] = [];
  for (const c of chains) {
    const stalled = c.signals.find(s => s.id === "pr-stalled");
    if (!stalled) continue;
    for (const pr of stalled.stalledPrs ?? []) {
      out.push({
        type: reg.type,
        name: reg.name,
        severity: reg.severity,
        featureId: c.featureId,
        filePath: null,
        evidence: `${c.featureId} open PR #${pr.number} 已 ${pr.daysSinceActivity} 天无推进（无新 commit/review/comment）${pr.url ? `：${pr.url}` : ""}`,
        suggestedAction: reg.suggestedAction,
        // pr-stalled 是 PR 事实而非「干完没归档」猜测，不降置信
        confidence: "normal",
      });
    }
  }
  return out;
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
