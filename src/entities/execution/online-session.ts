/**
 * （阶段 4 C1）：执行授权会话——online_sessions 表实体。
 * 模块 C 总闸的库层载体（唯一事实源；Registry 内存注册只是投影缓存）：
 * - 每次主动上线新建一行（重连也是新会话——断线重连 ≠ 恢复执行）
 * - 每 device 至多一 online 行（partial unique index 库层兜底）
 * - 下线/断线/中枢重启均落 offline（reason 区分），旧会话晚到回执一律丢弃
 */

export type OnlineSessionStatus = "online" | "offline";

export type OnlineSessionDisconnectReason = "device-offline" | "heartbeat-timeout" | "hub-restart" | "auth-failed" | null;

export interface OnlineSession {
  id: string;
  deviceId: string;
  status: OnlineSessionStatus;
  connectedAt: string;
  disconnectedAt: string | null;
  disconnectReason: OnlineSessionDisconnectReason;
  lastSeenAt: string;
  /** 握手选定的协议版本（hello.ack 下发，此后帧必带 sid） */
  protocolVersion: number | null;
}
