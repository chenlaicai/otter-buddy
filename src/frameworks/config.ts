/** 不可变配置常量。usecases 层需要的配置值通过 main.ts 构造函数注入，不直接 import 本文件。 */
export const config = {
  db: {
    path: process.env.OTTER_BUDDY_DB_PATH ?? "./otter-buddy.db",
    walMode: true,
    foreignKeys: true,
  },
  server: {
    port: Number(process.env.OTTER_BUDDY_PORT ?? "3000"),
  },
  memory: {
    /** RRF 融合参数 k（S3-A5） */
    rrfK: 60,
    /** 权重半衰期天数（S3-I2 用户确认） */
    weightHalfLifeDays: 7,
    /** 用户标记加成（S3-A6） */
    userFlagMultiplier: 2.0,
    /** frequency_boost 系数（S3-A6） */
    frequencyBoostFactor: 0.1,
    // samePathBoost 和 crossPathDecay 已移除（treePath 去除，F20260715b8c6）
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
  },
} as const;
