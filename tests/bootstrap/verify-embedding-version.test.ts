/**
 * F20260811mrpy Part 3：verifyEmbeddingVersion 三分支测试
 *
 * 分支：
 * 1. embeddingGateway 无 getMeta（老接口）→ 跳过（vecEnabled=true）
 * 2. 初次启动（stored.modelId 空）→ 写基线（vecEnabled=true）
 * 3. 一致 → vecEnabled=true
 * 4. 不一致 → disableVec + otter_context 告警（vecEnabled=false）
 *
 * F20260821evaf：available=false（worker 尚未 ready）不再跳过——getMeta 内部 waitForReady。
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
  const deletedKeys: string[] = [];
  const memoryMock = {
    getEmbeddingMeta: vi.fn().mockResolvedValue(opts.storedMeta ?? {}),
    setEmbeddingMeta: vi.fn().mockImplementation(async (meta: EmbedModelMeta) => { writtenMeta = meta; }),
    disableVec: vi.fn().mockImplementation(() => { vecDisabledFlag = true; }),
  };
  return {
    memory: memoryMock,
    memoryReader: memoryMock,
    memoryWriter: memoryMock,
    memoryQueue: memoryMock,
    otterContext: {
      set: vi.fn().mockImplementation(async () => { degradedWritten = true; }),
      get: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockImplementation(async (_otterId: string, key: string) => { deletedKeys.push(key); }),
    },
    // 暴露副作用状态供断言
    writtenMeta: undefined as any,
    degradedWritten: undefined as any,
    vecDisabledFlag: undefined as any,
    // 通过 getter 同步暴露（闭包变量）
    get __state() { return { writtenMeta, degradedWritten, vecDisabledFlag, deletedKeys }; },
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
  it("embeddingGateway 不 available（worker 尚未 ready）→ 仍执行校验（F20260821evaf：available 是时序快照，getMeta 内部 waitForReady）", async () => {
    const gateway = makeGateway({ available: false });
    const repos = makeRepos({
      storedMeta: { modelId: "Xenova/bge-m3", modelRev: "unknown", dim: 1024 },
    });
    const logger = makeLogger();

    const result = await verifyEmbeddingVersion(gateway, repos, logger);

    expect(result.vecEnabled).toBe(true);
    expect(repos.memory.getEmbeddingMeta).toHaveBeenCalled();
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

  it("getMeta 永不返回（worker 挂死）→ 30s 超时后跳过校验，不无限挂起（F20260821evaf 审视项）", async () => {
    vi.useFakeTimers();
    try {
      const gateway = makeGateway({ getMeta: () => new Promise<EmbedModelMeta>(() => {}) });
      const repos = makeRepos({});
      const logger = makeLogger();

      const resultPromise = verifyEmbeddingVersion(gateway, repos, logger);
      const asserted = resultPromise.then((result) => {
        expect(result.vecEnabled).toBe(true);
        expect(logger.warn).toHaveBeenCalled();
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await asserted;
    } finally {
      vi.useRealTimers();
    }
  });

  it("getEmbeddingMeta 读 DB 抛错（IO 错误）→ 跳过校验不崩 boot（F20260821evaf 审视项）", async () => {
    const gateway = makeGateway({});
    const repos = makeRepos({});
    (repos.memoryReader.getEmbeddingMeta as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("database is locked"),
    );
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

  it("modelId 不一致 → disableVec，vecEnabled=false（F20260821evaf：otter_context 写入已移除——FK 挡 system 幽灵 id 且无消费方）", async () => {
    const gateway = makeGateway({});
    const repos = makeRepos({
      storedMeta: { modelId: "old-model", modelRev: "unknown", dim: 1024 },
    });
    const logger = makeLogger();

    const result = await verifyEmbeddingVersion(gateway, repos, logger);

    expect(result.vecEnabled).toBe(false);
    expect(result.reason).toBe("version_mismatch");
    expect((repos as any).__state.vecDisabledFlag).toBe(true);
    expect((repos as any).__state.degradedWritten).toBe(false);
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
