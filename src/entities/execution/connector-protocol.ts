/**
 * connector WSS 协议 v2 帧类型（v1 双栈共存）。
 * JSON 单帧 { v, type, seq, sid, data }；sid=会话代际（hello.ack 下发，
 * 此后所有帧必带——中枢收帧先核 sid，旧 sid 一律丢弃+计数日志，模块 C 红线实现依据）。
 *
 * 协议演进：v1 含通道与会话 + 六动作帧（action.request/result）；
 * v2 新增 shell.exec 动作 + 流式输出帧（action.output，C→S）+ 取消帧
 * （action.cancel，S→C）+ action.result 增 errorCode/失败时 result(spill) 信息。
 * 双栈纪律：hello.supportedVersions 取交集最高；LiveConnection 记录协商版本，
 * 帧校验（v 字段）与下行发帧（v 盖章 + 能力闸）一律用会话协商版本而非全局常量——
 * v1 会话只通行六动作（shell/output/cancel 帧面对其关闭，Hub 侧闸 + 端上白名单双保险）。
 */

export const CONNECTOR_PROTOCOL_VERSION = 2;

/** WSS 升级子协议 pin：connector 连接必须在 Sec-WebSocket-Protocol 声明
 *  其中之一，hub 侧升级层校验声明 + 回显选中（handleProtocols，双收优先 v2）。
 *  作用：公网暴露面上通用 WS 客户端/扫描器不声明子协议，在升级握手层即拒
 *  （不进协议状态机）；v1 pin 保留作升级期双协议共存窗口。 */
export const CONNECTOR_WS_SUBPROTOCOL = "otter-connector.v2";
/** 旧版（协议 v1）子协议 pin——升级层双收；新 connector 声明列表时 v2 排前（优先选中） */
export const CONNECTOR_WS_SUBPROTOCOL_V1 = "otter-connector.v1";
/** 升级层放行的子协议全集（优先序：v2 在前） */
export const CONNECTOR_WS_SUBPROTOCOLS: readonly string[] = [CONNECTOR_WS_SUBPROTOCOL, CONNECTOR_WS_SUBPROTOCOL_V1];

/**
 * seq 帧字段契约：单调递增，仅用于日志对账与乱序观测——
 * **不承担可靠性/重放防护**（重放防护由 actionId 幂等协议承担，落地；
 * sid 代际已天然隔离跨会话重放）。消费方不得以 seq 做正确性判断。
 */

/** connector/hub 双方支持的版本区间（hello 携带）；取交集最高，无交集拒连。
 *  v1 保留：旧 connector（仅六动作）与新 hub 共存窗口。 */
export const HELLO_SUPPORTED_VERSIONS: readonly number[] = [1, 2];

// ── shell.exec 动作契约（协议 v2 新增） ──

/** shell.exec input：必带业务 conversationId（connector 端据以定位
 *  `<connector dataRoot>/workspaces/<conversationId>` 设备工作区根 + 台账归因）与
 *  command（string=经 shell 跑；string[]=argv 直跑不过 shell）。
 *  cwd 为**设备侧**语义：hub 下发前已完成跨机映射（中枢 workspace 绝对路径 → 设备
 *  workspace 相对后缀/设备根）；connector 端规则——缺省/相对 → 相对设备工作区根解析，
 *  绝对路径显式保留。timeout 单位为秒（对齐 SDK ShellExecOptions）。 */
export interface ShellExecActionInput extends Record<string, unknown> {
  conversationId: string;
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** 秒（SDK ShellExecOptions.timeout 语义；进程组级超时杀） */
  timeout?: number;
  spill?: { afterBytes: number; afterLines: number };
  /** 输出窗口（调用方保留的尾部 + 采样节流）：设置后 connector 可省略窗口外输出，
   *  省略量经 action.output.skipped 精确上报；缺省 = 全量逐块转发 */
  window?: ShellOutputWindowSpec;
  /** invoke/toolCall 归因透传（可选——connector 台账同维度记账用） */
  invokeId?: string;
  toolCallId?: string;
}

/** ShellOutputWindow 的协议线形（与 SDK ShellOutputWindow 同构，entities 层不引 SDK 类型） */
export interface ShellOutputWindowSpec {
  maxBytes: number;
  maxLines: number;
  minIntervalMs: number;
  bytesPerSecond: number;
}

/** action.output 的 skipped：窗口省略量（UTF-8 字节/换行数/省略文本是否以换行结尾——
 *  与 SDK ShellOutputSkip 同构） */
