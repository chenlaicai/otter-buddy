/**
 * IM 通道统一整合：通道状态聚合端点
 * 
 * GET /api/channels/status
 * 
 * 聚合逻辑：registry 状态 + accountStore 账号数据 leftJoin。
 * 设计取舍：
 * - 内存 registry（重启清零）——无持久化，冷启动后各 poller 重新上报即可
 * - 5s HTTP 轮询——token 失效无需亚秒感知，本方案不引入新推送机制
 * - 鉴权沿用现状（内网 MPA API 无鉴权，与 /api/weixin/accounts 同口径）
 */

import type { Context } from "hono";
import type { ChannelStatusRegistry, ChannelStatusEntry } from "@usecases/channel/channel-status";
import type { WeixinAccountStorePort } from "./weixin-connection-controller";

export class ChannelController {
  constructor(
    private readonly registry: ChannelStatusRegistry,
    private readonly weixinAccountStore?: WeixinAccountStorePort,
  ) {}

  /**
   * GET /api/channels/status
   * 
   * 响应格式：
   * ```jsonc
   * { "channels": [
   *     { "channelId": "weixin-mtgv10dc", "kind": "weixin",
   *       "state": { "kind": "token_stale", "since": 1788231415, "errmsg": "session timeout" },
   *       "account": { "id": "weixin-mtgv10dc" } },
   *     { "channelId": "feishu", "kind": "feishu",
   *       "state": { "kind": "running", "since": 1788182784 } }
   * ] }
   * ```
   */
  async getStatus(c: Context): Promise<Response> {
    const registryEntries = this.registry.snapshot();
    const weixinAccounts = this.weixinAccountStore?.listAccounts() ?? [];
    
    // 构建 registry 条目 map（按 channelId 索引）
    const registryMap = new Map<string, ChannelStatusEntry>();
    for (const entry of registryEntries) {
      registryMap.set(entry.channelId, entry);
    }
    
    // 聚合结果：微信账号 + registry 状态 leftJoin
    const channels: Array<{
      channelId: string;
      kind: "weixin" | "feishu" | string;
      state: ChannelStatusEntry["state"];
      account?: { id: string; nickname?: string };
      appIdMasked?: string;
      appShareUrl?: string;
    }> = [];
    
    // 微信账号：有 registry 条目用运行态；无条目显示"未运行"
    for (const account of weixinAccounts) {
      const channelId = `weixin-${account.id}`;
      const registryEntry = registryMap.get(channelId);
      if (registryEntry) {
        channels.push({
          channelId,
          kind: "weixin",
          state: registryEntry.state,
          account: { id: account.id },
        });
      } else {
        // 无 registry 条目：服务刚重启、轮询未起
        // F20260901chun 发现11：无 registry 条目 ≠ 配置缺失——区分 not_started（轮询未起）与 no_config（无 config 段且降级失败）
        channels.push({
          channelId,
          kind: "weixin",
          state: { kind: "stopped", since: Date.now(), reason: "not_started" },
          account: { id: account.id },
        });
      }
    }
    
    // 飞书通道：静态 "feishu" 键已随静态线退役（F20260929fsqr）——不再单查此键；
    // 扫码线统一走下方 feishu-bot: 前缀扫投。
    // F20260928fsqr：扫码接入线——registry 键 = botKey（feishu-bot:<掩码appId>）多实例。
    // kind 带 feishu- 前缀供前端区分实例（前端 find(kind==='feishu') 历史静态线语义已随退役失效）
    for (const [channelId, entry] of registryMap) {
      if (channelId.startsWith("feishu-bot:")) {
        channels.push({
          channelId,
          kind: channelId, // 多实例各自 kind（如 feishu-bot:cli_a****z9k2）
          state: entry.state,
          appIdMasked: entry.appIdMasked,
        });
      }
    }
    
    return c.json({ channels });
  }
}