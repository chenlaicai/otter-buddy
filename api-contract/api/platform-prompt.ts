/** 平台级 system prompt 响应 DTO */
export interface PlatformPromptDTO {
  /** 平台级 system prompt 内容 */
  systemPrompt: string;
}

/** 更新平台级 system prompt 请求 DTO */
export interface UpdatePlatformPromptRequestDTO {
  /** 平台级 system prompt 内容 */
  systemPrompt: string;
}
