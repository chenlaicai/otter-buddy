/** Embedding 网关接口（由 frameworks/embedding/ 实现） */
export interface EmbeddingGateway {
  embed(text: string): Promise<Float32Array>;
}
