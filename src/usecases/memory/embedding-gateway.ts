/** Embedding 网关接口（由 frameworks/embedding/ 实现） */
export interface EmbeddingGateway {
  /** 模型是否已就绪可用来生成 embedding */
  readonly available: boolean;
  embed(text: string): Promise<Float32Array>;
}
