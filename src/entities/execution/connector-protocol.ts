/**
 * F20261117cnnct（#1868 阶段 4 C1）：connector WSS 协议 v1 帧类型。
 * 方案 v3 §4：JSON 单帧 { v, type, seq, sid, data }；sid=会话代际（hello.ack 下发，
 * 此后所有帧必带——中枢收帧先核 sid，旧 sid 一律丢弃+计数日志，模块 C 红线实现依据）。
 * 协议演进：v1 只承载通道与会话；动作帧（action.request/result）C2 落地。
 */

export const CONNECTOR_PROTOCOL_VERSION = 1;

/** connector 支持的版本区间（hello 携带）；中枢取交集最高，无交集拒连 */
export const HELLO_SUPPORTED_VERSIONS = [CONNECTOR_PROTOCOL_VERSION] as const;

export type ConnectorFrame =
  | { v: number; type: "hello"; seq: number; sid?: undefined; data: { supportedVersions: number[] } }
  | { v: number; type: "hello.ack"; seq: number; sid: string; data: { version: number } }
  | { v: number; type: "heartbeat"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "heartbeat.ack"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "offline"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "error"; seq: number; sid?: string; data: { code: ConnectorErrorCode; message: string } };

export type ConnectorErrorCode =
  | "unpaired"        // 未配对设备（upgrade 鉴权前就拒——此码仅用于误连诊断回执）
  | "bad-token"       // token 无效/已撤销
  | "version"         // 版本无交集
  | "stale-session"   // 旧 sid 帧（中枢侧静默丢弃，不回执——此码用于 connector 侧诊断）
  | "protocol";       // 帧格式/时序非法

/** 心跳参数（方案 v3 §4）：15s 间隔；中枢 90s 无心跳判断开（容忍 3 间隔+抖动） */
export const CONNECTOR_HEARTBEAT_INTERVAL_MS = 15_000;
export const CONNECTOR_HEARTBEAT_TIMEOUT_MS = 90_000;
