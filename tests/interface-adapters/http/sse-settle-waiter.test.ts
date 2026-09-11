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
    turnId: "turn-1",
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

/** F20260910ctlv 补漏：settle 判据 = 触发 entry 的 yieldTargets 目标獭无 running invoke */
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
});
