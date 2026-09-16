/**
 * speak 工具的专用校验逻辑。
 * R20260817arnt PR-A：ToolResponse / textResponse / errorResponse /
 * MAX_TOOL_RESULT_CHARS / truncateToolResult 已随迁 @usecases/ports/agent-tools
 * （工具契约归 port，本文件只剩 speak 专属校验）。
 */

/** 前后端共享常量，单一真相源在 @contract/api/html-card */
import { CARD_MAX_PER_MESSAGE, CARD_MAX_BYTES } from "@contract/api/html-card";

/** F20260804hcob: html-card 围栏匹配（``` 与 ~~~ 两种合法围栏，与渲染侧对齐），排除 html-card-reply（回执围栏，不算卡片） */
const HTML_CARD_FENCE = /(?:```|~~~)html-card(?!-reply)/;
/** 全局匹配版本（用于 countCardFences） */
const HTML_CARD_FENCE_GLOBAL = /(?:```|~~~)html-card(?!-reply)/g;

/** 统计 body 中的 html-card 围栏数量（``` 与 ~~~ 两种合法围栏，排除 html-card-reply） */
function countCardFences(body: string): number {
  if (!body.includes('html-card')) return 0;
  const matches = body.match(HTML_CARD_FENCE_GLOBAL);
  return matches ? matches.length : 0;
}

/** 提取 body 中每张 html-card 围栏的内容字节数（UTF-8）。
 *  F20260916hcel：校验口径是「单卡 ≤CARD_MAX_BYTES」，只量围栏内 HTML，不量正文散文。 */
function measureCardFenceBytes(body: string): number[] {
  if (!body.includes('html-card')) return [];
  const fence = /(?:```|~~~)html-card(?!-reply)[^\n]*\n([\s\S]*?)(?:\n(?:```|~~~))/g;
  const sizes: number[] = [];
  let m;
  while ((m = fence.exec(body)) !== null) {
    sizes.push(new TextEncoder().encode(m[1]).length);
  }
  return sizes;
}

/**
 * speak body 校验：返回错误文案（null 表示通过）。
 * F20260804hcob: 除空 body 外，还检测"卡片写在 speak 外"——assistant 文本不持久化，
 * 写在里面的 html-card 搭档根本看不到，必须拒绝并指导模型把围栏移入 body 重试。
 */
export function validateSpeakBody(turnAssistantText: string | undefined, cleanBody: string): string | null {
  if (!cleanBody || cleanBody.trim().length === 0) return "[错误] body 不能为空。请提供你的最终答复内容，然后重新调用 speak。";

  /** 新增：检测卡片数量（第 3 张起用户看到降级的源码块，不可读） */
  const cardCount = countCardFences(cleanBody);
  if (cardCount > CARD_MAX_PER_MESSAGE) {
    return `[错误] 检测到 ${cardCount} 张 html-card 卡片，但单消息最多支持 ${CARD_MAX_PER_MESSAGE} 张（第 3 张起用户会看到降级的源码块，不可读）。请将内容合并为 ${CARD_MAX_PER_MESSAGE} 张卡片，或分多次 speak 输出。`;
  }

  /** F20260916hcel：校验单卡体积（只量围栏内 HTML，不量正文散文） */
  const cardSizes = measureCardFenceBytes(cleanBody);
  for (let i = 0; i < cardSizes.length; i++) {
    if (cardSizes[i] > CARD_MAX_BYTES) {
      const kb = (cardSizes[i] / 1024).toFixed(1);
      const limit = CARD_MAX_BYTES / 1024;
      return `[错误] 第 ${i + 1} 张 html-card 卡片内容为 ${kb}KB，超出 ${limit}KB 体积限制。请精简卡片内容后重试。`;
    }
  }

  if (turnAssistantText !== undefined && HTML_CARD_FENCE.test(turnAssistantText) && !HTML_CARD_FENCE.test(cleanBody)) {
    return "[错误] 检测到你把 ```html-card 卡片写在了 speak 之外的文本里——那段文本不会进入消息，搭档根本看不到卡片。请把完整的 ```html-card 围栏（含全部 HTML）原样移入本次 speak 的 body 参数，重新调用 speak。";
  }
  return null;
}

/** body 中是否含 html-card 围栏（用于 speak 入库时写入 cardSchemaVersion metadata） */
export function hasCardFences(body: string): boolean {
  return countCardFences(body) > 0;
}
