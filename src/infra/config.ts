/** 基础设施配置常量（不可变） */
export const config = {
  db: {
    path: process.env.OTTER_BUDDY_DB_PATH ?? "./otter-buddy.db",
    walMode: true,
    foreignKeys: true,
  },
  server: {
    port: Number(process.env.OTTER_BUDDY_PORT ?? 3000),
  },
  memory: {
    /** RRF 融合参数 k（S3-A5） */
    rrfK: 60,
    /** 权重半衰期天数（S3-I2 用户确认） */
    weightHalfLifeDays: 7,
    /** 同路径 task_relevance 加成（S3-A6） */
    samePathBoost: 1.5,
    /** 跨路径 task_relevance 衰减（S3-A6） */
    crossPathDecay: 0.8,
    /** 用户标记加成（S3-A6） */
    userFlagMultiplier: 2.0,
    /** frequency_boost 系数（S3-A6） */
    frequencyBoostFactor: 0.1,
  },
  embedding: {
    /** bge-m3 向量维度（S2 D19） */
    dimensions: 1024,
    /** bge-m3 模型标识（HuggingFace Hub） */
    modelPath: "Xenova/bge-m3",
  },
  llm: {
    /** LLM 提供商（S2 D20：多提供商 via pi-ai） */
    provider: process.env.OTTER_BUDDY_LLM_PROVIDER ?? "openai",
    /** LLM 模型 ID */
    model: process.env.OTTER_BUDDY_LLM_MODEL ?? "gpt-4o",
    /** API Key（环境变量，S1 NFR：单用户本地） */
    apiKey: process.env.OPENAI_API_KEY ?? "",
  },
} as const;
