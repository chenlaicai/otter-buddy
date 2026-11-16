import type {
  ActionRecord,
  SettleVerdict,
  StartActionInput,
  SweepReport,
} from "@entities/execution/action-record";

/**
 * F20261116actlg：执行机动作台账端口（阶段 3，本机）。
 *
 * 执行机本地保存轻量动作台账（#1868 §3.D）：动作真实状态与结果。中枢侧
 * （恢复摘要、未来 Web 执行记录）只经此端口查询，不直接持有存储。
 *
 * 失败语义：台账是恢复增强面不是控制面——实现应尽量自愈（重试/降级为
 * no-op recording），不让记录失败打断真实动作执行。
 */
export interface ActionLedger {
  /**
   * 动作开始：落 running 行。若同 actionId 已有终态行（succeeded/failed/interrupted）
   * 返回 deduped=true——调用方应直接采用已记录结果，不重复执行（去重协议）。
   * 同 boot 内的 running 残留（同 actionId）允许重跑（覆盖为新一轮 running）。
   */
  start(input: StartActionInput): Promise<{ record: ActionRecord; deduped: boolean }>;

  /** 动作裁决落账（succeeded/failed/interrupted）。行不存在时静默（非致命）。 */
  settle(actionId: string, verdict: SettleVerdict, settledAt?: string): Promise<void>;

  /** 按 actionId 查询；无行 = not_found（查询层第五态）。 */
  getByActionId(actionId: string): Promise<ActionRecord | null>;

  /** 某 invoke 的动作清单（恢复摘要用，按 startedAt 升序）。 */
  listByInvoke(invokeId: string, limit?: number): Promise<ActionRecord[]>;

  /**
   * 开机清扫：旧 bootEpoch 的 running 行裁决——
   * 文件写按 content hash 核对（命中→succeeded 且回执修复；不中→interrupted），
   * rename/remove/mkdir/truncate→interrupted（幂等可重做），shell.exec→unknown（转检查）。
   * 附带终态行修剪（保留策略由实现定义）。
   */
  sweepStaleBoot(): Promise<SweepReport>;

  /** 关闭存储（进程退出）。 */
  close(): void;
}
