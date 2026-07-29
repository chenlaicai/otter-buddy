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
