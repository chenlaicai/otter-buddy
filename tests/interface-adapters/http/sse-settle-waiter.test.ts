import { describe, it, expect, vi, beforeEach } from "vitest";
import { awaitTriggerAttemptsSettled } from "@interface-adapters/http/sse-settle-waiter";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { Logger } from "@usecases/ports/logger";
import type { Entry } from "@entities/conversation/entry";

function createTestLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    conversationId: "conv-1",
    sequenceNum: 1,
    entryType: "user",
    senderType: "user",
    senderId: "user-1",
    body: "hi",
    invokeId: null,
    yieldTargets: null,
    status: "completed",
    source: "web",
    metadata: null,
    senderName: "",
    contextTokens: null,
    contextTokensMax: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** F20260913ctlv 补漏：settle 判据 = 触发 entry 的 yieldTargets 目标獭无 running invoke */
describe("awaitTriggerAttemptsSettled（entries/invokes 判据）", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = createTestLogger();
  });

  it("无 entryRepo 时立即返回（降级）", async () => {
    await expect(
      awaitTriggerAttemptsSettled({}, logger, "conv-1", "entry-1")
    ).resolves.toBeUndefined();
  });

  it("触发 entry 不存在时立即 settle", async () => {
    const entryRepo = { getEntryById: vi.fn().mockResolvedValue(null) } as unknown as EntryRepository;
    await expect(
      awaitTriggerAttemptsSettled({ entryRepo }, logger, "conv-1", "entry-1")
    ).resolves.toBeUndefined();
  });

  it("无目标（yieldTargets 为空或只有 user）时立即 settle", async () => {
    const entryRepo = {
      getEntryById: vi.fn().mockResolvedValue(createEntry({ yieldTargets: ["user"] })),
    } as unknown as EntryRepository;
    await expect(
      awaitTriggerAttemptsSettled({ entryRepo }, logger, "conv-1", "entry-1")
    ).resolves.toBeUndefined();
  });

  it("单目标无 running invoke 时立即 settle", async () => {
    const entryRepo = {
      getEntryById: vi.fn().mockResolvedValue(createEntry({ yieldTargets: ["otter-1"] })),
    } as unknown as EntryRepository;
    const invokeRepo = {
      getActiveInvokeByOtterId: vi.fn().mockResolvedValue(null),
    } as unknown as InvokeRepository;
    await expect(
      awaitTriggerAttemptsSettled({ entryRepo, invokeRepo }, logger, "conv-1", "entry-1")
    ).resolves.toBeUndefined();
  });

  it("单目标 running invoke 未终态时轮询直到终态", async () => {
    let callCount = 0;
    const entryRepo = {
      getEntryById: vi.fn().mockResolvedValue(createEntry({ yieldTargets: ["otter-1"] })),
    } as unknown as EntryRepository;
    const invokeRepo = {
      getActiveInvokeByOtterId: vi.fn().mockImplementation(async () => {
        callCount++;
        // 前两次返回 running invoke，第三次返回 null（终态）
        if (callCount < 3) {
          return { id: "inv-1", status: "running" };
        }
        return null;
      }),
    } as unknown as InvokeRepository;

    await expect(
      awaitTriggerAttemptsSettled({ entryRepo, invokeRepo }, logger, "conv-1", "entry-1")
    ).resolves.toBeUndefined();
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("多獭场景：獭 A 已终态、獭 B running 时轮询直到全部终态", async () => {
    let callCount = 0;
    const entryRepo = {
      getEntryById: vi.fn().mockResolvedValue(createEntry({ yieldTargets: ["otter-A", "otter-B"] })),
    } as unknown as EntryRepository;
    const invokeRepo = {
      getActiveInvokeByOtterId: vi.fn().mockImplementation(async (_convId: string, otterId: string) => {
        callCount++;
        // 獭 A 始终终态
        if (otterId === "otter-A") return null;
        // 獭 B 前两轮 running，之后终态
        if (callCount < 5) return { id: "inv-B", status: "running" };
        return null;
      }),
    } as unknown as InvokeRepository;

    await expect(
      awaitTriggerAttemptsSettled({ entryRepo, invokeRepo }, logger, "conv-1", "entry-1")
    ).resolves.toBeUndefined();
  });

  it("查询抛异常时立即 settle（fail-safe 兜底关流）", async () => {
    const entryRepo = {
      getEntryById: vi.fn().mockRejectedValue(new Error("db error")),
    } as unknown as EntryRepository;
    await expect(
      awaitTriggerAttemptsSettled({ entryRepo }, logger, "conv-1", "entry-1")
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  /** F20260928icmm 阶段2：POST 流 settle 首查竞态回归——invoke 行延迟创建时不得误判
   *  settled 提前关流（9/25 现场实证：14:51:02.246 关流 / .288 invoke 才创建）。 */
  it("首查时 invoke 尚未创建（竞态窗口）→ 不立即 settle，等到 invoke 出现且终态后才关流", async () => {
    vi.useFakeTimers();
    try {
      const createdAt = Date.now() + 400; // invoke 行 400ms 后才创建（真实竞态窗口 ~40ms，放大便于测试）
      const entryRepo = {
        getEntryById: vi.fn().mockResolvedValue(createEntry({ yieldTargets: ["otter-1"] })),
      } as unknown as EntryRepository;
      const invokeRepo = {
        getActiveInvokeByOtterId: vi.fn().mockImplementation(async () => {
          // invoke 创建前返回 running（模拟 invoke 已建）；终态后返回 null
          if (Date.now() < createdAt + 1000) return { id: "inv-1", status: "running" };
          return null;
        }),
      } as unknown as InvokeRepository;

      let settled = false;
      awaitTriggerAttemptsSettled({ entryRepo, invokeRepo }, logger, "conv-1", "entry-1").then(() => { settled = true; });

      // 旧实现（首查立即执行）在此刻就可能误判 settle（若首查落在 invoke 创建前）
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      // 推进过首查延迟（500ms）：invoke 已创建且 running → 仍不 settle
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe(false);

      // 推进到 invoke 终态（createdAt + 1000 之后）→ settle
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toBe(true);
      expect(Date.now()).toBeGreaterThanOrEqual(createdAt); // settle 时 invoke 已创建且过终态——若首查误判，settle 会发生在 createdAt 前
    } finally {
      vi.useRealTimers();
    }
  });
});
