/**
 * F20260920uhuc：jsonl 对话切片器——原料层统一收集器（U2 落地）。
 *
 * U2 验证结论：SDK `prepareCompaction` 未从主入口导出（index.d.ts 导出清单核实；
 * package.json exports 仅开放 `.` 根入口，深路径导入被 Node ESM 拦截）——按方案预判
 * 的降级路径自实现同款切片：用已导出的 findCutPoint + serializeConversation +
 * estimateTokens + buildSessionContext + sessionEntryToContextMessages 组合，
 * 算法与 SDK compaction.js prepareCompaction 逐行对齐。
 *
 * 权威源：session jsonl（agent 视角完整记录——搭档消息、獭回应、工具调用与结果）。
 * 旧文件在重启/交接时仍在磁盘上，SessionManager.open() 只读加载即可取 entries。
 */

import {
  findCutPoint,
  estimateTokens,
  buildSessionContext,
  sessionEntryToContextMessages,
  getLatestCompactionEntry,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/** AgentMessage 最小结构面（SDK 类型来自 pi-agent-core 转依赖，不深路径 import——
 *  结构兼容：sessionEntryToContextMessages 的返回值满足本形状即可流转） */
export type SlicerMessage = { role: string; content?: unknown };

/** SDK 默认 keepRecentTokens = 20000（对齐 Pi 原地压缩的保留窗口） */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * F20260928keep：中文场景密度校准常数（chars/token）。
 *
 * 定标快照（2026-09-28，数据源 data/sessions/ 9/24-9/28 至 69 个 jsonl，差分法脚本
 * data/workspaces/f4982c33-.../density_final.py 可复现）：相邻带 usage 轮差分
 * n=524，density(chars/token) p10=0.45 p50=1.89 p90=3.42，加权总密度 1.248；
 * 分层：消息层 p50=1.97 / toolish 层 p50=0.81。取 1.25 与加权总密度吻合
 * （「总体平均恰好达标」的常数）。低密度尾部（code/JSON 重内容 ρ≈0.45）
 * 超预算为已知风险，观测锚（slice 日志 + 密度告警）兕底。
 *
 * 用法：sliceSessionEntries 传给 SDK findCutPoint 的预算换算为
 * round(keepRecentTokens × OTTER_CHARS_PER_TOKEN / 4)——SDK estimateTokens 是
 * chars/4 常数线性估计器，预算对其单调，换算后停刀位置 ⟺ divisor=1.25 直计
 * （Σchars ≤ 20,000×1.25 = 25,000，差异仅 per-message ceil 舍入）。
 */
export const OTTER_CHARS_PER_TOKEN = 1.25;

/** 切片产出（对齐 SDK CompactionPreparation 的最小消费面） */
export interface JsonlSlice {
  /** 保留窗口起点 entry id（firstKeptEntryId——近期保留段从这开始） */
  firstKeptEntryId: string | undefined;
  /** 待压缩的对话历史（即将丢弃的段——叙事合成的原料） */
  messagesToSummarize: SlicerMessage[];
  /** 切点是否在 turn 中间（split turn 的前缀消息也并入压缩原料） */
  turnPrefixMessages: SlicerMessage[];
  isSplitTurn: boolean;
  /** 上一代压缩摘要（jsonl 内最近 compaction entry 的 summary——谱系继承用） */
  previousSummary: string | undefined;
  /** 切片前上下文 token 估算（日志/观测用） */
  tokensBefore: number;
  /** 近期保留段 entries（firstKept 之后——序列化注入新世） */
  keptEntries: SessionEntry[];
}

/**
 * 从 session entries 算统一切片（对齐 SDK prepareCompaction 语义）。
 *
 * 与 SDK 的差异（有意为之）：
 * - SDK 版 boundaryStart 从上次 compaction entry 起算（原地压缩迭代）；本切片器
 *   场景是「整世封存」——上一世 jsonl 内若有多代 compaction，全部历史都属于前世
 *   档案范畴，boundaryStart 恒 0，previousSummary 取最近一次 compaction 的 summary
 *   （谱系继承的种子）。
 * - 无可压缩消息时返回 undefined（调用方走 synthesizePast=false 或降级路径）。
 */
export function sliceSessionEntries(
  entries: SessionEntry[],
  keepRecentTokens: number = DEFAULT_KEEP_RECENT_TOKENS,
  options?: { scopeKey?: string },
): JsonlSlice | undefined {
  if (entries.length === 0) return undefined;

  // previousSummary：最近一次 compaction entry 的 summary（跨代谱系种子）
  const latestCompaction = getLatestCompactionEntry(entries);
  const previousSummary = latestCompaction?.summary ?? undefined;

  // token 估算对齐 SDK estimateContextTokens（buildSessionContext 后累计）
  const tokensBefore = buildSessionContext(entries).messages.reduce((sum, m) => sum + estimateTokens(m), 0);

  // F20260928keep 改动点1：预算线性换算——estimateTokens 是 chars/4 常数线性估计器，
  // 预算对其单调，传 round(keepRecentTokens × 1.25 / 4) 等效 divisor=1.25 直计 20K
  // （停刀于 Σchars ≈ 25,000，SDK 全部边界语义自动继承，零移植风险。
  // 等效性证明与 ±1 消息容差实测见方案文档「定标过程」节与测试 2）
  const sdkBudgetTokens = Math.round((keepRecentTokens * OTTER_CHARS_PER_TOKEN) / 4);

  const cutPoint = findCutPoint(entries, 0, entries.length, sdkBudgetTokens);
  const firstKeptEntry = entries[cutPoint.firstKeptEntryIndex];
  const firstKeptEntryId = firstKeptEntry?.id;

  // 待压缩段：boundaryStart(0) → historyEnd（split turn 时含 turn prefix）
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize = collectMessages(entries, 0, historyEnd);
  const turnPrefixMessages = cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0
    ? collectMessages(entries, cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
    : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

  // 近期保留段：firstKeptEntryIndex 起到末尾
  const keptEntries = entries.slice(cutPoint.firstKeptEntryIndex);

  // F20260928keep 改动点2：切片观测锚（频次低——仅重启獭生/压缩时触发，不添噪）
  logKeepRecentSlice({
    total: entries.length,
    cutIndex: cutPoint.firstKeptEntryIndex,
    keptChars: keptEntries.reduce((sum, e) => sum + entryTextChars(e), 0),
    divisor: OTTER_CHARS_PER_TOKEN,
    budgetChars: Math.round(keepRecentTokens * OTTER_CHARS_PER_TOKEN),
    rule: "linear-convert",
    measuredDensity: measureTailDensity(entries),
    scopeKey: options?.scopeKey,
  });

  return {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    previousSummary,
    tokensBefore,
    keptEntries,
  };
}

/** [from, to) 区间的 context messages（compaction entry 跳过） */
function collectMessages(entries: SessionEntry[], from: number, to: number): SlicerMessage[] {
  const out: SlicerMessage[] = [];
  for (let i = from; i < to; i++) {
    const msg = messageFromEntry(entries[i]);
    if (msg) out.push(msg);
  }
  return out;
}

/** entry → context message（对齐 SDK getMessageFromEntryForCompaction：compaction entry 跳过） */
function messageFromEntry(entry: SessionEntry): SlicerMessage | undefined {
  if (entry.type === 'compaction') return undefined;
  return sessionEntryToContextMessages(entry)[0];
}

// ============================================================================
// F20260928keep：观测锚 + 密度告警 + 回放节截断（改动点 2/3）
// ============================================================================

/** 日志函数注入位（frameworks 层不直接 import logger，对齐现有依赖注入模式）；生产平台在注入时接线 */
let sliceLogger: ((fields: Record<string, unknown>) => void) | undefined;

/** 测试/生产接线：注入 slice 观测日志实现 */
export function setSliceLogger(impl: ((fields: Record<string, unknown>) => void) | undefined): void {
  sliceLogger = impl;
}

/** 单个 content block 的可计 chars */
function blockTextChars(block: unknown): number {
  if (!block || typeof block !== 'object') return 0;
  const b = block as { type?: string; text?: string; thinking?: string };
  if (typeof b.text === 'string') return b.text.length;
  if (typeof b.thinking === 'string') return b.thinking.length;
  if (b.type === 'toolCall') return JSON.stringify((block as { arguments?: unknown }).arguments ?? {}).length;
  if (b.type === 'toolResult') return JSON.stringify((block as { output?: unknown }).output ?? '').length;
  return 0;
}

/** entry 的可计 chars（message content 文本 + toolCall 参数 + toolResult 输出，对齐定标脚本口径） */
function entryTextChars(entry: SessionEntry): number {
  if (entry.type !== 'message') return 0;
  const content = (entry.message as { content?: unknown }).content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => sum + blockTextChars(block), 0);
}

/** entry 的 usage 四项合计（无 usage / 非法值返回 undefined） */
function entryUsageTokens(entry: SessionEntry): number | undefined {
  if (entry.type !== 'message') return undefined;
  const u = (entry.message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } }).usage;
  if (!u || typeof u.input !== 'number' || typeof u.cacheRead !== 'number') return undefined;
  const total = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
  return total > 0 ? total : undefined;
}

