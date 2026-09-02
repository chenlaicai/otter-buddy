/**
 * #543：模型限流 429 / 配额耗尽识别与告警文案。
 *
 * 现状（问题）：LLM api_error 终态只走 failTerminal——无 healing 落账、无通知，
 * 配额对编排层完全黑盒（检视席空转 3 小时无告警实证，见 issue #543）。
 *
 * 本模块把「模型客户端上抛的错误消息」翻译成编排层可落账的结构化事实：
 * - 是否配额耗尽（终态限流：SDK 已判定不可重试，退避无意义，需告警改派）
 * - 是否瞬时限流（SDK 内置重试耗尽后上抛，短窗后可恢复）
 * - 重置时间提示（尽力提取）
 *
 * 识别策略：正则匹配错误消息文本。数据源是 pi-ai formatProviderError 格式化 +
 * checkSessionError 加 `LLM API error:` 前缀后的字符串（终端形态，跨 provider 统一）。
 *
 * 重置时间的边界：pi-ai 的 openai-completions 路径（GLM 走这条）不透传
 * Retry-After 响应头，Reset-After 元数据拿不到——重置提示从错误正文尽力提取
 * （智谱 code 1310 响应体常含「每日/每周/每月」粒度说明），提取不到则落
 * 观察时间戳（issue #543 原文：没有则记观察时间戳）。宁可保守缺省，不误报。
 */

/** 配额耗尽（终态限流）：SDK isTerminalRateLimitError 同族信号 + 智谱中文文案 */
const QUOTA_EXHAUSTED_PATTERNS: readonly RegExp[] = [
  /usage_limit_reached/i, // OpenAI Responses code 1310 族（同任务简报实证）
  /usage_not_included/i,
  /insufficient_quota/i, // OpenAI
  /quota[^\n]{0,20}(exceeded|exhaust)/i, // GLM code 1310「quota exceeded」
  /配额[^\n]{0,8}(耗尽|用尽|超限)/, // 智谱中文文案
  /(insufficient[^\n]{0,10}balance|balance[^\n]{0,10}insufficient)/i, // 余额不足（智谱 arrearage 族）
  /arrearage/i,
];

/** 瞬时限流：SDK 重试耗尽后上抛（含裸 429 status 码） */
const TRANSIENT_RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /\brate[ _-]?limit/i,
];

/** 重置时间提示（尽力提取，非硬保证） */
const RESET_HINT_PATTERNS: readonly RegExp[] = [
  /(每日|每周|每月|今日)[^，。\n]{0,16}(重置|恢复|更新)/, // 智谱 code 1310 中文粒度说明
  /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?)[^，。\n]{0,8}(重置|恢复)/, // ISO 时间戳 + 重置词
  /reset[^，。\n]{0,16}(time|at)[^\n]{0,24}/i, // 英文 reset time
];

/** rate_limit 识别结果 */
export interface RateLimitMatch {
  /** true=配额耗尽（终态，重试无意义，severity:high）；false=瞬时限流（SDK 重试耗尽，severity:medium） */
  exhausted: boolean;
  /** 重置时间提示（尽力提取；undefined=错误正文未携带，落观察时间戳） */
  resetHint?: string;
}

/** 识别错误消息是否为限流类；非限流返回 null */
export function matchRateLimitError(errorMessage: string): RateLimitMatch | null {
  const exhausted = QUOTA_EXHAUSTED_PATTERNS.some(p => p.test(errorMessage));
  const transient = exhausted || TRANSIENT_RATE_LIMIT_PATTERNS.some(p => p.test(errorMessage));
  if (!exhausted && !transient) return null;
  const resetHint = RESET_HINT_PATTERNS
    .map(p => errorMessage.match(p)?.[0]?.trim())
    .find(hint => !!hint);
  return { exhausted, resetHint };
}

/** 告警系统消息文案（会话内可见：搭档 + 在场獭） */
export function buildRateLimitSystemMsg(p: {
  otterName: string;
  modelAlias: string;
  exhausted: boolean;
  resetHint?: string;
}): string {
  const reset = p.resetHint ? `（${p.resetHint}）` : '';
  if (p.exhausted) {
    return `[系统告警] ${p.otterName} 的模型 ${p.modelAlias} 配额耗尽（429 限流终态），本轮发言已终止${reset}。` +
      `该模型在配额恢复前无法执行任务——编排者请改派其他模型的獭，或等待配额重置。` +
      `详情可查 healing 台账（errorType: rate_limit）。`;
  }
  return `[系统提示] ${p.otterName} 的模型 ${p.modelAlias} 触发限流 429，SDK 自动重试已耗尽，本轮发言失败${reset}。` +
    `通常短时后自行恢复，可稍后重试或改派。`;
}

/** healing 事件 description 文案（台账可 grep） */
export function buildRateLimitDescription(p: { modelAlias: string; exhausted: boolean }): string {
  return p.exhausted
    ? `模型 ${p.modelAlias} 配额耗尽（终态 429）：SDK 判定不可重试，退避无意义`
    : `模型 ${p.modelAlias} 瞬时限流（429）：SDK 内置重试耗尽后上抛`;
}
