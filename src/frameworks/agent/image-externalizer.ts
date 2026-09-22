/**
 * F20260915iext（#779）：历史图片外置——context 钩子发送层投影。
 *
 * 问题（issue #779 现场）：多模态 read 的图片 toolResult 以 base64 原文堆积在 session
 * 上下文中直到 session 结束（某 session 29.6MB 里 97% 是 9 张 ~3.5MB 截图）。图片价值
 * 集中在读图当轮，之后趋近于零，却每轮全量重复参与注意力计算。
 *
 * 设计（搭档拍板）：所有图片统一外置，不是限额降级——
 * - 字节（base64）只在「正在使用的当轮」存在；上一 turn 及更早的图片全部文本化
 * - 存储不动：session jsonl 里 base64 原样保留（UI 回放/审计/compaction 摘要均有原始
 *   素材），只有发给 LLM 的消息数组被投影
 * - 纯函数无状态、每次请求实时计算，无回写无并发问题
 *
 * 占位符三段式：`[图片已外置 | 所见: {摘录} | {来源路径} {尺寸}]`
 * - 所见：该 image toolResult 之后首条 assistant text 的首句（~150 字截断）——LLM 读图
 *   后天然会写分析文字，不需要额外参数或 LLM 调用，就地摘录
 * - 来源路径：回溯同 toolCallId 的 toolCall input（read 类工具取 file_path/path）
 * - 兜底：读图后无 assistant text → 退化为纯元数据占位符，不阻塞
 */

import type { ImageContent } from "@earendil-works/pi-ai";

/** 「所见」摘录的最大长度（字符） */
const EXCERPT_MAX_CHARS = 150;

/** 图片类型集合：assistant toolCall 之后出现的含 image 块的 toolResult 均处理（不局限于 read——
 *  任何工具产出图片都同样堆积，统一外置是设计原则） */

interface ToolCallInfo {
  /** 来源路径（read 类工具从 arguments.file_path / arguments.path 提取；取不到为 undefined） */
  sourcePath?: string;
}

/**
 * 提取文本首句（~150 字截断）。
 *
 * 首句边界：第一个句末标点（。！？!?；;）或换行——取「第一句」而非「前 150 字」是为了
 * 摘录语义完整（issue 现场：「页面骨架渲染成功但数据全空——API 请求没吃到 mock。」）。
 * 刻意不含英文句点：中英混排文本（如「没吃到 mock. 查 URL」）会被一切两半。
 * 无标点时按 EXCERPT_MAX_CHARS 硬截断并加省略号。
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const m = trimmed.match(/[。！？!?；;\n]/);
  const cut = m ? (m.index ?? 0) + 1 : trimmed.length;
  const head = trimmed.slice(0, Math.min(cut, EXCERPT_MAX_CHARS));
  return trimmed.length > head.length ? head.replace(/[\s。！？!?；;.]+$/, "") + "…" : head;
}

/** 人类可读尺寸（base64 字符数 → 解码后字节数的近似：base64 每 4 字符 3 字节） */
function humanSize(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** 构造单张历史图片的占位符文本块 */
function buildPlaceholder(image: ImageContent, info: ToolCallInfo | undefined, excerpt: string): { type: "text"; text: string } {
  const parts: string[] = [];
  if (excerpt) parts.push(`所见: ${excerpt}`);
  const meta: string[] = [];
  if (info?.sourcePath) meta.push(info.sourcePath);
  meta.push(`${image.mimeType} ${humanSize(image.data)}`);
  return { type: "text", text: `[图片已外置${parts.length ? " | " + parts.join(" | ") : ""} | ${meta.join(" ")}]` };
}

/**
 * 外置历史图片：当前 turn 的图片原样保留，上一 turn 及更早的 image 块替换为文本占位符。
 *
 * Turn 边界定义：以最后一条「非 assistant/toolResult」的消息（user / compactionSummary 等）
 * 为界——该位置及之后视为当前 turn。一个 invoke 内连续多步工具调用（assistant→toolResult
 * 链）属同一 turn：模型在链中还可能回看刚读的图，只有跨 turn 后价值才趋零。
 *
 * @param messages 发给 LLM 的消息数组（user/assistant/toolResult/compactionSummary 等）
 * @returns 新数组；无历史图片时原样返回（零拷贝）
 */
export function externalizeHistoricalImages(messages: any[]): any[] {
  if (messages.length === 0) return messages;
  const boundary = findTurnBoundary(messages);
  const toolCallInfo = collectToolCallPaths(messages);
  let changed = false;
  const result = messages.map((msg, idx) => {
    const projected = projectMessage(msg, idx, boundary, toolCallInfo, messages);
    if (projected !== msg) changed = true;
    return projected;
  });
  return changed ? result : messages;
}

/** 找 turn 边界：最后一条非 assistant/toolResult 的消息索引；无边界消息 = 0（全部视为当前 turn，保守保留）。
 *  F20260922txre（#1093）：导出供 toolresult-externalizer 复用同一边界语义（零行为改动）。 */
export function findTurnBoundary(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role !== "assistant" && role !== "toolResult") return i;
  }
  return 0;
}

/** 第一遍：收集 toolCallId → 来源路径（assistant 消息的 toolCall 块，read 类取 file_path/path） */
function collectToolCallPaths(messages: any[]): Map<string, ToolCallInfo> {
  const map = new Map<string, ToolCallInfo>();
  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      const info = extractPathFromToolCall(c);
      if (info) map.set(info.id, { sourcePath: info.path });
    }
  }
  return map;
}

/** 从单块提取 toolCall 来源路径；非 toolCall 块返回 null */
function extractPathFromToolCall(c: any): { id: string; path?: string } | null {
  if (c?.type !== "toolCall" || typeof c.id !== "string") return null;
  const args = c.arguments;
  const path = typeof args?.file_path === "string" ? args.file_path
    : typeof args?.path === "string" ? args.path
    : undefined;
  return { id: c.id, path };
}

/** 投影单条消息：历史区（index < boundary）含 image 块的 toolResult → 占位符；其余原样 */
function projectMessage(msg: any, idx: number, boundary: number, toolCallInfo: Map<string, ToolCallInfo>, messages: any[]): any {
  if (idx >= boundary) return msg;
  if (msg?.role !== "toolResult" || !Array.isArray(msg.content)) return msg;
  if (!msg.content.some((c: any) => c?.type === "image")) return msg;
  const excerpt = findExcerpt(messages, idx, boundary);
  const info = toolCallInfo.get(msg.toolCallId);
  return {
    ...msg,
    content: msg.content.map((c: any) =>
      c?.type === "image" ? buildPlaceholder(c, info, excerpt) : c,
    ),
  };
}

/** 「所见」摘录：该 toolResult 之后（不限紧邻，可能隔着其他工具调用对）首条非空 assistant text 的首句。
 *  不跨越 turn 边界（j > boundary 停扫）——历史图片的摘录若抓到下一 turn 切换话题后的无关 text，
 *  会把「所见」张冠李戴（检视发现 1 反例：读图 A 无分析 → user 换话题 → 摘录抓到「别的分析」）。 */
function findExcerpt(messages: any[], toolResultIdx: number, boundary: number): string {
  for (let j = toolResultIdx + 1; j < messages.length; j++) {
    if (j > boundary) return "";
    const msg = messages[j];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim().length > 0) {
        return firstSentence(c.text);
      }
    }
  }
  return "";
}
