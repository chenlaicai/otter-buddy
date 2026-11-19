/**
 * （阶段 4 C1）：connector WSS 协议 v1 帧类型。
 * 方案 v3 §4：JSON 单帧 { v, type, seq, sid, data }；sid=会话代际（hello.ack 下发，
 * 此后所有帧必带——中枢收帧先核 sid，旧 sid 一律丢弃+计数日志，模块 C 红线实现依据）。
 * 协议演进：v1 含通道与会话（C1）+ 动作帧（C2 action.request/result）。
 */

export const CONNECTOR_PROTOCOL_VERSION = 1;

/**
 * seq 帧字段契约（检视 s5 澄清）：单调递增，仅用于日志对账与乱序观测——
 * **不承担可靠性/重放防护**（重放防护由 actionId 幂等协议承担，C2 落地；
 * sid 代际已天然隔离跨会话重放）。消费方不得以 seq 做正确性判断。
 */

/** connector 支持的版本区间（hello 携带）；中枢取交集最高，无交集拒连 */
export const HELLO_SUPPORTED_VERSIONS = [CONNECTOR_PROTOCOL_VERSION] as const;

export type ConnectorFrame =
  | { v: number; type: "hello"; seq: number; sid?: undefined; data: { supportedVersions: number[] } }
  | { v: number; type: "hello.ack"; seq: number; sid: string; data: { version: number } }
  | { v: number; type: "heartbeat"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "heartbeat.ack"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "offline"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "error"; seq: number; sid?: string; data: { code: ConnectorErrorCode; message: string } }
  /** （C2）：中枢 → connector 的动作执行请求（requestId=actionId 幂等锚） */
  | { v: number; type: "action.request"; seq: number; sid: string; data: {
      actionId: string;
      action: { type: string; input: Record<string, unknown> };
    } }
  /** （C2）：connector → 中枢的动作回执（回带原 actionId 请求-响应关联；
   *  五态语义：succeeded/failed 为执行结论，interrupted/unknown 为收尾裁决——
   *  中枢侧 remote_action_requests 落同态） */
  | { v: number; type: "action.result"; seq: number; sid: string; data: {
      actionId: string;
      status: "succeeded" | "failed" | "interrupted" | "unknown";
      result?: unknown;
      error?: string;
    } };

export type ConnectorErrorCode =
  | "unpaired"        // 未配对设备（upgrade 鉴权前就拒——此码仅用于误连诊断回执）
  | "bad-token"       // token 无效/已撤销
  | "version"         // 版本无交集
  | "stale-session"   // 旧 sid 帧（中枢侧静默丢弃，不回执——此码用于 connector 侧诊断）
  | "protocol";       // 帧格式/时序非法

/** 心跳参数（方案 v3 §4）：15s 间隔；中枢 90s 无心跳判断开（容忍 3 间隔+抖动） */
export const CONNECTOR_HEARTBEAT_INTERVAL_MS = 15_000;
export const CONNECTOR_HEARTBEAT_TIMEOUT_MS = 90_000;

/** （C2）：动作执行回执等待上限——超时中枢侧落 unknown（不盲重试，五态纪律）。
 *  文件动作量级秒级，30s 覆盖慢盘；无进度流（bash 流式属阶段 7）。 */
export const CONNECTOR_ACTION_TIMEOUT_MS = 30_000;
