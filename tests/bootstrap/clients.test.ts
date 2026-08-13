/**
 * F20260813mren 审视三轮 #11：buildOtterToolClient 的 syncDocs 接线测试。
 * 防 app.ts 漏传 deps 时海獭运行时才炸——无 deps 应抛明确错误，有 deps 应透传。
 */
import { describe, it, expect, vi } from "vitest";
import { buildOtterToolClient } from "../../src/bootstrap/clients";
import type { UseCases } from "../../src/bootstrap/types";

/** 最小 UseCases mock——本测试只触达 docs.sync，其余方法不调用 */
function minimalUseCases(): UseCases {
  const handler: ProxyHandler<object> = {
    get: () => vi.fn(),
  };
  return new Proxy({}, handler) as unknown as UseCases;
}

describe("buildOtterToolClient syncDocs 接线（F20260813mren 审视三轮 #11）", () => {
  it("有 deps.syncDocs 时透传调用", async () => {
    // 不断言调用参数（绑定实现细节）——让 mock 把 rootDir 编进返回值，断言返回值即验证透传
    const syncDocs = vi.fn(async (rootDir?: string) => ({
      synced: rootDir === "/some/root" ? 1 : 0, updated: 0, skipped: 0, archived: 0, errors: 0,
    }));
    const client = buildOtterToolClient(minimalUseCases(), { syncDocs });
    const result = await client.docs.sync("/some/root");
    expect(result.synced).toBe(1);
  });

  it("无 deps 时抛明确错误（而非 undefined is not a function）", async () => {
    const client = buildOtterToolClient(minimalUseCases());
    await expect(client.docs.sync()).rejects.toThrow("syncDocs not wired");
  });

  it("并发调用时第二个返回进行中", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const syncDocs = vi.fn(async () => {
      await gate;
      return { synced: 0, updated: 0, skipped: 0, archived: 0, errors: 0 };
    });
    const client = buildOtterToolClient(minimalUseCases(), { syncDocs });

    const first = client.docs.sync();
    await expect(client.docs.sync()).rejects.toThrow("同步进行中");
    release();
    await first;
  });
});
