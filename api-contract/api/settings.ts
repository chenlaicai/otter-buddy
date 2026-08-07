/** 模型信息 DTO（对应 config.yaml llm.models[] 条目，apiKey/apiBaseUrl 不下发） */
export interface ModelInfoDTO {
  alias: string;
  provider: string;
  model: string;
  description?: string;
  strengths?: string[];
  weaknesses?: string[];
  contextWindow?: number;
}

/** Settings 响应 DTO */
export interface SettingsDTO {
  models: ModelInfoDTO[];
  defaultModelAlias: string;
  /** 用户显示名（海獭称呼搭档用的名字，空字符串表示未设置） */
  userName: string;
  port: number;
  dbPath: string;
  embeddingModelPath: string;
  embeddingLocalModelPath?: string;
  embeddingDim: number;
}

/** 更新 Settings 请求 DTO */
export interface UpdateSettingsRequestDTO {
  defaultModelAlias?: string;
  /** 用户显示名（海獭称呼搭档用的名字，传空字符串清除） */
  userName?: string;
}
