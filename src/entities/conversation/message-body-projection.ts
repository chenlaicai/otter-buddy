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
import { visit } from "unist-util-visit";
import type { AttachmentRef } from "./attachment";
import { projectAttachments } from "./attachment-projection";

/**
 * 解析管线必须与前端渲染（react-markdown 挂 remarkGfm singleTilde:false）逐字节对齐：
 * GFM 的 footnote definition 是容器块，裸 parse 与渲染管线对容器内围栏判定会分裂（R9）。
 */
const parser = () => remark().use(remarkGfm, { singleTilde: false });

/**
 * 机器占位符前缀(零宽空格 \u200B):用于区分 stripHtmlCardFences 产出的占位符 vs
 * body 原文里 LLM 手工打出的字面量 `[html-card: xxx]`。审视 F20260812fmdr R5 发现。
 *
 * stripHtmlCardFences 的 placeholder 格式是公开契约,不能为单个出口改动(影响 FTS/
 * 记忆索引/上下文注入)。通过 options.markPlaceholders=true 让 stripHtmlCardFences
 * 在本次调用产出的占位符前加零宽前缀,humanizePlaceholders 用带前缀的正则匹配,
 * LLM 字面量(没有前缀)不会被误替换为 `【交互卡片】` + 链接。
 */
const PLACEHOLDER_MARK = "\u200B";

/** 剥离选项：stripReplies=false 时只剥 html-card，保留 html-card-reply 原文（注入出口） */
export interface StripHtmlCardOptions {
  stripReplies?: boolean;
  /**
   * 给产出的占位符加零宽前缀(\u200B),用于在下游区分"机器占位符"vs"body 原文字面量"。
   * 默认 false(检索/记忆索引/注入出口用未标记格式)。projectForChannel 传 true。
   */
  markPlaceholders?: boolean;
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
function collectFenceReplacements(
  tree: Nodes,
  stripReplies: boolean,
  markPlaceholders: boolean,
): FenceReplacement[] {
  const prefix = markPlaceholders ? PLACEHOLDER_MARK : "";
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
            ? `${prefix}[html-card: ${extractMetaAttr(code.meta, "title")}]`
            : `${prefix}[html-card-reply: ${extractMetaAttr(code.meta, "card")}]`,
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
  const markPlaceholders = options?.markPlaceholders ?? false;
  if (!body.includes("html-card")) return body;
  /** micromark 在剥离 BOM 后的值上计算 offset，切片落在原串会整体偏移一字符（R9）：先剥 BOM（投影文本无需保留） */
  const src = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const replacements = collectFenceReplacements(parser().parse(src), stripReplies, markPlaceholders);
  /** 从后往前替换，先替换不影响前面区间的 offset */
  let out = src;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.placeholder + out.slice(r.end);
  }
  return out;
}

/**
 * 只剥 html-card、保留 html-card-reply 的投影（上下文注入出口用）。
 * 注入出口：buildMessageWithContext 未读注入、list_messages。
 */
export function stripHtmlCardsOnly(body: string): string {
  return stripHtmlCardFences(body, { stripReplies: false });
}

// ──────────────────────────────────────────────────────────────────────────
// 信道投影（F20260812fmdr）：把 body 变换成特定信道可渲染的形式
//
// 当前出口：飞书 post + md。流水线：
//   stripHtmlCardFences(markPlaceholders:true) → humanizePlaceholders → truncateByBytes
//
// 与 stripHtmlCardFences 的关系：
// - stripHtmlCardFences 产出机器友好占位符（`[html-card: 标题]`），供检索/记忆索引用
// - projectForChannel 用 markPlaceholders:true 让占位符带零宽前缀,humanizePlaceholders
//   只匹配带前缀的版本,避免误匹配 body 原文里的 LLM 字面量(审视 R5)
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
  /** 多模态 Phase 1：消息携带的附件（占位投影在 truncate 之前注入，跨通道不丢） */
  attachments?: AttachmentRef[];
}

const DEFAULT_MAX_BYTES = 25000;
const DEFAULT_TRUNCATION_HINT = "…(已截断,完整内容见 Web 端)";

