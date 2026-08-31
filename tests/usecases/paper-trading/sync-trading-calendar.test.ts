/**
 * N1 修复测试：fallback 日历时区安全
 *
 * 章鱼发现：`new Date(2026,0,1).toISOString()` → `"2025-12-31"`（UTC 偏移）
 * 修复后：用本地时区组件拼接，断言无 2025-12-31 行
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn 让 CLI 调用失败
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { syncTradingCalendar } from '@usecases/paper-trading/sync-trading-calendar';

const mockSpawn = vi.mocked(spawn);

/** Mock repository */
function createMockRepo() {
  return {
    syncTradingCalendar: vi.fn().mockResolvedValue(undefined),
    createAccount: vi.fn(),
    getAccount: vi.fn(),
    createPosition: vi.fn(),
    updatePosition: vi.fn(),
    deletePosition: vi.fn(),
    getPosition: vi.fn(),
    getPositions: vi.fn(),
    getCash: vi.fn(),
    updateCash: vi.fn(),
    createOrder: vi.fn(),
    getOrder: vi.fn(),
    getOrders: vi.fn(),
    getPendingOrders: vi.fn(),
    updateOrderStatus: vi.fn(),
    findExistingOrder: vi.fn(),
    getTodayOrderCount: vi.fn(),
    getLastBuyTradeDate: vi.fn(),
    expireOldPendingOrders: vi.fn(),
    createTrade: vi.fn(),
    getTrades: vi.fn(),
    getTradesByDate: vi.fn(),
    createNavHistory: vi.fn(),
    getNavHistory: vi.fn(),
    getLatestNav: vi.fn(),
    createReport: vi.fn(),
    getReport: vi.fn(),
    isTradingDay: vi.fn(),
    getTradingDays: vi.fn(),
    markCorporateAction: vi.fn(),
    getFirstActiveAccountId: vi.fn(),
  };
}

describe('syncTradingCalendar (N1 时区安全)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 模拟 CLI 调用失败，触发 fallback 路径
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => proc.emit('close', 1), 10);
      return proc;
    });
  });

  it('fallback 日期无 UTC 偏移——无 2025-12-31 行（N1 核心断言）', async () => {
    const repo = createMockRepo();
    const result = await syncTradingCalendar(repo as any, '/fake/repo', 2026);

    expect(result.source).toBe('fallback');
    expect(repo.syncTradingCalendar).toHaveBeenCalledOnce();

    const entries = repo.syncTradingCalendar.mock.calls[0][0] as Array<{ date: string; isTradingDay: boolean }>;

    // 核心断言：不应有 2025 年的日期（修复前 toISOString 导致 2025-12-31）
    const dates2025 = entries.filter(e => e.date.startsWith('2025'));
    expect(dates2025).toHaveLength(0);

    // 应有 2026-01-01 到 2026-12-31 的完整日历
    expect(entries[0].date).toBe('2026-01-01');
    expect(entries[entries.length - 1].date).toBe('2026-12-31');
  });

  it('fallback 日历正确标记交易日和非交易日', async () => {
    const repo = createMockRepo();
    await syncTradingCalendar(repo as any, '/fake/repo', 2026);

    const entries = repo.syncTradingCalendar.mock.calls[0][0] as Array<{ date: string; isTradingDay: boolean }>;
    const entryMap = new Map(entries.map(e => [e.date, e.isTradingDay]));

    // 2026-01-05 周一，非节假日 → 交易日
    expect(entryMap.get('2026-01-05')).toBe(true);

    // 2026-01-10 周六 → 非交易日
    expect(entryMap.get('2026-01-10')).toBe(false);

    // 2026-01-01 元旦 → 非交易日（节假日）
    expect(entryMap.get('2026-01-01')).toBe(false);

    // 2026-02-14 春节假期 → 非交易日
    expect(entryMap.get('2026-02-14')).toBe(false);
  });

  it('fallback 日历条目数合理（365 天左右）', async () => {
    const repo = createMockRepo();
    await syncTradingCalendar(repo as any, '/fake/repo', 2026);

    const entries = repo.syncTradingCalendar.mock.calls[0][0] as Array<{ date: string; isTradingDay: boolean }>;
    expect(entries.length).toBe(365); // 2026 年不是闰年
  });
});
