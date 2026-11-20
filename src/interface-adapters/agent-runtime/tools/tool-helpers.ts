/**
 * speak 工具的专用校验逻辑。
 * ToolResponse / textResponse / errorResponse /
 * MAX_TOOL_RESULT_CHARS / truncateToolResult 已随迁 @usecases/ports/agent-tools
 * （工具契约归 port，本文件只剩 speak 专属校验）。
 */

/** 前后端共享常量，单一真相源在 @contract/api/html-card */
import { CARD_MAX_PER_MESSAGE, CARD_MAX_BYTES } from "@contract/api/html-card";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import type { Code, Nodes, Paragraph, Root } from "mdast";
import { visit } from "unist-util-visit";

/** 解析管线与投影层 message-body-projection.ts 的 parser 逐字节对齐——
 *  同一 remark + remarkGfm(singleTilde:false)，围栏边界判定与前端渲染（react-markdown）一致。
 * 为什么弃正则改 remark：正则在嵌套围栏处提前截断 under-measure——
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
 * 与 validateSpeakBody 的体积测量同源（collectCardFenceNodes），计数与体积口径一致。 */
function countCardFences(body: string): number {
  return collectCardFenceNodes(body).length;
}

/** 收集 body 中所有「顶层段落文本」节点的起止偏移区间。
 *  泄漏唯一可能发生的位置：模型把序列化文本写进 speak.body 末尾，正文是顶层段落，泄漏字节
 *  是顶层段落的裸文本。其它块容器（围栏 code、行内代码 inlineCode、HTML 原始块 html、
 *  块引用 blockquote、列表 list 等）里的 DSML 都是嵌套内容，其文本节点不在顶层段落里。
 *  复用与卡片校验同源的 remark+remarkGfm 解析（Parser 说明见本文件顶部 parser() 注释）。
 * ：供 stripToolCallSerializationLeak 判定锚点是否位于顶层段落文本。 */
function collectTopLevelParagraphTextRanges(body: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const tree = parser().parse(body) as Root;
  for (const block of tree.children) {
    if (block.type !== "paragraph") continue;
    const paragraph = block as Paragraph;
    for (const child of paragraph.children) {
      if (child.type !== "text") continue;
      const pos = child.position;
      if (pos && pos.start.offset !== undefined && pos.end.offset !== undefined) {
        ranges.push({ start: pos.start.offset, end: pos.end.offset });
      }
    }
  }
  return ranges;
}

/** 判定字符偏移 index 是否落在任一区间内。 */
function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}

/** 工具调用序列化泄漏锚点。
 *  事故现场字节（data/durable-sessions/30288072 entry 333 hexdump）：左尖括号 + 全角
 *  竖线（U+FF5C）+ 大写 DSML + 全角竖线 + 标签名，如 `｜DSML｜tool_calls` / 后随
 *  `｜DSML｜invoke name="yield"` / `｜DSML｜parameter name="reason" string="true"`。
 * 转写有出入：把全角竖线写成了半角下划线 dsml_calls / dsml_invoke /
 *  dsml_parameter（小写），并把思维闭合标签写成了英文单词 “response”。锚点两种前缀
 *  形态都覆盖（i 不计大小写）；“response” 单词不作为判据（转写失真，见 strip 函数
 *  注释）。不收裸 invoke / parameter——裸标签可能是正文里合法的代码示例（Markdown
 *  围栏/行内代码内），收进来会把正文静默截断（检视发现）。锚点全文匹配后还需通过
 *  stripToolCallSerializationLeak 的顶层段落 + 思维闭合标签 + 尾部闭合标记三判定才截断。 */
const TOOL_CALL_SERIALIZATION_RE =
  /<(?:\uFF5CDSML\uFF5C|dsml_)(?:calls|tool_calls|invoke|parameter)\b/i;

/** 剥离 speak body 末尾混入的工具调用序列化泄漏。
 *  根因在模型/provider（deepseek-v4-pro 在「speak 后紧跟 yield」时把第二个调用的
 *  序列化文本写进了第一个调用的 body 参数），应用层无法根治，只能在唯一入库口净化。
 *
 *  截断需同时满足三个独立条件（漏剥优于误剥，fail-open）：
 *   1. 顶层段落：锚点必须落在 Markdown 顶层段落文本里。讨论本 bug 时正文会把事故字节
 *      包进各种块容器（围栏/行内代码/HTML 原始块/块引用/列表）当示例回放，这些容器的
 *      文本都不在顶层段落——「容器内示例」与「顶层真实泄漏」的唯一可靠分界。
 *   2. 思维闭合标签指纹：锚点前必须紧邻思维闭合标签（仅空白分隔）。这是泄漏的强指纹——
 *      模型失手时把 thinking 的闭合标签也带进了 body（entry 333 实测字节有）。句末
 *      标点不作为判据：正文会裸写序列化字节再续正文，以句号判据会误剥吞掉后续。
 *   3. 尾部无闭合标记：锚点之后到 body 末尾不得出现反引号、波浪线或 HTML 闭合标签（</）。
 *      这是挡「行内 HTML 包装示例」的补充判据——如 <code>…</code> 这类行内 HTML 包装，
 *      锚点虽在顶层段落文本里，但闭合标记（</code>）暴露它不是泄漏弹尾而是示例回放。
 *
 * 转写与本判据的出入（详见锚点常量注释）：issue 把思维闭合标签转写成了
 *  英文单词 “response”、把全角竖线转写成了半角下划线。半角下划线锚点已覆盖；“response”
 *  单词不是可靠指纹——合法正文句末也会出现英文 response，匹配它会误剥正常发言，该转写
 *  形态不剥（fail-open 如实记录），权威字节以 entry 333 为准。
 *
 *  选「剥离」而非「拒绝」：连续 speak+yield 场景下拒绝会让模型重试后再次踩同一输出
 *  形态，发言内容本已完整，截断保留正文即可正常落账。 */
