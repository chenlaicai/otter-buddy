import type { RemoteActionRequest, RemoteActionStatus } from "@entities/execution/remote-action-request";

/**
 * F20261118remex（#1868 阶段 4 C2）：远程动作请求登记仓库（remote_action_requests）。
 * 登记（requested）→ 回执/超时/断线收尾（五态终态）——中枢侧「落 unknown」的落点。
 */
export interface RemoteActionRegistry {
  /** 发起前登记（requested）；actionId 已存在返回 false（调用方 fail-closed 拒重复下发） */
  recordRequest(req: RemoteActionRequest): Promise<boolean>;
  /** 回执/超时/断线收尾：落终态（幂等——已终态不覆盖，先到的真相保持） */
  settleRequest(actionId: string, status: Exclude<RemoteActionStatus, "requested">, settledAt: string, result?: unknown, error?: string): Promise<void>;
  /** 按 invoke 维度查（恢复摘要数据源——R2 并入） */
  listByStatuses(statuses: RemoteActionStatus[], limit?: number): Promise<RemoteActionRequest[]>;
  /** 断线收尾批量：某 onlineSession 的全部 requested 行落 unknown（先到真相幂等保护） */
  markSessionRequestsUnknown(onlineSessionId: string, settledAt: string): Promise<number>;
}
