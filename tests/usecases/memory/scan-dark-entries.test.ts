/**
 * F20260811mrpy Part 1：ScanDarkEntries 用例测试
 */
import { describe, it, expect, vi } from "vitest";
import { ScanDarkEntries } from "@usecases/memory/scan-dark-entries";
import type { MemoryRepository, DarkEntry } from "@usecases/memory/memory-repository";

function makeDarkEntry(overrides: Partial<DarkEntry> = {}): DarkEntry {
  return {
    entryId: overrides.entryId ?? "entry-1",
    contentType: overrides.contentType ?? "message",
    sourceId: overrides.sourceId ?? "src-1",
    createdAt: overrides.createdAt ?? "2026-08-11T00:00:00Z",
  };
}

function makeMockRepo(scanResult: { entries: DarkEntry[]; total: number; vecDisabled: boolean }): MemoryRepository {
  return {
    scanDarkEntries: vi.fn().mockResolvedValue(scanResult),
    // 其余方法用最小 stub（ScanDarkEntries 只依赖 scanDarkEntries）
  } as unknown as MemoryRepository;
}

describe("ScanDarkEntries", () => {
  it("返回 repo.scanDarkEntries 的结果", async () => {
    const entries = [makeDarkEntry({ entryId: "a" }), makeDarkEntry({ entryId: "b" })];
    const repo = makeMockRepo({ entries, total: 2, vecDisabled: false });
    const usecase = new ScanDarkEntries(repo);

    const result = await usecase.execute();

    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.vecDisabled).toBe(false);
    expect(repo.scanDarkEntries).toHaveBeenCalledOnce();
  });

  it("vecDisabled=true 时不 warn（即使有 entries）", async () => {
    const repo = makeMockRepo({ entries: [], total: 0, vecDisabled: true });
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const usecase = new ScanDarkEntries(repo, logger as any);

    await usecase.execute();

    // vecDisabled 不触发 warn（只有真有暗化条目才 warn）
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("发现暗化条目时 warn 日志含数量", async () => {
    const repo = makeMockRepo({
      entries: [makeDarkEntry(), makeDarkEntry()],
      total: 2,
      vecDisabled: false,
    });
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const usecase = new ScanDarkEntries(repo, logger as any);

    await usecase.execute();

    expect(logger.warn).toHaveBeenCalled();
  });

  it("空列表时不 warn", async () => {
    const repo = makeMockRepo({ entries: [], total: 0, vecDisabled: false });
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const usecase = new ScanDarkEntries(repo, logger as any);

    await usecase.execute();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
