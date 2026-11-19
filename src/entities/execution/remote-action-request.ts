/**
 * 中枢侧远程动作请求登记（落点 + 闭环）。
 * 中枢对远程动作的机器真相投影——connector 台账仍是机器侧真相源（端上核对与
 * connector 重启恢复用），本表记 result 帧回执的五态供恢复链摘要裁决（远程动作
 * 在中枢可裁决，不再因数据源断裂退化旧文案）。
 * actionId = `<中枢bootEpoch>-<uuid>`（跨重启唯一，防碰撞错误去重）。
 */

export type RemoteActionStatus = "requested" | "succeeded" | "failed" | "interrupted" | "unknown";

export interface RemoteActionRequest {
  actionId: string;
  onlineSessionId: string;
  deviceId: string;
  actionType: string;
  status: RemoteActionStatus;
  error: string | null;
  result: string | null;
  createdAt: string;
  settledAt: string | null;
  /** 关联维度（nullable）：conversation 取自六动作 input.conversationId；
   * invokeId 取 hub 进程内 invoke 上下文（otterInvokeStorage——RemoteExecutionMachine
   * 运行于中枢侧，调用发生在 agent invoke 上下文内时可得） */
  conversationId: string | null;
  invokeId: string | null;
}
