/** Embedding 模型元信息（版本锚用，F20260811mrpy Part 3） */
export interface EmbedModelMeta {
  /** 模型标识，如 "Xenova/bge-m3" */
  modelId: string;
  /** 模型 revision。当前实现恒为 "unknown"（worker 未上报真实 revision，F20260821evaf 审视记录）。
   *  后果：本地 models/ 目录整目录替换时 modelId/dim 可能都不变，锚检测不到；将来实现真实 rev
   *  （本地 mtime 或 HF revision）时需一次性重写存量基线，否则必然 mismatch。 */
  modelRev: string;
  /** 向量维度（从实际加载的模型输出形状数组最后一维读取，不硬编码） */
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
