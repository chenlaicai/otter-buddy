/**
 * （阶段 3）：执行机动作台账实体。
 *
 * 分层定位（搭档 2026-11-16 认可的分工表）：
 * - 对话/任务持久与恢复 = pi-durable（哪些调用发出过、哪些有回执、哪些中断）
 * - invoke 级重启续跑   = restart_pending_resumes（哪轮执行断了、怎么唤醒）
 * - 副作用机器真相      = 本台账（磁盘上到底成了没、在哪台设备、hash 对不对）
 *
 * 台账不是第二份主记忆：只存 hash + 截断目标 + 摘要，不存文件内容、不存对话数据。
 */

/** 行状态四态 + 查询态一态 = 计划书五态。 */
export type ActionLedgerStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unknown";

/**
 * 状态语义（与 §3.D 对齐）：
 * - succeeded / failed：动作执行完毕，结果确定（bash 非零退出码也算 succeeded——
 *   「动作跑完了」是事实，退出码是数据；failed 留给确定性未达成：spawn 失败等从未跑起来的情形）。
 * - interrupted：确认未完成（abort/超时/写前崩溃/rename 未落位）——重做是完成它的合法路径。
 * - unknown：无法判定（进程崩溃时 bash 正在跑，回执全丢）——转检查，禁止猜测重试。
 * - not_found：按 actionId 查询无行（从未开始/已修剪）——查询层第五态，调用方可安全发起。
 */
export type ActionQueryStatus = ActionLedgerStatus | "not_found";

export type ActionSource = "sdk-env" | "workspace" | "internal";

export type ActionKind =
  | "file.write"
  | "file.append"
  | "file.truncate"
  | "file.rename"
  | "file.remove"
  | "file.mkdir"
  | "shell.exec"
  | "workspace.write"
  | "workspace.delete";

export interface ActionRecord {
  /** 全局唯一；自铸规则（SUGG-1 修正，均含 boot 纪元防跨 boot 同序号碰撞）：
   *  sdk-env 面 `${toolCallId}:${bootEpoch}:${opSeq}`；workspace 面 `${attribution}:ws:${bootEpoch}:${seq}`
   *  （attribution=toolCallId??invokeId??"internal"）；ALS 外 internal 面 `internal:${bootEpoch}:${seq}`。
   *  调用方显式传的 actionId 原样使用（去重协议本体，跨 boot 复用是预期行为）。 */
  actionId: string;
  deviceId: string;
  /** 阶段 4 onlineSession 落地前恒 null */
  onlineSessionId: string | null;
  invokeId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  source: ActionSource;
  kind: ActionKind;
  /** 解析后绝对路径 / 命令（截断存储） */
  target: string | null;
  /** sha256(写入内容)；exec 等无内容动作为 null */
  contentHash: string | null;
  /** 写入内容字节数（append 尾部 hash 核对需要） */
  contentBytes: number | null;
  status: ActionLedgerStatus;
  error: string | null;
  /** {"exitCode":0} / {"bytes":123} / {"deleted":"file"} / {"source":"..."} */
  resultSummary: string | null;
  bootEpoch: number;
  pid: number | null;
  startedAt: string;
  settledAt: string | null;
}

export interface StartActionInput {
  /** 动作唯一 id（必填——铸造责任归记录层：env/machine 自铸含 boot 纪元；
   *  调用方显式传入 = 去重协议位，跨 boot 复用是预期行为） */
  actionId: string;
  deviceId?: string;
  onlineSessionId?: string | null;
  invokeId?: string | null;
  conversationId?: string | null;
  toolCallId?: string | null;
  source: ActionSource;
  kind: ActionKind;
  target?: string;
  contentHash?: string | null;
  contentBytes?: number | null;
  pid?: number | null;
}

export type SettleVerdict =
  | { status: "succeeded"; resultSummary?: Record<string, unknown> }
  | { status: "failed"; error: string; resultSummary?: Record<string, unknown> }
  | { status: "interrupted"; error?: string; resultSummary?: Record<string, unknown> };

export interface SweepReport {
  /** 旧纪元 running 行经 hash 核对追认成功（且回执修复）的数量 */
  upgradedToSucceeded: number;
  /** 裁决为 interrupted 的数量 */
  markedInterrupted: number;
  /** 裁决为 unknown（转检查）的数量 */
  markedUnknown: number;
  /** 修剪掉的终态行数量 */
  pruned: number;
}
