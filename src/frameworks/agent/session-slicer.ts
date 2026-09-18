/**
 * F20260918uhuc：jsonl 对话切片器——原料层统一收集器（U2 落地）。
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
): JsonlSlice | undefined {
  if (entries.length === 0) return undefined;

  // previousSummary：最近一次 compaction entry 的 summary（跨代谱系种子）
  const latestCompaction = getLatestCompactionEntry(entries);
  const previousSummary = latestCompaction?.summary ?? undefined;

  // token 估算对齐 SDK estimateContextTokens（buildSessionContext 后累计）
  const tokensBefore = buildSessionContext(entries).messages.reduce((sum, m) => sum + estimateTokens(m), 0);

  const cutPoint = findCutPoint(entries, 0, entries.length, keepRecentTokens);
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
  return serializeConversation(messages as Parameters<typeof serializeConversation>[0]);
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