/**
 * F20260928keep 改动点2：密度观测（旧 session 末尾相邻 usage 对差分）。
 *
 * 取末尾两个带 usage 的轮位：Δchars/ΔΔ(四项合计含 output) 测的正是保留段所处内容的真实密度
 * （同 session 相邻轮差分，system 基线天然扣除）。与离线定标脚本（density_final.py）
 * 的差异：脚本 Δtok 为三项不含 output——两口径在告警带宽下无功能影响，如实现注释。
 * 不足两对有效 usage 或增量过小（≤500 tokens 噪声阈）时返回 undefined（首代/短
 * session，不硬造观测值）。
 */
function measureTailDensity(entries: SessionEntry[]): number | undefined {
  const usagePoints: Array<{ chars: number; tokens: number }> = [];
  let cumulativeChars = 0;
  for (const e of entries) {
    cumulativeChars += entryTextChars(e);
    const tokens = entryUsageTokens(e);
    if (tokens !== undefined) usagePoints.push({ chars: cumulativeChars, tokens });
  }
  if (usagePoints.length < 2) return undefined;
  const last = usagePoints[usagePoints.length - 1];
  const lastPrev = usagePoints[usagePoints.length - 2];
  const dChars = last.chars - lastPrev.chars;
  const dTok = last.tokens - lastPrev.tokens;
  if (dTok <= 500 || dChars <= 0) return undefined;
  const density = dChars / dTok;
  return Number.isFinite(density) && density > 0 && density < 100 ? Number(density.toFixed(2)) : undefined;
}

