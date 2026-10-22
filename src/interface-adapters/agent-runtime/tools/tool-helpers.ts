/**
 * speak 工具的专用校验逻辑。
 * R20260817arnt PR-A：ToolResponse / textResponse / errorResponse /
 * MAX_TOOL_RESULT_CHARS / truncateToolResult 已随迁 @usecases/ports/agent-tools
 * （工具契约归 port，本文件只剩 speak 专属校验）。
 */

/** 前后端共享常量，单一真相源在 @contract/api/html-card */
import { CARD_MAX_PER_MESSAGE, CARD_MAX_BYTES } from "@contract/api/html-card";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import type { Code, Nodes } from "mdast";
import { visit } from "unist-util-visit";

/** F20261022cfme：解析管线与投影层 message-body-projection.ts 的 parser 逐字节对齐——
 *  同一 remark + remarkGfm(singleTilde:false)，围栏边界判定与前端渲染（react-markdown）一致。
 *  为什么弃正则改 remark（#959）：正则在嵌套围栏处提前截断 under-measure——
 *  开围栏 ```` 内嵌 ```（或 ``` 内嵌 ~~~）这类合法嵌套，正则量到第一个内嵌围栏就停，
 *  卡片体积被低估（超体积徽标漏报）；remark 天然处理合法嵌套，与投影层同源。 */
const parser = () => remark().use(remarkGfm, { singleTilde: false });

/** walk mdast 收集 html-card 围栏节点（含 html-card-play 活类，排除 html-card-reply）。
 *  lang 归一化口径与旧正则 (?!-reply) + 含 play 语义一致：活类与普通卡共享单消息卡数预算。 */
function collectCardFenceNodes(body: string): Code[] {
  if (!body.includes("html-card")) return [];
  const nodes: Code[] = [];
  visit(parser().parse(body) as Nodes, "code", (node) => {
    const code = node as Code;
    if (code.lang === "html-card" || code.lang === "html-card-play") nodes.push(code);
  });
  return nodes;
}

/** 统计 body 中的 html-card 围栏数量（含 html-card-play 活类围栏）。
 *  F20261022cfme：与 validateSpeakBody 的体积测量同源（collectCardFenceNodes），计数与体积口径一致。 */
function countCardFences(body: string): number {
  return collectCardFenceNodes(body).length;
}

/**
 * speak body 校验：返回错误文案（null 表示通过）。
 * F20260804hcob: 除空 body 外，还检测"卡片写在 speak 外"——assistant 文本不持久化，
 * 写在里面的 html-card 搭档根本看不到，必须拒绝并指导模型把围栏移入 body 重试。
 */
export function validateSpeakBody(turnAssistantText: string | undefined, cleanBody: string): string | null {
  if (!cleanBody || cleanBody.trim().length === 0) return "[错误] body 不能为空。请提供你的最终答复内容，然后重新调用 speak。";

  /** F20261022cfme（S1 性能）：一次 remark 解析派生计数与体积，避免重复解析 */
  const cardNodes = collectCardFenceNodes(cleanBody);
  const cardCount = cardNodes.length;

  /** 检测卡片数量（第 3 张起用户看到降级的源码块，不可读） */
  if (cardCount > CARD_MAX_PER_MESSAGE) {
    return `[错误] 检测到 ${cardCount} 张 html-card 卡片，但单消息最多支持 ${CARD_MAX_PER_MESSAGE} 张（第 3 张起用户会看到降级的源码块，不可读）。请将内容合并为 ${CARD_MAX_PER_MESSAGE} 张卡片，或分多次 speak 输出。`;
  }

  /** F20260916hcel：校验单卡体积（只量围栏内 HTML，不量正文散文） */
  const cardSizes = cardNodes.map((n) => new TextEncoder().encode(n.value ?? "").length);
  for (let i = 0; i < cardSizes.length; i++) {
    if (cardSizes[i] > CARD_MAX_BYTES) {
      const kb = (cardSizes[i] / 1024).toFixed(1);
      const limit = CARD_MAX_BYTES / 1024;
      return `[错误] 第 ${i + 1} 张 html-card 卡片内容为 ${kb}KB，超出 ${limit}KB 体积限制。请精简卡片内容后重试。`;
    }
  }

  /** F20260804hcob + F20261022cfme（S2 口径统一）：「卡片写在 speak 外」检测改 hasCardFences（remark 口径），
   *  与计数/体积同源；body 侧复用 cardCount === 0，避免对 cleanBody 二次解析。 */
  if (turnAssistantText !== undefined && hasCardFences(turnAssistantText) && cardCount === 0) {
    return "[错误] 检测到你把 ```html-card 卡片写在了 speak 之外的文本里——那段文本不会进入消息，搭档根本看不到卡片。请把完整的 ```html-card 围栏（含全部 HTML）原样移入本次 speak 的 body 参数，重新调用 speak。";
  }
  return null;
}

/** body 中是否含 html-card 围栏（用于 speak 入库时写入 cardSchemaVersion metadata） */
export function hasCardFences(body: string): boolean {
  return countCardFences(body) > 0;
}

/** F20261009csp2 活类卡（html-card-play）登记摘要提取（tool-factory autoRegisterPlayableCards 使用）。
 *  修复：先剥 <script>/<style> 整块再删标签——script 内容是 JS 源码不是文案，
 *  只删标签会把源码漏进摘要（实证：quest RPG 卡摘要成了 "(function(){ var S = …"）。
 *  卡片作者若要摘要可控，可在 HTML 里写一段隐藏 div（display:none）承载人话摘要。 */
export function extractPlayableCardSummary(html: string, maxLen = 180): string {
  const stripped = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 按码点切而非 UTF-16 码元：slice 会切断 emoji 代理对产生孤立代理（渲染乱码，与本 bug 同症状）
  return Array.from(stripped).slice(0, maxLen).join("");
}