/** 把带标记的机器占位符替换为终端用户可读形式 */
function humanizePlaceholders(text: string, options: ProjectForChannelOptions): string {
  const cardUrl =
    options.webBaseUrl && options.conversationId
      ? `${options.webBaseUrl.replace(/\/+$/, "")}/conversations/${options.conversationId}`
      : null;

  // \u200B[html-card: 标题] → 【交互卡片:标题】(+ 可选链接)
  text = text.replace(new RegExp(`${PLACEHOLDER_MARK}\\[html-card:\\s*([^\\]]*)\\]`, "g"), (_m, title: string) => {
    const label = `【交互卡片:${title}】`;
    return cardUrl ? `${label}\n👉 ${cardUrl}` : label;
  });

  // \u200B[html-card-reply: cardId] → [已提交交互卡片]
  text = text.replace(new RegExp(`${PLACEHOLDER_MARK}\\[html-card-reply:\\s*[^\\]]*\\]`, "g"), "[已提交交互卡片]");

  return text;
}

/** 附件占位块：projectAttachments 产出 + 对话页链接（复用 html-card 占位符同机制）。
 *  webBaseUrl 缺失时降级为无链接纯文本（与 cardUrl null 语义先例一致，不拼 undefined）。
 *  链接形态 = 对话页链接（非附件直链）：附件 ID 不进 IM 侧，用户进 Web 后在鉴权体系内看原图。 */
