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
  /** 按状态查（对账/诊断面） */
  listByStatuses(statuses: RemoteActionStatus[], limit?: number): Promise<RemoteActionRequest[]>;
  /** R2 恢复摘要数据源：按 conversation 查该会话的远程动作五态（含 requested 在途行） */
  listByConversation(conversationId: string, limit?: number): Promise<RemoteActionRequest[]>;
  /** 断线收尾批量：某 onlineSession 的全部 requested 行落指定终态（C3 分流：
   *  interrupted=优雅下线确定性裁决 / unknown=意外断开真相不明；先到真相幂等保护） */
  markSessionRequests(onlineSessionId: string, status: "interrupted" | "unknown", settledAt: string, error: string): Promise<number>;
}
