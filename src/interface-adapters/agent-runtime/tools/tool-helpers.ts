/**
 * speak 工具的专用校验逻辑。
 * R20260817arnt PR-A：ToolResponse / textResponse / errorResponse /
 * MAX_TOOL_RESULT_CHARS / truncateToolResult 已随迁 @usecases/ports/agent-tools
 * （工具契约归 port，本文件只剩 speak 专属校验）。
 */

/** 单消息卡片预算：Issue #360 起前后端共享常量，单一真相源在 @contract/api/html-card */
import { CARD_MAX_PER_MESSAGE, HTML_REPORT_MAX_BYTES, HTML_REPORT_MAX_PER_MESSAGE, HTML_REPORT_MIN_MAX_TOKENS } from "@contract/api/html-card";

/** F20260804hcob: html-card 围栏匹配（``` 与 ~~~ 两种合法围栏，与渲染侧对齐），排除 html-card-reply（回执围栏，不算卡片） */
const HTML_CARD_FENCE = /(?:```|~~~)html-card(?!-reply)/;
/** F20260915hrpt S5: html-report 围栏匹配（同样排除 reply） */
const HTML_REPORT_FENCE = /(?:```|~~~)html-report(?!-reply)/;
/** 全局匹配版本（用于 countCardFences） */
const HTML_CARD_FENCE_GLOBAL = /(?:```|~~~)html-card(?!-reply)/g;
const HTML_REPORT_FENCE_GLOBAL = /(?:```|~~~)html-report(?!-reply)/g;

/** 统计 body 中的 html-card 围栏数量（``` 与 ~~~ 两种合法围栏，排除 html-card-reply） */
function countCardFences(body: string): number {
  if (!body.includes('html-card')) return 0;
  const matches = body.match(HTML_CARD_FENCE_GLOBAL);
  return matches ? matches.length : 0;
}

/** F20260915hrpt: 统计 body 中的 html-report 围栏数量 */
function countReportFences(body: string): number {
  if (!body.includes('html-report')) return 0;
  const matches = body.match(HTML_REPORT_FENCE_GLOBAL);
  return matches ? matches.length : 0;
}

/**
 * F20260915hrpt Severe 1 修复：提取 html-report 围栏内容的字节数（只量围栏内 HTML，不含正文散文）。
 * 解析策略：找 ```html-report / ~~~html-report 开围栏到闭围栏之间的内容，累加字节数。
 */
function measureReportFenceBytes(body: string): number {
  // 匹配 ```html-report ... ``` 或 ~~~html-report ... ~~~ 围栏内容
  const fenceRegex = /(?:```|~~~)html-report[^\n]*\n([\s\S]*?)(?:```|~~~)/g;
  let totalBytes = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(body)) !== null) {
    totalBytes += new TextEncoder().encode(match[1]).length;
  }
  return totalBytes;
}

/**
 * F20260915hrpt: html-report 围栏校验（抽离以降低 validateSpeakBody 复杂度）。
 * 校验项：张数限制（1张）、体积限制（64KB，只量围栏内 HTML）、模型路由（maxTokens≥131072）。
 * @returns 错误文案（null 表示通过）
 */
function validateHtmlReport(body: string, currentModelMaxTokens?: number): string | null {
  const reportCount = countReportFences(body);
  if (reportCount <= 0) return null;

  // 1. 模型路由：maxTokens < 阈值时降级
  if (currentModelMaxTokens !== undefined && currentModelMaxTokens < HTML_REPORT_MIN_MAX_TOKENS) {
    return `[错误] 当前模型输出预算（maxTokens=${currentModelMaxTokens}）不足以生成 html-report 议题汇报卡（需 ≥${HTML_REPORT_MIN_MAX_TOKENS}）。建议切换到 K3/GLM-5/MiMo，或降级为 html-card 小卡片。`;
  }
  // 2. 张数限制（单消息 1 张）
  if (reportCount > HTML_REPORT_MAX_PER_MESSAGE) {
    return `[错误] 检测到 ${reportCount} 张 html-report 卡片，但单消息最多 ${HTML_REPORT_MAX_PER_MESSAGE} 张。多份议题请分多次 speak 输出。`;
  }
  // 3. 体积限制（64KB）——只量围栏内 HTML 内容，不含正文散文（Severe 1 修复）
  const reportBytes = measureReportFenceBytes(body);
  if (reportBytes > HTML_REPORT_MAX_BYTES) {
    return `[错误] html-report 卡片内容超限：当前 ${(reportBytes / 1024).toFixed(1)}KB，上限 ${HTML_REPORT_MAX_BYTES / 1024}KB。请精简卡片 HTML 内容或分多次 speak。`;
  }
  return null;
}

/**
 * speak body 校验：返回错误文案（null 表示通过）。
 * F20260804hcob: 除空 body 外，还检测"卡片写在 speak 外"——assistant 文本不持久化，
 * 写在里面的 html-card 搭档根本看不到，必须拒绝并指导模型把围栏移入 body 重试。
 * F20260915hrpt: 新增 html-report 围栏校验（64KB/1张/模型路由）。
 */
export function validateSpeakBody(turnAssistantText: string | undefined, cleanBody: string, currentModelMaxTokens?: number): string | null {
  if (!cleanBody || cleanBody.trim().length === 0) return "[错误] body 不能为空。请提供你的最终答复内容，然后重新调用 speak。";

  /** 新增：检测卡片数量（第 3 张起用户看到降级的源码块，不可读） */
  const cardCount = countCardFences(cleanBody);
  if (cardCount > CARD_MAX_PER_MESSAGE) {
    return `[错误] 检测到 ${cardCount} 张 html-card 卡片，但单消息最多支持 ${CARD_MAX_PER_MESSAGE} 张（第 3 张起用户会看到降级的源码块，不可读）。请将内容合并为 ${CARD_MAX_PER_MESSAGE} 张卡片，或分多次 speak 输出。`;
  }

  /** F20260915hrpt: html-report 围栏校验（抽离函数，降低复杂度） */
  const reportError = validateHtmlReport(cleanBody, currentModelMaxTokens);
  if (reportError) return reportError;

  // S5 修复：围栏写在 speak 外的检测扩展到 html-report
  if (turnAssistantText !== undefined) {
    const hasCardOutside = HTML_CARD_FENCE.test(turnAssistantText) && !HTML_CARD_FENCE.test(cleanBody);
    const hasReportOutside = HTML_REPORT_FENCE.test(turnAssistantText) && !HTML_REPORT_FENCE.test(cleanBody);
    if (hasCardOutside) {
      return "[错误] 检测到你把 ```html-card 卡片写在了 speak 之外的文本里——那段文本不会进入消息，搭档根本看不到卡片。请把完整的 ```html-card 围栏（含全部 HTML）原样移入本次 speak 的 body 参数，重新调用 speak。";
    }
    if (hasReportOutside) {
      return "[错误] 检测到你把 ```html-report 议题汇报卡写在了 speak 之外的文本里——那段文本不会进入消息，搭档根本看不到。请把完整的 ```html-report 围栏（含全部 HTML）原样移入本次 speak 的 body 参数，重新调用 speak。";
    }
  }
  return null;
}
