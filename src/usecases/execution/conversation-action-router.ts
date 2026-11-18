import type {
  ActionRunOptions,
  ActionRunner,
  ExecutionAction,
  ExecutionActionResult,
  ExecutionActionType,
  ExecutionMachine,
} from "@usecases/ports/execution-machine";

/**
 * F20261118crtgr（#1868 阶段 5 PR-A）：对话级执行机路由——workspace 六动作工具
 * 按对话当前执行机下发。
 *
 * 路由序（方案 stage5 §2.2）：显式 targetOverride 优先 → 对话 current_machine_id
 * （conversations 列，NULL=默认）→ Registry 默认（local）。六动作 input 均携带
 * conversationId（C2 已验证），无需 ToolContext。
 *
 * 边界（SDK 面不路由）：pi-session-factory 的 createExecutionEnvironment 仍走
 * Registry 直连（恒 local 解析）——远程对话的 SDK 文件/bash 面落 hub 本地，
 * 与协议 v1「只放六动作」一致（方案 v3 §9），阶段 7 对齐。
 *
 * fail-closed 语义：对话指向的机器未注册（设备撤销/从未上线）时 resolve 抛
 * 「machine not registered」——不静默回切 local（防「以为在 B 干活其实在 A」）。
 */
export class ConversationActionRouter implements ActionRunner {
  constructor(
    private readonly registry: { resolve(targetMachineId?: string): ExecutionMachine },
    private readonly conversations: { getExecutionMachineId(id: string): Promise<string | null> },
  ) {}

  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    targetOverride?: string,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    const target = targetOverride
      ?? await this.conversationMachineOf(action.input as { conversationId?: unknown })
      ?? undefined;
    const machine = this.registry.resolve(target);
    return machine.run(action, targetOverride, options);
  }

  /** 六动作 input 提取 conversationId → 查对话当前机（无/查询失败回落 null=默认） */
  private async conversationMachineOf(input: { conversationId?: unknown }): Promise<string | null> {
    const conversationId = typeof input.conversationId === "string" ? input.conversationId : null;
    if (!conversationId) return null;
    try {
      return await this.conversations.getExecutionMachineId(conversationId);
    } catch {
      return null; // 查询失败回落默认（local）——工具可用性优先，路由是增强不是硬依赖
    }
  }
}
