/**
 * F20260929kws1：jsonl 对话切片器——保留段简化为「最近 4 条 speak」。
 *
 * 演进史（同一领域三度返工，本版为终局形态）：
 * - F20260920uhuc：自实现 SDK 同款 token 预算切片（findCutPoint 组合）。
 * - F20260928keep：中文密度校准（×1.25 预算换算 + 密度告警）——只校准不拦截。
 * - F20260929kws1（本版）：token 估算路线整体退役。生产实证（9/28 三倍超预算 #1183、
 *   9/29 保留段 12.4 万字符致 kimi-256k 换世爆窗）证明「预算弹性」在此场景是结构性
 *   出错源；搭档拍板极简形态：保留段 = 最近 4 条 speak 的纯 text，单条超 1500 字符
 *   截断，硬顶 ≈6.3K 字符——体量与 turn 大小/工具调用密度/文本语言全部解耦。
 *   估算器/密度告警/turn 切片/回放节截断四机制净退役（判定见特性文档「设计取舍」节）。
 *
 * 权威源：session jsonl（agent 视角完整记录）。旧文件在磁盘上永存——截断只发生在
 * 序列化注入文本，原文可考（保留段末尾附旧世 session 文件路径锚，由调用方拼接）。
 */

import {
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

/** F20260929kws1：保留段窗口刻度——最近 4 条 speak（assistant 纯 text 消息）。
 *  Why 条数刻度：speak 是獭的产出面，天然不含 toolResult 碎屑与注入包；turn 体量
 *  方差太大（摸鱼 turn 2 条 entry vs 干活 turn 163 条）不是安全刻度（实测否定，
 *  见特性文档「中间形态留痕」节）。硬编码不设配置项——要改先改特性文档。 */
const KEEP_SPEAK_COUNT = 4;

/** 单条 speak 截断阈值与头尾保留（沿用 F20260928keep 回放节截断的同一套常量：
 *  只有一种东西要截，就只需要一套数；1500/750/750 零迁移成本）。要改先改特性文档。 */
const SPEAK_TRUNCATE_CHARS = 1_500;
const SPEAK_KEEP_HEAD = 750;
const SPEAK_KEEP_TAIL = 750;

/** F20260930hsfx 降级原因枚举——交接档案降级/合成跳过的每一种形态都有唯一 reason，
 *  贯穿日志与档案文案，事后排查一眼定位是哪条降级路径（此前「synthesizePast=false /
 *  失败 / 超时」三并列，无法区分真空 session / 无 speak 有原料 / jsonl 读失败等）。 */
export type HandoffDegradeReason =
  | 'user-off'            // 触发方显式 synthesizePast=false——用户选择，非降级
  | 'empty-session'       // session 真空（0 条 entry）——无原料可合成，跳过合理
  | 'compaction-only'     // 全 compaction entry、零普通消息（极端形态，slice 非空但原料为空）——与真空区分（#1277）
  | 'jsonl-read-fail'     // jsonl 读取/切片失败——原料不可得
  | 'synthesis-error'     // 合成抛错（含截断 fail-closed）
  | 'synthesis-timeout'   // 合成超时
  | 'over-window'         // 合成 prompt 固定段结构性超窗
  | 'circuit-open';       // 连续失败熔断开启，强制机械档案

/** 各 reason 的档案「说明」节展示文案（buildMechanicalArchive 消费；新增 reason 必登记）。
 * F20260930hsfx 审视建议1：原 'no-speak-has-material' 值无任何代码消费（无 speak 有原料时
 *  slice 非空、合成照跑，根本不走机械档案降级路径）——死枚举删除，避免「枚举存在≠有路径」的假象。 */
export const HANDOFF_DEGRADE_REASON_TEXT: Record<HandoffDegradeReason, string> = {
  'user-off': '触发方选择跳过前世叙事合成（synthesizePast=false）',
  'empty-session': '前世 session 无任何消息（空 session，无原料可合成）',
  // #1277：全 compaction 极端形态专属文案——与真空区分，排查一眼定位「slicer 有 entry 但零普通消息」
  'compaction-only': '前世 session 只有 compaction 摘要、无普通消息（极端形态，无原料可合成）',
  'jsonl-read-fail': '前世 session 文件读取失败，无法取得合成原料',
  'synthesis-error': '叙事合成执行失败（已降级机械转储）',
  'synthesis-timeout': '叙事合成超时（已降级机械转储）',
  'over-window': '合成 prompt 超出目标窗口（固定段结构性超窗，已降级机械转储）',
  'circuit-open': '叙事合成连续失败熔断开启，本次强制机械转储（快速止损）',
};

/** 切片产出（F20260929kws1 契约：cutPoint 概念退役，四字段语义重新定义，见各字段注释） */
export interface JsonlSlice {
  /** 最近 4 条 speak 中最老一条的 entry id（保留段起点——观测/追溯用；
   *  无 speak 时为 undefined，保留段展示节据此标注「前世无发言」） */
  firstKeptEntryId: string | undefined;
  /** 叙事合成原料——F20260930hsfx 起语义为「保留段（最近 4 条 speak）之外的全量消息」：
   *  倒序取满 4 条 speak 后，从头到此 4 条之前的全部消息。Why 改口径：旧「第 4 条 speak
   *  之前」会把 gap 消息（toolCall 与 toolResult 对）拦腰切断、且与保留段可能陈旧倒挂
   *  （mimo 盘点独家发现）——改为「保留段之外」后原料完整、与保留段天然不重不漏。
   *  无 speak 时 = 全量消息（纯工具前世原料照送合成，不再连坐跳过）。 */
  messagesToSummarize: SlicerMessage[];
  /** 恒空数组——cutPoint 概念退役，不存在「切点所在 turn 的前缀」 */
  turnPrefixMessages: SlicerMessage[];
  /** 恒 false——不切 turn 就不存在切半轮 */
  isSplitTurn: boolean;
  /** 上一代压缩摘要（jsonl 内最近 compaction entry 的 summary——谱系继承用） */
  previousSummary: string | undefined;
  /** 切片前上下文 token 估算（纯观测用途保留——不再参与任何行为决策） */
  tokensBefore: number;
  /** 近期保留段：最近 4 条 speak（重构造为纯 text 消息——剥 thinking/toolCall 后截断） */
  keptEntries: SessionEntry[];
}

/**
 * 从 session entries 算统一切片（F20260929kws1：倒序找 4 条 speak）。
 *
 * 与旧算法的行为差异（有意为之，见特性文档「影响范围」节）：
 * - 保留段从「预算窗口内全部消息」收窄为「最近 4 条 speak 的纯 text」——
 *   user 消息/注入包/toolResult/thinking/toolCall 参数一律不进保留段
 *   （thinking/toolCall 由检视 S1 实证为日常破顶源）。
 * - F20260930hsfx：恒返回结构——只有「session 真空（0 条 entry）」返回 undefined；
 *   「无 speak 但有原料」返回 keptEntries 为空的 slice（调用方照跑合成，保留段节标注无发言）。
 *   区分真空与无 speak：前者无原料可合成（跳过合理），后者原料完整不该被保留段空连坐降级。
 */
export function sliceSessionEntries(
  entries: SessionEntry[],
  options?: { scopeKey?: string },
): JsonlSlice | undefined {
  if (entries.length === 0) return undefined; // 真空 session——无原料，合成跳过的唯一形态

  // previousSummary：最近一次 compaction entry 的 summary（跨代谱系种子）
  const latestCompaction = getLatestCompactionEntry(entries);
  const previousSummary = latestCompaction?.summary ?? undefined;

  // tokensBefore：序列化前全量估算（观测锚保留；估算不再驱动任何行为）
  const tokensBefore = buildSessionContext(entries).messages.reduce((sum, m) => sum + estimateTokens(m), 0);

  // 倒序找最近 KEEP_SPEAK_COUNT 条 speak（role=assistant 且含非空 text 块），
  // 凑满或耗尽即停——跨过的 user/toolResult 消息一律不进保留段
  const speakIndexes: number[] = [];
  for (let i = entries.length - 1; i >= 0 && speakIndexes.length < KEEP_SPEAK_COUNT; i--) {
    if (assistantTextOf(entries[i]) !== undefined) speakIndexes.push(i);
  }
  speakIndexes.reverse(); // 时间正序（旧 → 新）

  // 叙事合成原料（F20260930hsfx 口径：保留段之外的全量消息）：
  //  - 有 speak：从头到最老保留 speak 之前的全部消息（gap 不拦腰切，与保留段不重不漏）；
  //  - 无 speak（纯工具前世）：全量消息——原料完整，合成照跑（保留段空不再连坐降级）。
  const messagesToSummarize = speakIndexes.length > 0
    ? collectMessages(entries, 0, speakIndexes[0])
    : collectMessages(entries, 0, entries.length);

  // 保留段：重构造为纯 text 消息（无 speak 时为空数组——调用方据此标注「前世无发言」，
  //  但不妨碍合成原料照送）。Why 必须重构造而非只截 text：serializeConversation
  // 的 assistant 分支会无截断带出 thinking 全文与 toolCall 参数 JSON（检视 S1 实测：
  // thinking 2,485 + 参数 4,346，日常形态即破顶），只截 text 不剥块的「硬顶」是假的。
  // thinking 是过程、toolCall 参数全文在 jsonl 原文——保留段只要「说了什么」。
  const keptEntries: SessionEntry[] = speakIndexes.map(index => {
    const original = entries[index];
    const text = truncateSpeakText(assistantTextOf(original)!);
    // entry 骨架（id/timestamp/parentId）原样保留——firstKeptEntryId 与追溯锚不丢
    return {
      ...original,
      message: { ...(original as { message: object }).message, content: [{ type: 'text', text }] },
    } as SessionEntry;
  });

  logKeepRecentSlice({
    total: entries.length,
    keptSpeaks: keptEntries.length,
    keptChars: keptEntries.reduce((sum, e) => sum + (assistantTextOf(e)?.length ?? 0), 0),
    scopeKey: options?.scopeKey,
  });

  return {
    // 无 speak 时保留段为空——firstKeptEntryId 无从指向
    firstKeptEntryId: speakIndexes.length > 0 ? entries[speakIndexes[0]].id : undefined,
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    previousSummary,
    tokensBefore,
    keptEntries,
  };
}

/** assistant entry 的全部 text 块拼接（= speak 本体）。
 *  非 assistant / 无非空 text 块 → undefined（不计入 speak——纯工具轮的 assistant
 *  消息只有 thinking+toolCall，不是「有话说的时刻」）。多块拼接用空串连接：
 *  长度语义 = 各 text 块长度之和，与「拼接计长」规格逐字对应（块边界在 jsonl 原文可考）。 */
function assistantTextOf(entry: SessionEntry): string | undefined {
  if (entry.type !== 'message') return undefined;
  const message = (entry as { message?: { role?: string; content?: unknown } }).message;
  if (!message || message.role !== 'assistant') return undefined;
  return joinedTextBlocks(message.content);
}

/** 非空 text 块判定（type 守卫，含空串排除） */
function isNonEmptyTextBlock(block: unknown): block is { type: 'text'; text: string } {
  if (!block || typeof block !== 'object') return false;
  const b = block as { type?: string; text?: string };
  return b.type === 'text' && typeof b.text === 'string' && b.text.length > 0;
}

/** message content → 拼接的非空 text（string 直返；无 text 块返回 undefined） */
function joinedTextBlocks(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content as unknown[]) {
    if (isNonEmptyTextBlock(block)) parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

/** 单条 speak 截断：超阈值时头 750 + 截断标记 + 尾 750（复用既有截断格式；
 *  标记指向 jsonl 原文与保留段末尾的文件路径锚——由调用方拼接进档案） */
function truncateSpeakText(text: string): string {
  if (text.length <= SPEAK_TRUNCATE_CHARS) return text;
  const head = text.slice(0, SPEAK_KEEP_HEAD);
  const tail = text.slice(text.length - SPEAK_KEEP_TAIL);
  const dropped = text.length - SPEAK_KEEP_HEAD - SPEAK_KEEP_TAIL;
  return `${head}\n…（截断 ${dropped} chars；原文见前世 session jsonl，文件路径若有则附于保留段末尾）\n${tail}`;
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

/** #1277：全 compaction entry 极端形态判定（entries 非空且全部为 compaction）——
 *  交接降级归因专用：该形态 slice 非空但 messagesToSummarize 为空（messageFromEntry 跳过
 *  compaction），hasMaterial=false 走机械档案，reason 应标 compaction-only 而非笼统空 session。 */
export function isCompactionOnlyEntries(entries: SessionEntry[]): boolean {
  return entries.length > 0 && entries.every(e => e.type === 'compaction');
}

// ============================================================================
// 切片观测锚（F20260929kws1：字段简化为 keptSpeaks/keptChars；密度告警随估算机制退役）
// ============================================================================

/** 日志函数注入位（frameworks 层不直接 import logger，对齐现有依赖注入模式）；生产平台在注入时接线 */
let sliceLogger: ((fields: Record<string, unknown>) => void) | undefined;

/** 测试/生产接线：注入 slice 观测日志实现 */
export function setSliceLogger(impl: ((fields: Record<string, unknown>) => void) | undefined): void {
  sliceLogger = impl;
}

/** 切片观测日志（频次低——仅重启獭生/交接时触发；scopeKey 供生产按獭归因） */
function logKeepRecentSlice(fields: { total: number; keptSpeaks: number; keptChars: number; scopeKey?: string }): void {
  sliceLogger?.({ msg: '[keeprecent-slice] cut', ...fields });
}

/**
 * 近期保留段序列化（新世注入用）。
 *
 * keptEntries（已重构造为纯 text 消息）→ serializeConversation（SDK 标准序列化——
 * 与压缩合成 prompt 里的历史序列化同款格式，新世 LLM 阅读无格式切换成本）。
 * 纯 text 消息经 assistant 分支只产出 `[Assistant]: text`——thinking/toolCall 块
 * 已在切片层剥除，此处无需也无法再截断。
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
