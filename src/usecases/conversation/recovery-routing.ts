import type { RemoteActionRequest } from "@entities/execution/remote-action-request";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { ExecutionMachinePoolProvider } from "@usecases/execution/execution-machine-gate";
import type { Logger } from "@usecases/ports/logger";

export interface RecoveryActionChain {
  rows: RemoteActionRequest[];
  machineIds: string[];
}

interface RecoveryRoutingDeps {
  invokeRepo: InvokeRepository;
  entryRepo: Pick<EntryRepository, "getEntryById">;
  remoteActions?: { listByInvoke(invokeId: string, limit?: number): Promise<RemoteActionRequest[]> };
  machinePool?: ExecutionMachinePoolProvider;
  onOriginalMachinesUnavailable?: (machineIds: string[]) => Promise<void>;
  logger: Logger;
}

interface ResumeTrigger {
  deviceOnline?: string;
}

/** 逐代读取恢复祖先；只有真实存在的入口 entry 能终止遍历，其余断链均 fail-closed。 */
async function collectRecoveryActionRows(
  deps: RecoveryRoutingDeps,
  invokeId: string,
  fetchLimit: number,
): Promise<RemoteActionRequest[]> {
  const remoteActions = deps.remoteActions;
  if (!remoteActions) throw new Error("remote action registry unavailable");
  const rows: RemoteActionRequest[] = [];
  const visited = new Set<string>();
  let currentId: string | null = invokeId;
  let isCurrent = true;
  while (currentId) {
    if (visited.has(currentId)) throw new Error(`recovery invoke cycle detected: ${currentId}`);
    visited.add(currentId);
    const invoke = await deps.invokeRepo.getInvokeById(currentId);
    if (!invoke) {
      if (isCurrent) throw new Error(`interrupted invoke record missing: ${currentId}`);
      const terminalEntry = await deps.entryRepo.getEntryById(currentId);
      if (!terminalEntry) throw new Error(`recovery ancestor record missing: ${currentId}`);
      break;
    }
    isCurrent = false;
    const actions = await remoteActions.listByInvoke(currentId, fetchLimit);
    if (actions.length >= fetchLimit) {
      throw new Error(`recovery action evidence truncated: ${currentId} (limit=${fetchLimit})`);
    }
    rows.push(...actions);
    currentId = invoke.triggerEntryId;
  }
  return rows;
}

/** 收集当前恢复轮及其祖先的真实动作。恢复者可能尚未产生新动作，不能只查当前 invoke。 */
export async function loadRecoveryActionChain(
  deps: RecoveryRoutingDeps,
  invokeId: string,
  fetchLimit: number,
  trigger?: ResumeTrigger,
): Promise<RecoveryActionChain | null> {
  if (!deps.remoteActions) return trigger?.deviceOnline ? null : { rows: [], machineIds: [] };
  try {
    const rows = await collectRecoveryActionRows(deps, invokeId, fetchLimit);
    const machineIds = [...new Set(rows.map(row => row.deviceId))].sort();
    if (machineIds.some(id => id.length === 0)) throw new Error(`recovery action has empty deviceId: ${invokeId}`);
    if (trigger?.deviceOnline && !machineIds.includes(trigger.deviceOnline)) return null;
    return { rows, machineIds };
  } catch (err) {
    // 不能证明原机与动作终态时不点火；保留 pending 等下一次启动或设备上线。
    deps.logger.warn("resume routing evidence unavailable; item stays pending", {
      invokeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** 所有原机均在线才允许认领。等待不消耗 attempts，也绝不换成其他在线机器。 */
export async function originalMachinesReady(
  deps: RecoveryRoutingDeps,
  invokeId: string,
  machineIds: string[],
): Promise<boolean> {
  if (machineIds.length === 0) return true;
  if (!deps.machinePool) {
    deps.logger.warn("resume machine pool unavailable; item stays pending", { invokeId, machineIds });
    return false;
  }
  let snapshot: Awaited<ReturnType<ExecutionMachinePoolProvider>>;
  try {
    snapshot = await deps.machinePool();
  } catch (err) {
    deps.logger.warn("resume machine pool query failed; item stays pending", {
      invokeId,
      machineIds,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const unavailable = machineIds.filter(id => !snapshot.machines.some(machine => machine.id === id && machine.online));
  if (unavailable.length > 0) {
    deps.logger.info("resume waits for original execution machines", { invokeId, machineIds: unavailable });
    try {
      await deps.onOriginalMachinesUnavailable?.(unavailable);
    } catch (err) {
      deps.logger.warn("resume original-machine healing write failed", {
        invokeId, machineIds: unavailable, error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
  return true;
}