/** 密度告警滚动状态（按 scope 隔离——scopeKey 默认 'default'，生产调用方传 otterId，对齐文档「每 otter 每 24h 最多 1 条」规格） */
const DENSITY_WARN_WINDOW = 5;
const DENSITY_WARN_MIN_OUT = 4;
const DENSITY_WARN_RANGE: readonly [number, number] = [0.45, 3.5];
const DENSITY_WARN_TTL_MS = 24 * 60 * 60 * 1000;
interface DensityWarnState { observations: number[]; lastWarnAt: number }
const densityWarnStates = new Map<string, DensityWarnState>();

/** 密度观测入窗口 + 告警判定（[0.45,3.5] 出界，窗口 5 次中 ≥4 次出界 → 同 scope 24h 内最多 warn 1 条） */
function recordDensityObservation(density: number | undefined, scopeKey: string): void {
  if (density === undefined) return;
  const state = densityWarnStates.get(scopeKey) ?? { observations: [], lastWarnAt: 0 };
  densityWarnStates.set(scopeKey, state);
  state.observations.push(density);
  if (state.observations.length > DENSITY_WARN_WINDOW) state.observations.shift();
  if (state.observations.length < DENSITY_WARN_WINDOW) return;
  if (Date.now() - state.lastWarnAt < DENSITY_WARN_TTL_MS) return;
  const outCount = state.observations.filter(d => d < DENSITY_WARN_RANGE[0] || d > DENSITY_WARN_RANGE[1]).length;
  if (outCount >= DENSITY_WARN_MIN_OUT) {
    state.lastWarnAt = Date.now();
    sliceLogger?.({
      msg: '[keeprecent-slice] density drift warning',
      level: 'warn',
      scope: scopeKey,
      observations: [...state.observations],
      range: DENSITY_WARN_RANGE,
      hint: 'measuredDensity 连续出界——密度常数 OTTER_CHARS_PER_TOKEN 可能漂移，建议重跑定标脚本复核（F20260928keep 定标节）',
    });
  }
}

/** 切片观测日志（改动点2主锚；scopeKey 透传告警隔离域，生产传 otterId） */
function logKeepRecentSlice(fields: {
  total: number; cutIndex: number; keptChars: number; divisor: number; budgetChars: number;
  rule: string; measuredDensity: number | undefined; scopeKey?: string;
}): void {
  recordDensityObservation(fields.measuredDensity, fields.scopeKey ?? 'default');
  sliceLogger?.({
    msg: '[keeprecent-slice] cut',
    ...fields,
    keptCharsBudgetRatio: fields.budgetChars > 0 ? Number((fields.keptChars / fields.budgetChars).toFixed(2)) : undefined,
  });
}

// ============================================================================
// F20260928keep 改动点3：保留段内嵌「## 对话历史」回放节的单条超长块截断
// ============================================================================

const REPLAY_SECTION_HEADER = '## 对话历史（你上次发言后的消息）';
const REPLAY_TRUNCATE_THRESHOLD = 1_500;
const REPLAY_KEEP_HEAD = 750;
const REPLAY_KEEP_TAIL = 750;

/**
 * 截断注入 user 消息 content 内「## 对话历史」节中的超长 sender 块（头 750 + 尾 750）。
 *
 * 只在序列化前、消息 content 层处理（serializeConversation wrapper 之外）；节头标记
 * 不匹配（注入格式变化）→ 原样返回（fail-open）；正常对话消息一律不截断。
 * 尾注恒真：「原文见前世 session jsonl」——序列化先于合成成败落定，不按意图分支。
 */
