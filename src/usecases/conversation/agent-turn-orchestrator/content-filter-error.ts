/** 模型内容过滤终态识别与恢复文案（#1762）。 */

/** 仅匹配 provider/runtime 的错误文本，不扫描用户内容。 */
export function isContentFilterError(errorMessage: string): boolean {
  return /\bcontent_filter\b/i.test(errorMessage);
}

export function buildContentFilterRetryMsg(otterName: string, fromModel: string, toModel: string): string {
  return `[系统恢复] ${otterName} 的模型 ${fromModel} 返回 content_filter，已交接保留前情并切换到 ${toModel} 自动续跑一次。`;
}

export function buildContentFilterTerminalMsg(otterName: string, modelAlias: string): string {
  return `[系统告警] ${otterName} 的模型 ${modelAlias} 返回 content_filter，自动换模型续跑不可用或仍失败。已记录 high healing 并唤醒大獭处置；可改派、换段或人工调整内容后重试。`;
}
