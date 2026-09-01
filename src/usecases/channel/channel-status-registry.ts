/**
 * IM 通道统一整合：通道状态注册表实现
 * 
 * 内存 Map 实现，重启即清零（冷启动后各 poller 重新上报）。
 * 状态存储为纯内存，无持久化——设计取舍：状态是运行时语义，重启后由各 poller 重新上报即可；
 * 持久化引入迁移成本无增益。
 */

import type { ChannelStatusEntry, ChannelStatusRegistry } from "./channel-status";

export class InMemoryChannelStatusRegistry implements ChannelStatusRegistry {
  private readonly store = new Map<string, ChannelStatusEntry>();

  update(channelId: string, entry: Omit<ChannelStatusEntry, 'channelId'>): void {
    this.store.set(channelId, { ...entry, channelId });
  }

  remove(channelId: string): void {
    this.store.delete(channelId);
  }

  snapshot(): ChannelStatusEntry[] {
    // Why: 防御性拷贝——调用方可能修改返回值，不影响 registry 内部状态
    return Array.from(this.store.values()).map(entry => ({ ...entry }));
  }

  clear(): void {
    this.store.clear();
  }
}