export interface ShellOutputSkipSpec {
  bytes: number;
  newlines: number;
  endsWithNewline: boolean;
}

/** shell.exec 成功结果（action.result result 载荷；非零 exitCode 仍 succeeded——
 *  「动作跑完了」是事实，退出码是数据） */
export interface ShellExecActionResult {
  exitCode: number;
  /** connector 本机诊断路径（spill 阈值越界时 SDK 落盘）；跨机不保证可读 */
  spillPath?: string;
}

/** shell.exec 在 action.result.errorCode 上的取值：aborted/timeout（→interrupted）；
 *  spawn_error/shell_unavailable/callback_error/invalid_input/workspace_unavailable/unknown（→failed） */
export type ShellExecErrorCode = string;

/** 动作类型 → 引入协议的最低版本（v1=workspace 六动作；v2 新增 shell.exec）。
 *  hub 侧下行闸依此判定（v1 会话收到 shell.exec 不应发生——下行即拦）。 */
export function actionTypeMinVersion(actionType: string): number {
  return actionType === "shell.exec" ? 2 : 1;
}

export type ConnectorFrame =
  | { v: number; type: "hello"; seq: number; sid?: undefined; data: { supportedVersions: number[] } }
  | { v: number; type: "hello.ack"; seq: number; sid: string; data: { version: number } }
  | { v: number; type: "heartbeat"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "heartbeat.ack"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "offline"; seq: number; sid: string; data: Record<string, never> }
  | { v: number; type: "error"; seq: number; sid?: string; data: { code: ConnectorErrorCode; message: string } }
  /** 中枢 → connector 的动作执行请求（requestId=actionId 幂等锚） */
  | { v: number; type: "action.request"; seq: number; sid: string; data: {
      actionId: string;
      action: { type: string; input: Record<string, unknown> };
    } }
  /** connector → 中枢的动作回执（回带原 actionId 请求-响应关联；
   *  五态语义：succeeded/failed 为执行结论，interrupted/unknown 为收尾裁决——
   *  中枢侧 remote_action_requests 落同态）。
   *  v2 增：errorCode（机器可读错误分类，shell.exec  aborted/timeout/spawn_error 等）；
   *  失败时可带 result（部分结果——如 spill 诊断路径，成功/失败结果均带 exitCode/spillPath（有则））。 */
  | { v: number; type: "action.result"; seq: number; sid: string; data: {
      actionId: string;
      status: "succeeded" | "failed" | "interrupted" | "unknown";
      result?: unknown;
      error?: string;
      errorCode?: string;
    } }
  /** connector → 中枢的流式输出帧（协议 v2；shell.exec stdout/stderr 按到达顺序流回）。
   *  不改终态——只有 action.result 结算；旧 sid 晚到输出与结果同样丢弃。 */
  | { v: number; type: "action.output"; seq: number; sid: string; data: {
      actionId: string;
      stream: "stdout" | "stderr";
      text: string;
      /** 紧邻本帧文本之前被窗口省略的输出量（仅 window 模式） */
      skipped?: ShellOutputSkipSpec;
    } }
  /** 中枢 → connector 的取消帧（协议 v2）：只 abort 指定动作（SDK 杀该命令进程组）。
   *  不直接宣称成功——最终状态只信 connector 的 action.result。 */
  | { v: number; type: "action.cancel"; seq: number; sid: string; data: { actionId: string } };

export type ConnectorErrorCode =
  | "unpaired"        // 未配对设备（upgrade 鉴权前就拒——此码仅用于误连诊断回执）
  | "bad-token"       // token 无效/已撤销
  | "version"         // 版本无交集
  | "stale-session"   // 旧 sid 帧（中枢侧静默丢弃，不回执——此码用于 connector 侧诊断）
  | "protocol";       // 帧格式/时序非法

/** 心跳参数：15s 间隔；中枢 90s 无心跳判断开（容忍 3 间隔+抖动） */
export const CONNECTOR_HEARTBEAT_INTERVAL_MS = 15_000;
export const CONNECTOR_HEARTBEAT_TIMEOUT_MS = 90_000;

/** 动作执行回执等待上限——超时中枢侧落 unknown（不盲重试，五态纪律）。
 * 文件动作量级秒级，30s 覆盖慢盘；无进度流。
 * （shell.exec 等长动作的等待上限由调用方按命令 timeout + grace 另行放大——
 *  hub 侧纪律见阶段7方案 §4，本常量只服务文件类六动作缺省。） */
export const CONNECTOR_ACTION_TIMEOUT_MS = 30_000;
