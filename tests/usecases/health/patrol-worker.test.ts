/**
 * PatrolWorker（#949）：四个扫台账循环合并后的单一定时器巡检。
 * 契约：注册职责按序执行 / 失败隔离（一家炸不影响后续）/ stop 等 in-flight / 防重复 start。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PatrolWorker, type PatrolDuty } from '@usecases/health/patrol-worker';
import type { Logger } from '@usecases/ports/logger';

function createTestLogger(): Logger & { errors: string[]; infos: string[] } {
  const errors: string[] = [];
  const infos: string[] = [];
  return {
    errors, infos,
    debug: vi.fn(), info: vi.fn((msg: string) => infos.push(msg)),
    warn: vi.fn(), error: vi.fn((msg: string) => errors.push(msg)),
  } as unknown as Logger & { errors: string[]; infos: string[] };
}

describe('PatrolWorker（#949 巡检合并）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('按注册顺序执行全部职责', async () => {
    const order: string[] = [];
    const duties: PatrolDuty[] = [
      { name: 'a', run: async () => { order.push('a'); } },
      { name: 'b', run: async () => { order.push('b'); } },
      { name: 'c', run: async () => { order.push('c'); } },
    ];
    const worker = new PatrolWorker(duties, createTestLogger());
    await worker.tickSafely();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('失败隔离：一家抛错不影响后续职责执行', async () => {
    const order: string[] = [];
    const logger = createTestLogger();
    const duties: PatrolDuty[] = [
      { name: 'ok-1', run: async () => { order.push('ok-1'); } },
      { name: 'boom', run: async () => { throw new Error('duty exploded'); } },
      { name: 'ok-2', run: async () => { order.push('ok-2'); } },
    ];
    const worker = new PatrolWorker(duties, logger);
    await worker.tickSafely();
    expect(order).toEqual(['ok-1', 'ok-2']);
    expect(logger.errors.some(m => m.includes('boom'))).toBe(true);
  });

  it('start() 启动即巡一轮 + 每 interval 巡一轮', async () => {
    let count = 0;
    const worker = new PatrolWorker([{ name: 'x', run: async () => { count++; } }], createTestLogger(), 60_000);
    worker.start();
    await vi.advanceTimersByTimeAsync(0); // 启动即巡
    expect(count).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000 * 2);
    expect(count).toBe(4);
    await worker.stop();
  });

  it('start() 幂等（重复调用不重复注册定时器）', async () => {
    let count = 0;
    const worker = new PatrolWorker([{ name: 'x', run: async () => { count++; } }], createTestLogger(), 60_000);
    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count).toBe(2); // 启动 1 + interval 1，不是 double
    await worker.stop();
  });

  it('stop() 后定时器清理：推进时间不再巡', async () => {
    let count = 0;
    const worker = new PatrolWorker([{ name: 'x', run: async () => { count++; } }], createTestLogger(), 60_000);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await worker.stop();
    const at = count;
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(count).toBe(at);
  });

  it('stop() 等待 in-flight tick 完成', async () => {
    let done = false;
    const worker = new PatrolWorker([{ name: 'slow', run: async () => { await new Promise(r => setTimeout(r, 5_000)); done = true; } }], createTestLogger(), 60_000);
    worker.start();
    const stopP = worker.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopP;
    expect(done).toBe(true);
  });
});
