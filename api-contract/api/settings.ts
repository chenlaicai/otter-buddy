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
  /** 模型列表（唯一真相源 config.yaml models[] 条目，apiKey/apiBaseUrl 不下发） */
  models: ModelInfoDTO[];
  /** 当前默认模型 alias（settingsRepo 覆盖值优先于 config default） */
  defaultModelAlias: string;
  /** 用户显示名（海獭称呼搭档用的名字，空字符串表示未设置） */
  userName: string;
  port: number;
  dbPath: string;
  embeddingModelPath: string;
  /** 本地模型根目录。设置后走本地加载，未设置走远程下载 */
  embeddingLocalModelPath?: string;
  embeddingDim: number;
  /** F20260924wast：浮动獭开关（config im.assistant.web.enabled，DI 启动注入；
   *  false 时前端不挂载浮动元素，降级入口 = 侧栏 web 助理对话。默认 true） */
  assistantWebEnabled: boolean;
}

/** 更新 Settings 请求 DTO */
export interface UpdateSettingsRequestDTO {
  /** 切换默认模型 alias（必须是 models[] 中的合法 alias） */
  defaultModelAlias?: string;
  /** 用户显示名（海獭称呼搭档用的名字，传空字符串清除） */
  userName?: string;
}
