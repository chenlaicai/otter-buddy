/** Embedding 模型元信息（版本锚用，F20260811mrpy Part 3） */
export interface EmbedModelMeta {
  /** 模型标识，如 "Xenova/bge-m3" */
  modelId: string;
  /** 模型 revision（HF revision 或本地模型 mtime），未知则为 "unknown" */
  modelRev: string;
  /** 向量维度（从实际加载的模型输出 dims[0] 读取，不硬编码） */
  dim: number;
}

/** Embedding 网关接口（由 frameworks/embedding/ 实现） */
export interface EmbeddingGateway {
  /** 模型是否已就绪可用来生成 embedding */
  readonly available: boolean;
  embed(text: string): Promise<Float32Array>;
  /**
   * 返回当前 worker 加载的模型元信息（F20260811mrpy Part 3）。
   * 可选——避免破坏现有 mock 实现。bootstrap 校验时通过 typeof === "function" 守卫。
   * worker ready 后才可用，内部会 waitForReady。
   */
  getMeta?(): Promise<EmbedModelMeta>;
}