function truncateReplayBlocksInContent(content: string): string {
  const headerIdx = content.indexOf(REPLAY_SECTION_HEADER);
  if (headerIdx < 0) return content;
  const headerEnd = headerIdx + REPLAY_SECTION_HEADER.length;
  const before = content.slice(0, headerEnd);
  const replay = content.slice(headerEnd);
  const lines = replay.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let sawFirstSender = false;
  for (const line of lines) {
    if (/^\[[^\]]+\]/.test(line)) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [line];
      sawFirstSender = true;
    } else if (sawFirstSender) {
      current.push(line);
    } else {
      blocks.push(line); // 节头后、首块前的 preamble（空行等），原样保留
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));

  const out = blocks.map(block => {
    if (block.length <= REPLAY_TRUNCATE_THRESHOLD || !/^\[[^\]]+\]/.test(block)) return block;
    const head = block.slice(0, REPLAY_KEEP_HEAD);
    const tail = block.slice(block.length - REPLAY_KEEP_TAIL);
    return `${head}\n…（截断 ${block.length - REPLAY_KEEP_HEAD - REPLAY_KEEP_TAIL} chars；原文见前世 session jsonl）\n${tail}`;
  });
  return before + out.join('\n');
}

/** 保留段序列化前对 user 消息 content 应用回放节截断（改动点3入口）
 *  content 兼容两种形态：string（测试直构）/ [{type:'text',text}] 数组（sessionEntryToContextMessages 真实返回） */
function applyReplayTruncation(messages: SlicerMessage[]): SlicerMessage[] {
  return messages.map(m => {
    if (m.role !== 'user') return m;
    // 提取唯一 text 块的文本（多块/非 text 块不动——fail-open）
    if (typeof m.content === 'string') {
      if (!m.content.includes(REPLAY_SECTION_HEADER)) return m;
      const truncated = truncateReplayBlocksInContent(m.content);
      return truncated === m.content ? m : { ...m, content: truncated };
    }
    if (Array.isArray(m.content) && m.content.length > 0) {
      const blocks = m.content as Array<{ type?: string; text?: string }>;
      const textBlock = blocks.find(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string');
      if (!textBlock || !textBlock.text!.includes(REPLAY_SECTION_HEADER)) return m;
      const truncated = truncateReplayBlocksInContent(textBlock.text!);
      if (truncated === textBlock.text) return m;
      const newBlocks = blocks.map(b => (b === textBlock ? { ...b, text: truncated } : b));
      return { ...m, content: newBlocks };
    }
    return m;
  });
}

/** 仅测试用：直接对消息数组应用回放节截断（绕过 slice 预算前置，单测截断规则本身） */
export function __testApplyReplayTruncation(messages: Array<{ role: string; content?: unknown }>): Array<{ role: string; content?: unknown }> {
  return applyReplayTruncation(messages as SlicerMessage[]);
}

/** 仅测试用：直接观测截断函数对单条 content 的效果 */
export function __testTruncateReplayContent(content: string): string {
  return truncateReplayBlocksInContent(content);
}

/**
 * 近期保留段序列化（新世注入用）。
 *
 * keptEntries → SlicerMessage[] → serializeConversation（SDK 导出的标准序列化——
 * 与压缩合成 prompt 里的历史序列化同款格式，新世 LLM 阅读无格式切换成本）。
 * 边界 cast：serializeConversation 参数是 SDK 完整 Message 联合类型，本模块只消费
 * 结构子集（role/content），sessionEntryToContextMessages 的真实返回值满足完整类型。
 */
export function serializeKeptWindow(slice: JsonlSlice): string {
  const messages: SlicerMessage[] = [];
  for (const entry of slice.keptEntries) {
    const msg = messageFromEntry(entry);
    if (msg) messages.push(msg);
  }
  if (messages.length === 0) return '';
  // F20260928keep 改动点3：序列化前对 user 消息 content 应用回放节单条截断
  const processed = applyReplayTruncation(messages);
  return serializeConversation(processed as Parameters<typeof serializeConversation>[0]);
}

/**
 * 读取 session jsonl 的 entries（只读——SessionManager.open 不写文件）。
 *
 * U2 的「裸用便利性」验证结论：open() 即得 getEntries()，无需私有 API；
 * 文件缺失（首哑前世/空 session）返回 undefined，调用方降级。
 */
export function readSessionEntries(sessionManager: SessionManager): SessionEntry[] | undefined {
  try {
    const entries = sessionManager.getEntries();
    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined;
  }
}
