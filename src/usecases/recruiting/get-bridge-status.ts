import {
  RECRUITING_LAST_BRIDGE_EVENT_AT_KEY,
} from './constants';
import type { SettingsRepository } from '@usecases/settings/settings-repository';

/** 桥接状态结果 */
export interface BridgeStatus {
  /** ISO timestamp 或 null（从未上报过） */
  lastEventAt: string | null;
  /** 简化分类 */
  status: 'never-seen' | 'recent' | 'stale';
  /** 距上次活动多少小时（保留 1 位小数） */
  hoursAgo: number | null;
}

/**
 * F20260804rbrg：读取扩展最后活动时间戳，返回简化状态分类。
 *
 * 状态阈值：
 *   - never-seen：从未收到扩展上报（可能未配置/未启动/otter 刚重启）
 *   - recent：< 2 小时（扩展在正常跑）
 *   - stale：>= 2 小时（扩展可能挂了或被反爬暂停）
 */
export class GetBridgeStatus {
  constructor(private readonly settings: SettingsRepository) {}

  async execute(): Promise<BridgeStatus> {
    const last = await this.settings.get(RECRUITING_LAST_BRIDGE_EVENT_AT_KEY);
    if (!last) {
      return { lastEventAt: null, status: 'never-seen', hoursAgo: null };
    }
    const ts = new Date(last).getTime();
    const hoursAgo = Math.round(((Date.now() - ts) / 3_600_000) * 10) / 10;
    return {
      lastEventAt: last,
      status: hoursAgo < 2 ? 'recent' : 'stale',
      hoursAgo,
    };
  }
}
