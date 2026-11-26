import type { RemoteActionRequest, RemoteActionStatus } from "@entities/execution/remote-action-request";

/**
 * 远程动作请求登记仓库（remote_action_requests）。
 * 登记（requested）→ 回执/超时/断线收尾（五态终态）——中枢侧「落 unknown」的落点。
 */
export interface RemoteActionRegistry {
  /** 发起前登记（requested）；actionId 已存在返回 false（调用方 fail-closed 拒重复下发） */
  recordRequest(req: RemoteActionRequest): Promise<boolean>;
  /** 回执/超时/断线收尾：落终态（幂等——已终态不覆盖，先到的真相保持） */
  settleRequest(actionId: string, status: Exclude<RemoteActionStatus, "requested">, settledAt: string, result?: unknown, error?: string): Promise<void>;
  /** 按状态查（对账/诊断面） */
  listByStatuses(statuses: RemoteActionStatus[], limit?: number): Promise<RemoteActionRequest[]>;
  /** 恢复路由与摘要数据源：精确查一个 invoke 的动作，deviceId 即原执行机。
   *  不按当前可用机器或对话绑定推断。 */
  listByInvoke(invokeId: string, limit?: number): Promise<RemoteActionRequest[]>;
  /** 恢复摘要数据源：按 conversation 查该会话的远程动作五态（含 requested 在途行）。
   * order 缺省 asc（恢复链既有语义）；desc=最近优先（展示面——避免 ASC LIMIT 丢最新） */
  listByConversation(conversationId: string, limit?: number, order?: "asc" | "desc"): Promise<RemoteActionRequest[]>;
  /** 断线收尾批量：某 onlineSession 的全部 requested 行落指定终态（分流：
   *  interrupted=优雅下线确定性裁决 / unknown=意外断开真相不明；先到真相幂等保护） */
  markSessionRequests(onlineSessionId: string, status: "interrupted" | "unknown", settledAt: string, error: string): Promise<number>;
  /** 中枢启动收口：残留 requested 行全部落 unknown（硬崩溃后 boot sweep 路径——
   * 会话行清扫时在途动作无人收尾，真相不明；检视补齐） */
  sweepStaleRequested(settledAt: string): Promise<number>;
}
