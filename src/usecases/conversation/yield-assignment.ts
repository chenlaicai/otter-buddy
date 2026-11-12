import type { Invoke } from "@entities/conversation/invoke";
import { DomainError } from "@entities/errors";
import type { InvokeRepository } from "./invoke-repository";

/** 受限外部会话的交棒在写 invoke/entries 和路由派发之前收口，不能仅靠 App 事后发现。 */
function assertExternalYieldAllowed(invoke: Invoke, targets: string[], assignmentRole?: "reviewer"): void {
  if (invoke.metadata?.externalProfile === 'restricted' &&
      (targets.length !== 1 || targets[0] !== 'user' || assignmentRole)) {
    throw new DomainError('受限外部会话只能 yield 给 user，禁止海獭编排与 reviewer 派工', 'forbidden');
  }
}

/** 把本次派工角色写到派发方 invoke；链引擎从该行把角色传给下一 hop。 */
export async function markYieldAssignment(
  invokeRepo: Pick<InvokeRepository, "updateInvokeMetadata">,
  invoke: Invoke,
  assignmentRole: "reviewer" | undefined,
  targets: string[],
): Promise<void> {
  assertExternalYieldAllowed(invoke, targets, assignmentRole);
  if (!assignmentRole) return;
  invoke.metadata = { ...(invoke.metadata ?? {}), yieldAssignmentRole: assignmentRole };
  await invokeRepo.updateInvokeMetadata(invoke.id, invoke.metadata);
}
