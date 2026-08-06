import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireDistributedLock } from '@usecases/common/distributed-lock';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { Logger } from '@usecases/ports/logger';

function createMockSettings(): SettingsRepository {
  return {
    get: vi.fn(),
    update: vi.fn(),
    getAll: vi.fn(),
    tryInsertIfAbsent: vi.fn(),
    tryDeleteIfValueMatches: vi.fn(),
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  } as unknown as Logger;
}

describe('acquireDistributedLock', () => {
  let settings: SettingsRepository;
  let logger: Logger;

  beforeEach(() => {
    settings = createMockSettings();
    logger = createMockLogger();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常获取锁（tryInsertIfAbsent 返回 true）', async () => {
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValue(true);

    const result = await acquireDistributedLock(settings, 'test-key', logger);

    expect(result.acquired).toBe(true);
  });

  it('锁被持有后等待释放（轮询检测到非 pending 值）', async () => {
    // 第一次 tryInsertIfAbsent 失败（锁被持有）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);
    // 第二次 tryInsertIfAbsent 失败（锁释放后，另一个进程抢先获取了锁）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);

    // 模拟锁被释放：第一次返回 pending，第二次返回实际值
    vi.mocked(settings.get)
      .mockResolvedValueOnce('pending:1234567890')
      .mockResolvedValueOnce('conv-123');

    const resultPromise = acquireDistributedLock(settings, 'test-key', logger);
    await vi.advanceTimersByTimeAsync(500); // 一次轮询
    const result = await resultPromise;

    expect(result.acquired).toBe(false);
  });

  it('stale lock 清理（30 秒超时后 tryDeleteIfValueMatches 成功）', async () => {
    // 第一次 tryInsertIfAbsent 失败（锁被持有）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);
    // 第二次 tryInsertIfAbsent 成功（stale lock 清理后重新获取）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(true);

    // 模拟 stale lock：pending 值超过 30 秒
    const staleTimestamp = Date.now() - 31_000;
    vi.mocked(settings.get).mockResolvedValue(`pending:${staleTimestamp}`);
    vi.mocked(settings.tryDeleteIfValueMatches).mockResolvedValue(true);

    const resultPromise = acquireDistributedLock(settings, 'test-key', logger);
    await vi.advanceTimersByTimeAsync(500); // 一次轮询
    const result = await resultPromise;

    expect(result.acquired).toBe(true);
    expect(vi.mocked(settings.tryDeleteIfValueMatches).mock.calls.length).toBeGreaterThan(0);
  });

  it('stale lock 被其他进程抢先清理（tryDeleteIfValueMatches 返回 false）', async () => {
    // 第一次 tryInsertIfAbsent 失败（锁被持有）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);
    // 第二次 tryInsertIfAbsent 失败（stale lock 被其他进程清理后，另一个进程抢先获取了锁）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);

    // 模拟 stale lock：pending 值超过 30 秒，但删除失败（已被其他进程清理）
    // 然后第二次轮询时返回非 pending 值（锁已被释放）
    const staleTimestamp = Date.now() - 31_000;
    vi.mocked(settings.get)
      .mockResolvedValueOnce(`pending:${staleTimestamp}`)
      .mockResolvedValueOnce('conv-123');
    vi.mocked(settings.tryDeleteIfValueMatches).mockResolvedValue(false);

    const resultPromise = acquireDistributedLock(settings, 'test-key', logger);
    await vi.advanceTimersByTimeAsync(1000); // 两次轮询
    const result = await resultPromise;

    expect(result.acquired).toBe(false);
    expect(vi.mocked(settings.tryDeleteIfValueMatches).mock.calls.length).toBeGreaterThan(0);
  });

  it('超时场景（MAX_POLL_ATTEMPTS 耗尽返回 null）', async () => {
    // 第一次 tryInsertIfAbsent 失败（锁被持有）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);
    // 第二次 tryInsertIfAbsent 失败（超时后仍无法获取锁）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);

    // 模拟锁一直被持有：pending 值持续存在且未超过 30 秒
    const recentTimestamp = Date.now() - 1000;
    vi.mocked(settings.get).mockResolvedValue(`pending:${recentTimestamp}`);

    // 使用 Promise.all 和 advanceTimersByTime 来模拟时间流逝
    const resultPromise = acquireDistributedLock(settings, 'test-key', logger);
    await vi.advanceTimersByTimeAsync(10_000); // 20 * 500ms
    const result = await resultPromise;

    expect(result.acquired).toBe(false);
    expect(vi.mocked(logger.warn).mock.calls.length).toBeGreaterThan(0);
  });

  it('锁被持有后，对方完成后返回已有值', async () => {
    // 第一次 tryInsertIfAbsent 失败（锁被持有）
    vi.mocked(settings.tryInsertIfAbsent).mockResolvedValueOnce(false);

    // 模拟锁被释放：返回实际值
    vi.mocked(settings.get).mockResolvedValue('conv-123');

    const result = await acquireDistributedLock(settings, 'test-key', logger);

    expect(result.acquired).toBe(false);
  });
});
