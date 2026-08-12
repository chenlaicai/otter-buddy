/**
 * 消息体投影：HTML 卡片围栏剥离（F20260728htar）。
 *
 * 消息体是唯一事实源（body 原文不动）；检索（FTS/记忆索引）与上下文注入出口
 * 给剥离投影：html-card 围栏整体替换为 `[html-card: {title}]`，
 * html-card-reply 围栏整体替换为 `[html-card-reply: {cardId}]`。
 *
 * 剥离粒度按围栏类型分叉：
 * - html-card（卡片源码，体积大）：全路径剥离（索引 + 注入）
 * - html-card-reply（回执 JSON，≤2KB，本就是交互载荷）：仅索引剥离；
 *   上下文注入出口用 stripHtmlCardsOnly（不剥回执，水獭直接看到 JSON）
 *
 * 解析用 remark（mdast）：walk 找 lang 为 html-card / html-card-reply 的 code 节点，
 * 用 node.position 的 start/end offset 对原文做切片替换。容器（blockquote/list）场景下
 * 偏移区间自然覆盖中间行的容器前缀，开围栏行的前缀留在区间外，替换为单行占位符后
 * 恰好保留 "> " 类前缀。未闭合围栏 mdast 自然处理到 EOF；
 * 普通代码围栏（含 ~~~）是不透明块：其内部的 html-card 字样不剥离。
 */

import { remark } from "remark";
import remarkGfm from "remark-gfm";
import type { Code, Nodes } from "mdast";

/**
 * 解析管线必须与前端渲染（react-markdown 挂 remarkGfm singleTilde:false）逐字节对齐：
 * GFM 的 footnote definition 是容器块，裸 parse 与渲染管线对容器内围栏判定会分裂（R9）。
 */
const parser = () => remark().use(remarkGfm, { singleTilde: false });

/** 剥离选项：stripReplies=false 时只剥 html-card，保留 html-card-reply 原文（注入出口） */
export interface StripHtmlCardOptions {
  stripReplies?: boolean;
}

/** meta 属性提取（title / card）：双引号值，遇到首个引号截断 */
function extractMetaAttr(meta: string | null | undefined, attr: string): string {
  if (!meta) return "";
  const re = new RegExp(`(?:^|\\s)${attr}="([^"]*)"`);
  const m = meta.match(re);
  return m ? m[1] : "";
}

/** 一处围栏替换：[start, end) 原文区间 → placeholder */
interface FenceReplacement {
  start: number;
  end: number;
  placeholder: string;
}

