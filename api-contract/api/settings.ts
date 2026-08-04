/** Settings 响应 DTO */
export interface SettingsDTO {
  provider: string;
  model: string;
  port: number;
  dbPath: string;
  embeddingModelPath: string;
  /** 本地模型根目录。设置后走本地加载，未设置走远程下载 */
  embeddingLocalModelPath?: string;
  embeddingDim: number;
}

/** 更新 Settings 请求 DTO */
export interface UpdateSettingsRequestDTO {
  provider?: string;
  model?: string;
}
