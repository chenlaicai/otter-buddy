/** 平台级 system prompt 管理网关接口（由 frameworks/agent/ 实现） */
export interface PlatformPromptGateway {
  /** 更新平台 prompt（写入数据库 + 内存缓存） */
  updatePlatformPrompt(prompt: string): Promise<void>;
}