export function stripToolCallSerializationLeak(body: string): { body: string; leaked: boolean } {
  const globalRe = new RegExp(TOOL_CALL_SERIALIZATION_RE.source, TOOL_CALL_SERIALIZATION_RE.flags + "g");
  const matches = Array.from(body.matchAll(globalRe));
  if (matches.length === 0) return { body, leaked: false };
  const topLevelRanges = collectTopLevelParagraphTextRanges(body);
  for (const match of matches) {
    const index = match.index ?? 0;
    if (!isInsideAnyRange(index, topLevelRanges)) continue; // 非顶层段落文本（块容器内示例）：不剥
    const prefix = body.slice(0, index);
    if (!/<\/think>\s*$/.test(prefix)) continue; // 无思维闭合标签指纹：fail-open
    const tail = body.slice(index);
    if (/`|~|<\//.test(tail)) continue; // 尾部有闭合标记（行内 HTML 包装示例）：不剥
    return { body: prefix.replace(/<\/think>\s*$/, "").replace(/\s+$/, ""), leaked: true };
  }
  return { body, leaked: false };
}

/**
 * speak body 校验：返回错误文案（null 表示通过）。
 * 除空 body 外，还检测"卡片写在 speak 外"——assistant 文本不持久化，
 * 写在里面的 html-card 搭档根本看不到，必须拒绝并指导模型把围栏移入 body 重试。
 */
export function validateSpeakBody(turnAssistantText: string | undefined, cleanBody: string): string | null {
  if (!cleanBody || cleanBody.trim().length === 0) return "[错误] body 不能为空。请提供你的最终答复内容，然后重新调用 speak。";

  /** 一次 remark 解析派生计数与体积，避免重复解析 */
  const cardNodes = collectCardFenceNodes(cleanBody);
  const cardCount = cardNodes.length;

  /** 检测卡片数量（第 3 张起用户看到降级的源码块，不可读） */
  if (cardCount > CARD_MAX_PER_MESSAGE) {
    return `[错误] 检测到 ${cardCount} 张 html-card 卡片，但单消息最多支持 ${CARD_MAX_PER_MESSAGE} 张（第 3 张起用户会看到降级的源码块，不可读）。请将内容合并为 ${CARD_MAX_PER_MESSAGE} 张卡片，或分多次 speak 输出。`;
  }

  /** 校验单卡体积（只量围栏内 HTML，不量正文散文） */
  const cardSizes = cardNodes.map((n) => new TextEncoder().encode(n.value ?? "").length);
  for (let i = 0; i < cardSizes.length; i++) {
    if (cardSizes[i] > CARD_MAX_BYTES) {
      const kb = (cardSizes[i] / 1024).toFixed(1);
      const limit = CARD_MAX_BYTES / 1024;
      return `[错误] 第 ${i + 1} 张 html-card 卡片内容为 ${kb}KB，超出 ${limit}KB 体积限制。请精简卡片内容，或把全文转为文类产物（写文件 + create_linked_resource 登记，卡片只留摘要）后重试。注意：不要往卡片里塞 JS 库或 base64 图片——图形需求用内联 SVG（见契约图类卡节）或 diagram skill。`;
    }
  }

  /** base64 内嵌资源机械拦截（体积上限放宽后防护语义不削弱：更大预算可容纳小库/base64，
   *  契约禁用清单与机械闸对齐——技术图解走内联 SVG，全文/图片转文类产物） */
  for (let i = 0; i < cardNodes.length; i++) {
    if (/;base64,/.test(cardNodes[i].value ?? "")) {
      return `[错误] 第 ${i + 1} 张 html-card 卡片含 base64 内嵌资源（;base64,）——契约禁止。技术图解请用内联 SVG（见契约图类卡节），图片/全文转文类产物（写文件 + create_linked_resource 登记）。`;
    }
  }

  /** + 「卡片写在 speak 外」检测改 hasCardFences（remark 口径），
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

/** PR 呈递拍板机械闸（PR 卡片闸事故）：收集 body 中所有 html-card 围栏的源码内容（含活类，排除回执），
 *  供 otterCard.submit 授权按钮在坊判定（围栏内有 submit 调用 = 决策卡在场）。
 *  与 countCardFences/体积测量同源（collectCardFenceNodes），嵌套围栏口径一致。 */
export function cardFenceValues(body: string): string[] {
  return collectCardFenceNodes(body).map((node) => node.value ?? "");
}

/** 活类卡（html-card-play）登记摘要提取（tool-factory autoRegisterPlayableCards 使用）。
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
