/**
 * F20260922txre（#1093）：文本工具返回值历史层收缩——context 钩子发送层投影。
 *
 * 问题（issue #1093 现场）：文本 toolResult 进入 session 历史后无任何收缩机制，以全文
 * 形态永久驻留到 compaction，每轮 LLM request 全量重发——长任务下是上下文第一大头
 * （单条实测 8.9K / 12.9K / 16.8K 字符，远超用户消息包装的 ~0.9K 字符/条）。
 *
 * 设计（对齐 F20260915iext image-externalizer 的投影语义，取舍见特性文档）：
 * - 当前 turn 的 toolResult 原样保留（invoke 内多步工具链中模型还要回看刚拿到的结果）
 * - 上一 turn 及更早、超过 PROJECT_MIN_CHARS 的文本块投影为「头 400 字符 + 收缩标记」
 * - 存储不动：session jsonl 原文保留（回读按 toolCallId 检索），只有发给 LLM 的消息数组被投影
 * - 纯函数无状态、每次请求实时计算；投影产物 < 门槛，天然幂等；zero-copy 快路径
 *
 * 收缩标记模板（稳定不变，幂等与前缀缓存稳定性依赖它）：
 *   `{头 400 字符}…\n\n[工具返回值已投影：原 {N} 字符。…]`
 */

import { findTurnBoundary } from "./image-externalizer";

/** 投影门槛：≤此值的文本块不动（短结果信息密度高、体积无害，投影反而丢信息加标记） */
export const PROJECT_MIN_CHARS = 1_000;

/** 投影后保留的头部字符数（≈前 3-6 行，足够唤起「这条当时是什么」） */
export const KEEP_HEAD_CHARS = 400;

/** 构造收缩标记（模板稳定不变） */
function buildMarker(originalChars: number): string {
  return `[工具返回值已投影：原 ${originalChars} 字符。历史层收缩仅保留开头；完整原文在 session 历史 jsonl，可按本条 toolCallId 检索回读，或重新执行原工具获取]`;
}

/**
 * 投影历史工具返回值：turn 边界之前（历史区）toolResult 的超大文本块收缩为
 * 「头 KEEP_HEAD_CHARS 字符 + … + 收缩标记」；其余（当前 turn、小文本、非 text 块、
 * 非 toolResult 消息）原样不动。
 *
 * Turn 边界语义与 externalizeHistoricalImages 完全一致（复用 findTurnBoundary）：
 * 以最后一条「非 assistant/toolResult」的消息（user / compactionSummary 等）为界，
 * 该位置及之后视为当前 turn；无边界消息 = 全部保守保留。
 *
 * @param messages 发给 LLM 的消息数组
 * @returns 新数组；无可投影内容时原样返回（zero-copy）
 */
export function externalizeHistoricalToolResults(messages: any[]): any[] {
  if (messages.length === 0) return messages;
  const boundary = findTurnBoundary(messages);
  let changed = false;
  const result = messages.map((msg, idx) => {
    const projected = projectMessage(msg, idx, boundary);
    if (projected !== msg) changed = true;
    return projected;
  });
  return changed ? result : messages;
}

/** 投影单条消息：历史区 toolResult 的超大 text 块收缩；其余原样 */
function projectMessage(msg: any, idx: number, boundary: number): any {
  if (idx >= boundary) return msg;
  if (msg?.role !== "toolResult" || !Array.isArray(msg.content)) return msg;
  if (!msg.content.some((c: any) => isProjectableText(c))) return msg;
  return {
    ...msg,
    content: msg.content.map((c: any) => (isProjectableText(c) ? projectTextBlock(c) : c)),
  };
}

/** 是否可投影的文本块：type=text 且 text 为超门槛字符串 */
function isProjectableText(c: any): boolean {
  return c?.type === "text" && typeof c.text === "string" && c.text.length > PROJECT_MIN_CHARS;
}

/** 单个文本块投影：头 KEEP_HEAD_CHARS 字符 + … + 收缩标记（独立判门槛，幂等） */
function projectTextBlock(c: { type: "text"; text: string }): { type: "text"; text: string } {
  return {
    type: "text",
    text: `${c.text.slice(0, KEEP_HEAD_CHARS)}…\n\n${buildMarker(c.text.length)}`,
  };
}
