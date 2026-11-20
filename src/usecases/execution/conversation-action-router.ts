import type {
  ActionRunOptions,
  ExecutionAction,
  ExecutionActionResult,
  ExecutionActionType,
  ExecutionMachine,
  ExecutionMachineRouter,
} from "@usecases/ports/execution-machine";

/**
 * 对话级执行机路由——workspace 六动作工具
 * 按对话当前执行机下发。
 *
 * 路由序（方案 stage5）：显式 targetOverride 优先 → 对话 current_machine_id
 * （conversations 列，NULL=默认）→ Registry 默认（local）。六动作 input 均携带
 * conversationId（已验证），无需 ToolContext。
 *
 * SDK env 也经本路由解析：bash 在远程机上显式执行；尚未支持的文件能力
 * 返回 not_supported，不回退 hub 本机。
 *
 * fail-closed 语义：对话指向的机器未注册（设备撤销/从未上线）时 resolve 抛
 * 「machine not registered」——不静默回切 local（防「以为在 B 干活其实在 A」）。
 */
export class ConversationActionRouter implements ExecutionMachineRouter {
  constructor(
    private readonly registry: { resolve(targetMachineId?: string): ExecutionMachine },
    private readonly conversations: { getExecutionMachineId(id: string): Promise<string | null> },
  ) {}

  resolve(targetMachineId?: string): ExecutionMachine {
    return this.registry.resolve(targetMachineId);
  }

  /** SDK env 工厂的业务对话入口；无对话/未选择时沿用默认本机。 */
  async resolveForConversation(conversationId?: string): Promise<ExecutionMachine> {
    if (!conversationId) return this.registry.resolve();
    const selected = await this.conversations.getExecutionMachineId(conversationId);
    return this.registry.resolve(selected ?? undefined);
  }

  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    targetOverride?: string,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    const target = targetOverride
      ?? await this.conversationMachineOf(action.input as { conversationId?: unknown })
      ?? undefined;
    const machine = this.registry.resolve(target);
    return machine.run(action, undefined, options); // 对齐 Registry 转发语义（机器自身忽略 target）
  }

  /** 六动作 input 提取 conversationId → 查对话当前机（无配置/无 conversationId 返回 null
   * = 默认 local；查询失败**抛错**——（检视）：无法读配置=不知道指向哪，落 local 是
   * 危险方向的猜测（「以为在 B 其实在 A」），与悬空目标同 fail-closed） */
  private async conversationMachineOf(input: { conversationId?: unknown }): Promise<string | null> {
    const conversationId = typeof input.conversationId === "string" ? input.conversationId : null;
    if (!conversationId) return null;
    return await this.conversations.getExecutionMachineId(conversationId);
  }
}
