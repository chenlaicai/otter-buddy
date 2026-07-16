/** Settings 响应 DTO */
export interface SettingsDTO {
  provider: string;
  model: string;
  port: number;
  dbPath: string;
  embeddingModelPath: string;
  embeddingDim: number;
}

/** 更新 Settings 请求 DTO */
export interface UpdateSettingsRequestDTO {
  provider?: string;
  model?: string;
}
