import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetBridgeStatus } from '@usecases/recruiting/get-bridge-status';
import type { SettingsRepository } from '@usecases/settings/settings-repository';

function createMockSettings(): SettingsRepository {
  return {
    get: vi.fn(),
    update: vi.fn(),
    getAll: vi.fn(),
    tryInsertIfAbsent: vi.fn(),
    tryDeleteIfValueMatches: vi.fn(),
  };
}

describe('GetBridgeStatus', () => {
  let settings: SettingsRepository;
  let getBridgeStatus: GetBridgeStatus;

  beforeEach(() => {
    settings = createMockSettings();
    getBridgeStatus = new GetBridgeStatus(settings);
  });

  it('返回 never-seen 状态（从未收到扩展上报）', async () => {
    vi.mocked(settings.get).mockResolvedValue(null);

    const result = await getBridgeStatus.execute();

    expect(result).toEqual({
      lastEventAt: null,
      status: 'never-seen',
      hoursAgo: null,
    });
  });

  it('返回 recent 状态（< 2 小时）', async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    vi.mocked(settings.get).mockResolvedValue(oneHourAgo.toISOString());

    const result = await getBridgeStatus.execute();

    expect(result.status).toBe('recent');
    expect(result.lastEventAt).toBe(oneHourAgo.toISOString());
    expect(result.hoursAgo).toBe(1);
  });

  it('返回 recent 状态（1.5 小时）', async () => {
    const now = new Date();
    const ninetyMinutesAgo = new Date(now.getTime() - 90 * 60 * 1000);
    vi.mocked(settings.get).mockResolvedValue(ninetyMinutesAgo.toISOString());

    const result = await getBridgeStatus.execute();

    expect(result.status).toBe('recent');
    expect(result.hoursAgo).toBe(1.5);
  });

  it('返回 stale 状态（>= 2 小时）', async () => {
    const now = new Date();
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    vi.mocked(settings.get).mockResolvedValue(threeHoursAgo.toISOString());

    const result = await getBridgeStatus.execute();

    expect(result.status).toBe('stale');
    expect(result.lastEventAt).toBe(threeHoursAgo.toISOString());
    expect(result.hoursAgo).toBe(3);
  });

  it('返回 stale 状态（正好 2 小时）', async () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    vi.mocked(settings.get).mockResolvedValue(twoHoursAgo.toISOString());

    const result = await getBridgeStatus.execute();

    expect(result.status).toBe('stale');
    expect(result.hoursAgo).toBe(2);
  });

  it('正确计算 hoursAgo（保留 1 位小数）', async () => {
    const now = new Date();
    const ninetyNineMinutesAgo = new Date(now.getTime() - 99 * 60 * 1000);
    vi.mocked(settings.get).mockResolvedValue(ninetyNineMinutesAgo.toISOString());

    const result = await getBridgeStatus.execute();

    expect(result.hoursAgo).toBe(1.7); // 99/60 = 1.65, 四舍五入到 1 位小数 = 1.7
  });
});