function humanizeAttachmentPlaceholders(options: ProjectForChannelOptions): string {
  if (!options.attachments || options.attachments.length === 0) return "";
  const projection = projectAttachments(options.attachments);
  if (!projection) return "";
  const convUrl =
    options.webBaseUrl && options.conversationId
      ? `${options.webBaseUrl.replace(/\/+$/, "")}/conversations/${options.conversationId}`
      : null;
  // 链接只附加一次（多附件共享同一对话页链接）
  return convUrl ? `${projection}\n👉 ${convUrl}` : projection;
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

/** 按 UTF-8 字节阈值截断,尽量对齐到段落边界(`\n\n`)。若单段超阈,硬切到字符边界 */
function truncateByBytes(text: string, maxBytes: number, hint: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  // 归一化 Windows 换行: `\r\n` → `\n`, 避免段落分割正则失配(IPR 审视发现)
  const normalized = text.replace(/\r\n/g, "\n");
  // 预留 hint 字节 + 2 字节("\n\n" 分隔符),保证 truncated + separator + hint 总长 ≤ maxBytes
  const budgetForText = Math.max(0, maxBytes - Buffer.byteLength(hint, "utf8") - 2);
  const paragraphs = normalized.split(/(\n\n+)/); // 保留分隔符以便重组
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
 * 流水线：stripHtmlCardFences → 占位符人化（带 Web 链接）→ 附件占位注入 → 字节级截断。
 *
 * 多模态 Phase 1：附件占位必须在 truncateByBytes **之前**注入（顺序写死）——
 * 若在投影返回后追加，25KB 截断会恰好裁掉附件行，跨通道不丢目标失效。
 * 截断预算权收投影层：附件块作为受保护尾部，从 maxBytes 中预留预算，
 * 正文按剩余预算截断，附件块强制存活（附件行 ≤几行字节，预留代价可忽略）。
 *
 * @param body 消息原文（Markdown + html-card 围栏）
 * @param options.webBaseUrl Web 端 base URL，缺省时卡片占位符不带链接
 * @param options.conversationId 当前会话 ID
 * @param options.maxBytes 投影文本字节上限，缺省 25000
 * @param options.truncationHint 截断提示，缺省 `…(已截断,完整内容见 Web 端)`
 * @param options.attachments 消息附件（占位投影在截断前注入流水线）
 */
/** F20260920alnk：URL 尾部合法字符（RFC 3986 pchar / query / fragment 的可打印 ASCII 子集）。
 *  GFM autolink 对 https:// 裸链的停止条件只有空白和 <，全角标点/中文/任何非空白
 *  Unicode 都会被吸入——从尾部反向剥离直到命中合法尾字符。 */
const URL_TRAILING_CHAR = /[A-Za-z0-9\-_~.!$&'()*+,;=:@#%/?]$/;

/** F20260920alnk：修正 GFM autolink 的全角尾巴。
 *  场景（搭档多次实证）：「（https://github.com/x/pull/1053）。本地偶发的」——GFM 把
 *  「）。本地偶发的」整个吸进 URL，IM 侧点不开链接。
 *  做法：remark+GFM 解析定位 autolink 的 link 节点（源文本区段），把区段替换为
 *  显式链接形态 + 截尾串放链接外：<https://…1053>）本地偶发的。显式形态的解析
 *  不依赖 autolink 边界，尾巴问题就地消除；position 替换只动命中区段，原文其余
 *  部分零改动（不做 stringify 全文重排，避免 round-trip 改写其他语法）。
 *  解析失败/无命中时原样返回（尽力而为，不阻断出站）。 */
// 模块级复用（检视 D1）：parser 链构建有开销，IM 出站每条消息都要过这里
const AUTOLINK_PARSER = remark().use(remarkGfm);

export function trimAutolinkTrailing(text: string): string {
  if (!/https?:\/\//.test(text)) return text; // 快速路径：无裸链
  try {
    const file = AUTOLINK_PARSER.parse(text);
    // 收集需要修剪的 autolink 区段（倒序替换，保证前面的 offset 不失效）
    const edits: Array<{ start: number; end: number; url: string }> = [];
    visit(file, "link", (node) => {
      if (!/^https?:\/\//.test(node.url)) return;
      let url = node.url;
      while (url.length > 0 && !URL_TRAILING_CHAR.test(url)) url = url.slice(0, -1);
      if (url === node.url) return; // 尾部干净，无需修剪
      const pos = node.position;
      // offset 为 0（行首链接）合法：用 null 检查而非 falsy（falsy-zero 陷阱）
      if (pos?.start?.offset == null || pos?.end?.offset == null) return;
      edits.push({ start: pos.start.offset, end: pos.end.offset, url });
    });
    if (edits.length === 0) return text;
    // autolink 区段 → <url>（CommonMark autolink，> 为明确边界）+ 剥离串留在链接外
    let result = text;
    for (const e of [...edits].sort((a, b) => b.start - a.start)) {
      const segment = result.slice(e.start, e.end);
      if (!segment.startsWith(e.url)) continue; // 防御：区段头与 url 不一致（不应发生）
      const tail = segment.slice(e.url.length); // 被吸入的尾巴，留在链接外
      result = result.slice(0, e.start) + `<${e.url}>` + tail + result.slice(e.end);
    }
    return result;
  } catch {
    return text; // 解析异常不阻断出站
  }
}

export function projectForChannel(body: string, options: ProjectForChannelOptions = {}): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const truncationHint = options.truncationHint ?? DEFAULT_TRUNCATION_HINT;

  // stripHtmlCardFences 仅在含 "html-card" 时剥 BOM(短路路径保留 BOM);
  // 飞书侧输出对终端用户可见,BOM 会渲染为怪字符,这里统一主动剥
  const bomStripped = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  // markPlaceholders:true 让占位符带零宽前缀,避免误匹配 body 原文里 LLM 手写字面量(审视 R5)
  const stripped = stripHtmlCardFences(bomStripped, { markPlaceholders: true });
  const humanized = humanizePlaceholders(stripped, options);
  // F20260920alnk：裸 URL 后紧跟全角标点/中文时，GFM autolink 会把它们吸进 URL
  // （IM 渲染器按 GFM 解析 → 链接尾巴带「）。本地偶发的」点不开，搭档多次实证）。
  // IM 出站前统一截尾：URL 尾部只保留 RFC 3986 合法尾字符，剥离串原样保留在文本中。
  const autolinkTrimmed = trimAutolinkTrailing(humanized);

  // 多模态 Phase 1：附件块在截断前注入流水线；预算权收投影层——
  // 附件块预留后正文按剩余预算截断，附件块在截断后仍存活（跨通道不丢）
  const attachmentBlock = humanizeAttachmentPlaceholders(options);
  if (!attachmentBlock) {
    return truncateByBytes(autolinkTrimmed, maxBytes, truncationHint);
  }
  const attachmentBytes = Buffer.byteLength(attachmentBlock, "utf8");
  // 正文剩余预算 = 总预算 - 附件块 - 分隔符（"\n"）；保底 0（极端小预算下附件块优先存活）
  const bodyBudget = Math.max(0, maxBytes - attachmentBytes - 1);
  const truncatedBody = truncateByBytes(autolinkTrimmed, bodyBudget, truncationHint);
  return truncatedBody.trim() ? `${truncatedBody}\n${attachmentBlock}` : attachmentBlock;
}
