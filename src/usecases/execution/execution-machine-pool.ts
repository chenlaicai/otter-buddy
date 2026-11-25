import type { ExecutionMachinePoolSnapshot } from "@usecases/ports/execution-machine";

/**
 * 执行机资源池快照（F20261125expot PR-1 感知层）。
 *
 * 单一投影实现：HTTP `/api/execution-machines`（Web）与 agent 工具
 * `list_execution_machines`（海獭感知）共用，避免两处独立拼装漂移。
 * 数据源与 router 既有语义一致：local（Registry 恒在）+ devices 表全量含离线
 * （Registry 投影下线即注销，离线设备只有 connectorRegistry 可见）。
 */
export async function machinePoolSnapshot(
  registry: {
    list(): Array<{ id: string; name: string }>;
    currentMachineId(): string;
  },
  deviceStatus?: () => Promise<Array<{ deviceId: string; name: string; online: boolean; lastSeenAt: string | null }>>,
): Promise<ExecutionMachinePoolSnapshot> {
  const currentId = registry.currentMachineId();
  const local = registry.list().find((m) => m.id === currentId) ?? { id: currentId, name: currentId };
  // local 恒在线：中枢自身进程在跑，本机执行机即在场（Web 既有投影语义补齐字段）；
  // local:true 显式信号——isDevice 判别不靠 online 字段缺省推断（检视 S1：字段缺省判别符脆弱）
  const localEntry = { ...local, online: true, lastSeenAt: null as string | null, local: true };
  const devices =
    (await deviceStatus?.())?.map((d) => ({
      id: d.deviceId,
      name: d.name,
      online: d.online,
      lastSeenAt: d.lastSeenAt,
    })) ?? [];
  return { machines: [localEntry, ...devices], currentMachineId: currentId };
}
