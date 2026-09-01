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
    // F20260901chun：merge 策略——保留旧条目的可选字段（degraded/lastInboundAt），
    // 新条目只覆盖显式提供的字段。无此 merge 会导致空轮询覆盖 lastInboundAt、
    // orphan degraded 标记在首次正常 running 后丢失。
    const existing = this.store.get(channelId);
    const mergedState = existing ? { ...existing.state, ...entry.state } : entry.state;
    this.store.set(channelId, { ...entry, state: mergedState, channelId });
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