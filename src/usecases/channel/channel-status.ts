/**
 * IM 通道统一整合：通道状态实体类型定义
 * 
 * 状态实体定义在 usecases 层，frameworks 层构造注入使用。
 * 状态存储为纯内存 registry（重启即清零，冷启动后各 poller 重新上报）。
 */

/** 通道类型标识 */
export type ChannelKind = "weixin" | "feishu";

/**
 * 通道运行时状态（状态机）。
 * 
 * 设计取舍：
 * - 不细分 -14 "过期 vs 被顶"——协议无区分语义，统一显示"token 失效"
 * - onReconnecting 映射为 error_backoff(errorMsg="WS 重连中")——不为它单加第六态
 *   （重连中本质是"带错误信息的等待"，与 backoff 语义同构）
 * - #663：error_backoff 携带 reconnectAttempts（连续重连次数，成功归零）供
 *   IM 页展示；仅飞书长连接会上报，微信 poller 无此概念
 */
export type ChannelRuntimeState =
  | { kind: "starting"; since: number }
  | { kind: "running"; since: number; lastInboundAt?: number; degraded?: boolean }
  | { kind: "token_stale"; since: number; errmsg: string }
  | { kind: "error_backoff"; since: number; nextRetryAt?: number; errorMsg: string; reconnectAttempts?: number }
  | { kind: "stopped"; since: number; reason: "manual" | "no_config" | "not_started" };

/**
 * 通道状态条目（registry 存储单元）。
 * 
 * channelId 命名约定：
 * - 微信：`weixin-${accountId}`（多账号场景）
 * - 飞书：`feishu`（单实例）
 * 
 * #663：飞书条目携带 appIdMasked（掩码后的凭证标识，掩码在 frameworks 层
 * 完成——registry/controller 不接触完整 appId，凭证不出服务进程）
 */
export interface ChannelStatusEntry {
  channelId: string;
  kind: ChannelKind;
  state: ChannelRuntimeState;
  account?: { id: string; nickname?: string };
  /** 掩码后的飞书 app_id（#663；形如 cli_a****z9k2，仅展示用） */
  appIdMasked?: string;
}

/**
 * 通道状态注册表接口。
 * 
 * 设计意图：
 * - 纯内存 Map，无持久化——重启即清零，冷启动后各 poller 重新上报
 * - update 为幂等操作：同 channelId 重复写入覆盖旧状态
 * - snapshot 返回当前所有状态的快照（防御性拷贝）
 */
export interface ChannelStatusRegistry {
  update(channelId: string, entry: Omit<ChannelStatusEntry, 'channelId'>): void;
  remove(channelId: string): void;
  snapshot(): ChannelStatusEntry[];
  clear(): void;
}