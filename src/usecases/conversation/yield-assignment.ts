import type { EntryRepository } from "./entry-repository";

/** 从触发下一跳的 yield entry 继承本次派工角色；不经提示词或模型转述。 */
export async function inheritYieldAssignmentMetadata(
  entryRepo: Pick<EntryRepository, "getEntryById">,
  triggerEntryId: string | undefined,
  metadata: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown> | null> {
  const trigger = triggerEntryId ? await entryRepo.getEntryById(triggerEntryId) : null;
  const assignmentRole = trigger?.entryType === "yield" ? trigger.metadata?.assignmentRole : undefined;
  return assignmentRole === "reviewer" ? { ...(metadata ?? {}), assignmentRole } : metadata ?? null;
}
