import type { Invoke } from "@entities/conversation/invoke";
import type { InvokeRepository } from "./invoke-repository";

/** 把本次派工角色写到派发方 invoke；链引擎从该行把角色传给下一 hop。 */
export async function markYieldAssignment(
  invokeRepo: Pick<InvokeRepository, "updateInvokeMetadata">,
  invoke: Invoke,
  assignmentRole: "reviewer" | undefined,
): Promise<void> {
  if (!assignmentRole) return;
  invoke.metadata = { ...(invoke.metadata ?? {}), yieldAssignmentRole: assignmentRole };
  await invokeRepo.updateInvokeMetadata(invoke.id, invoke.metadata);
}