/** walk mdast 收集目标围栏的切片替换（code 节点不嵌套，无需处理区间重叠） */
function collectFenceReplacements(tree: Nodes, stripReplies: boolean): FenceReplacement[] {
  const replacements: FenceReplacement[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "code") {
      const code = node as Code;
      const isCard = code.lang === "html-card";
      const isReply = code.lang === "html-card-reply";
      if (isCard || (isReply && stripReplies)) {
        replacements.push({
          start: code.position!.start.offset!,
          end: code.position!.end.offset!,
          placeholder: isCard
            ? `[html-card: ${extractMetaAttr(code.meta, "title")}]`
            : `[html-card-reply: ${extractMetaAttr(code.meta, "card")}]`,
        });
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return replacements;
}

/**
 * 剥离消息体中的 HTML 卡片围栏，返回投影文本。
 *
 * @param body 消息原文
 * @param options.stripReplies 是否剥离 html-card-reply 回执围栏（默认 true）。
 *   索引出口（FTS/记忆）用默认值；上下文注入出口传 false（回执 JSON 给水獭直接看）。
 */
export function stripHtmlCardFences(body: string, options?: StripHtmlCardOptions): string {
  const stripReplies = options?.stripReplies ?? true;
  if (!body.includes("html-card")) return body;
  /** micromark 在剥离 BOM 后的值上计算 offset，切片落在原串会整体偏移一字符（R9）：先剥 BOM（投影文本无需保留） */
  const src = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const replacements = collectFenceReplacements(parser().parse(src), stripReplies);
  /** 从后往前替换，先替换不影响前面区间的 offset */
  let out = src;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.placeholder + out.slice(r.end);
  }
  return out;
}

/**
 * 只剥 html-card、保留 html-card-reply 的投影（上下文注入出口用）。
 * 注入出口：buildMessageWithContext 未读注入、list_messages、get_turn_history。
 */
export function stripHtmlCardsOnly(body: string): string {
  return stripHtmlCardFences(body, { stripReplies: false });
}

// ──────────────────────────────────────────────────────────────────────────
// 信道投影（F20260812fmdr）：把 body 变换成特定信道可渲染的形式
//
// 当前出口：飞书 post + md。流水线：
//   stripHtmlCardFences → 占位符人化 → 字节级截断
//
// 与 stripHtmlCardFences 的关系：
// - stripHtmlCardFences 产出机器友好占位符（`[html-card: 标题]`），供检索/记忆索引用
// - projectForChannel 把占位符翻译成终端用户可读形式（带 Web 链接），供 IM 信道用
//
// 截断常量、提示语都通过 options 传入，entity 层不知道"飞书 30KB 限制"这种信道细节。
// ──────────────────────────────────────────────────────────────────────────

/** 信道投影选项 */
export interface ProjectForChannelOptions {
  /** Web 端 base URL，与 conversationId 拼接成卡片跳转链接。缺省时占位符不带链接 */
  webBaseUrl?: string;
  /** 当前会话 ID，用于拼接卡片跳转链接 */
  conversationId?: string;
  /** 投影文本字节上限（UTF-8）。缺省 25000（飞书 post 请求体 30KB 留 5KB 给 JSON 外壳） */
  maxBytes?: number;
  /** 截断时追加的提示文本。缺省 `…(已截断,完整内容见 Web 端)` */
  truncationHint?: string;
}

const DEFAULT_MAX_BYTES = 25000;
const DEFAULT_TRUNCATION_HINT = "…(已截断,完整内容见 Web 端)";

/** 把 stripHtmlCardFences 输出的机器占位符替换为终端用户可读形式 */
function humanizePlaceholders(text: string, options: ProjectForChannelOptions): string {
  const cardUrl =
    options.webBaseUrl && options.conversationId
      ? `${options.webBaseUrl.replace(/\/+$/, "")}/conversations/${options.conversationId}`
      : null;

  // [html-card: 标题] → 【交互卡片:标题】(+ 可选链接)
  text = text.replace(/\[html-card:\s*([^\]]*)\]/g, (_m, title: string) => {
    const label = `【交互卡片:${title}】`;
    return cardUrl ? `${label}\n👉 ${cardUrl}` : label;
  });

  // [html-card-reply: cardId] → [已提交交互卡片]
  text = text.replace(/\[html-card-reply:\s*[^\]]*\]/g, "[已提交交互卡片]");

  return text;
}

/** UTF-8 安全字节切片：在 maxBytes 内不切断多字节字符 */
function utf8SafeSlice(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  // continuation byte 形如 10xxxxxx (0x80–0xBF)；回退到字符边界
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** 按 UTF-8 字节阈值截断，尽量对齐到段落边界（`\n\n`）。若单段超阈，硬切到字符边界 */
function truncateByBytes(text: string, maxBytes: number, hint: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  // 预留 hint 字节 + 2 字节("\n\n" 分隔符),保证 truncated + separator + hint 总长 ≤ maxBytes
  const budgetForText = Math.max(0, maxBytes - Buffer.byteLength(hint, "utf8") - 2);
  const paragraphs = text.split(/(\n\n+)/); // 保留分隔符以便重组
  const kept: string[] = [];
  let used = 0;

  for (const chunk of paragraphs) {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (used + chunkBytes <= budgetForText) {
      kept.push(chunk);
      used += chunkBytes;
      continue;
    }
    // 当前段落放不下：若 chunk 是分隔符直接跳过，否则尝试塞部分
    if (/^\n\n+$/.test(chunk)) continue;
    const remaining = budgetForText - used;
    if (remaining > 20) {
      kept.push(utf8SafeSlice(chunk, remaining));
    }
    break;
  }

  const truncated = kept.join("").trimEnd();
  return `${truncated}\n\n${hint}`;
}

/**
 * 把消息体投影到信道可渲染的 Markdown 文本（飞书 post + md 出口）。
 *
 * 流水线：stripHtmlCardFences → 占位符人化（带 Web 链接）→ 字节级截断。
 *
 * @param body 消息原文（Markdown + html-card 围栏）
 * @param options.webBaseUrl Web 端 base URL，缺省时卡片占位符不带链接
 * @param options.conversationId 当前会话 ID
 * @param options.maxBytes 投影文本字节上限，缺省 25000
 * @param options.truncationHint 截断提示，缺省 `…(已截断,完整内容见 Web 端)`
 */
export function projectForChannel(body: string, options: ProjectForChannelOptions = {}): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const truncationHint = options.truncationHint ?? DEFAULT_TRUNCATION_HINT;

  const stripped = stripHtmlCardFences(body);
  const humanized = humanizePlaceholders(stripped, options);
  return truncateByBytes(humanized, maxBytes, truncationHint);
}
