/**
 * F20260811mrpy Part 3：verifyEmbeddingVersion 三分支测试
 *
 * 分支：
 * 1. embeddingGateway 不 available 或无 getMeta → 跳过（vecEnabled=true）
 * 2. 初次启动（stored.modelId 空）→ 写基线（vecEnabled=true）
 * 3. 一致 → vecEnabled=true
 * 4. 不一致 → disableVec + otter_context 告警（vecEnabled=false）
 */
import { describe, it, expect, vi } from "vitest";
import { verifyEmbeddingVersion } from "../../src/bootstrap/database";
import type { EmbeddingGateway, EmbedModelMeta } from "@usecases/memory/embedding-gateway";
import type { Repositories } from "../../src/bootstrap/types";
import type { Logger } from "@usecases/ports/logger";

const dummyMeta: EmbedModelMeta = {
  modelId: "Xenova/bge-m3",
  modelRev: "unknown",
  dim: 1024,
};

function makeGateway(opts: {
  available?: boolean;
  getMeta?: () => Promise<EmbedModelMeta>;
  failGetMeta?: boolean;
}): EmbeddingGateway {
  const gateway: any = {
    available: opts.available ?? true,
    embed: vi.fn().mockResolvedValue(new Float32Array(1024)),
  };
  if (opts.failGetMeta) {
    gateway.getMeta = vi.fn().mockRejectedValue(new Error("worker not ready"));
  } else if (opts.getMeta) {
    gateway.getMeta = opts.getMeta;
  } else {
    gateway.getMeta = vi.fn().mockResolvedValue(dummyMeta);
  }
  return gateway as EmbeddingGateway;
}

function makeRepos(opts: {
  storedMeta?: Partial<EmbedModelMeta>;
}): Repositories & { writtenMeta?: EmbedModelMeta; degradedWritten?: boolean; vecDisabledFlag?: boolean } {
  let writtenMeta: EmbedModelMeta | undefined;
  let degradedWritten = false;
  let vecDisabledFlag = false;
  return {
    memory: {
      getEmbeddingMeta: vi.fn().mockResolvedValue(opts.storedMeta ?? {}),
      setEmbeddingMeta: vi.fn().mockImplementation(async (meta: EmbedModelMeta) => { writtenMeta = meta; }),
      disableVec: vi.fn().mockImplementation(() => { vecDisabledFlag = true; }),
    },
    otterContext: {
      set: vi.fn().mockImplementation(async () => { degradedWritten = true; }),
      get: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    // 暴露副作用状态供断言
    writtenMeta: undefined as any,
    degradedWritten: undefined as any,
    vecDisabledFlag: undefined as any,
    // 通过 getter 同步暴露（闭包变量）
    get __state() { return { writtenMeta, degradedWritten, vecDisabledFlag }; },
  } as any;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe("verifyEmbeddingVersion - F20260811mrpy Part 3", () => {
  it("embeddingGateway 不 available → 跳过校验，vecEnabled=true", async () => {
    const gateway = makeGateway({ available: false });
    const repos = makeRepos({});
    const logger = makeLogger();

    const result = await verifyEmbeddingVersion(gateway, repos, logger);

    expect(result.vecEnabled).toBe(true);
    expect(repos.memory.getEmbeddingMeta).not.toHaveBeenCalled();
  });

  it("embeddingGateway 无 getMeta 方法（老接口）→ 跳过校验", async () => {
    const gateway: EmbeddingGateway = {
      available: true,
      embed: vi.fn().mockResolvedValue(new Float32Array(1024)),
      // 故意不带 getMeta
    };
    const repos = makeRepos({});

    const result = await verifyEmbeddingVersion(gateway, repos, makeLogger());

    expect(result.vecEnabled).toBe(true);
  });

  it("getMeta 抛错 → 跳过校验，warn 日志", async () => {
    const gateway = makeGateway({ failGetMeta: true });
    const repos = makeRepos({});
    const logger = makeLogger();

    const result = await verifyEmbeddingVersion(gateway, repos, logger);

    expect(result.vecEnabled).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("初次启动（stored 为空）→ 写基线，vecEnabled=true", async () => {
    const gateway = makeGateway({});
    const repos = makeRepos({ storedMeta: {} });
    const logger = makeLogger();

    const result = await verifyEmbeddingVersion(gateway, repos, logger);

    expect(result.vecEnabled).toBe(true);
    expect((repos as any).__state.writtenMeta).toEqual(dummyMeta);
    expect(logger.info).toHaveBeenCalled();
  });

  it("stored 与 current 一致 → vecEnabled=true，不写", async () => {
    const gateway = makeGateway({});
    const repos = makeRepos({
      storedMeta: { modelId: "Xenova/bge-m3", modelRev: "unknown", dim: 1024 },
    });

    const result = await verifyEmbeddingVersion(gateway, repos, makeLogger());

    expect(result.vecEnabled).toBe(true);
    expect((repos as any).__state.writtenMeta).toBeUndefined();
  });

  it("modelId 不一致 → disableVec + otter_context 告警，vecEnabled=false", async () => {
    const gateway = makeGateway({});
    const repos = makeRepos({
      storedMeta: { modelId: "old-model", modelRev: "unknown", dim: 1024 },
    });
    const logger = makeLogger();

    const result = await verifyEmbeddingVersion(gateway, repos, logger);

    expect(result.vecEnabled).toBe(false);
    expect(result.reason).toBe("version_mismatch");
    expect((repos as any).__state.vecDisabledFlag).toBe(true);
    expect((repos as any).__state.degradedWritten).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it("dim 不一致 → 同样降级", async () => {
    const gateway = makeGateway({});
    const repos = makeRepos({
      storedMeta: { modelId: "Xenova/bge-m3", modelRev: "unknown", dim: 512 },
    });

    const result = await verifyEmbeddingVersion(gateway, repos, makeLogger());

    expect(result.vecEnabled).toBe(false);
    expect(result.reason).toBe("version_mismatch");
  });
});
