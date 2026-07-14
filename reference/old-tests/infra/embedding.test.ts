import { describe, it, expect } from "vitest";
import { initEmbedding } from "@infra/embedding/service";

describe("embedding", () => {
  it("initEmbedding 返回 EmbeddingService 实例", () => {
    const service = initEmbedding();
    expect(service).toBeDefined();
    expect(typeof service.embed).toBe("function");
    expect(typeof service.dispose).toBe("function");
    service.dispose();
  });

  it("dispose 后 embed 抛出异常", () => {
    const service = initEmbedding();
    service.dispose();

    return expect(service.embed("test")).rejects.toThrow(/disposed/);
  });

  it("多次调用 dispose 不报错", () => {
    const service = initEmbedding();
    service.dispose();
    service.dispose();
  });

  /**
   * embed 需要下载 bge-m3 模型（~2GB），在 CI 环境中可能不可用。
   * 仅验证通信协议正确，不依赖模型加载。
   */
  it.skip("embed 返回 Float32Array（需模型，CI 跳过）", async () => {
    const service = initEmbedding();
    try {
      const result = await service.embed("Hello, world!");
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(1024);
    } finally {
      service.dispose();
    }
  });
});
