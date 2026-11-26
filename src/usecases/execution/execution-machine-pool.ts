import type { ExecutionMachinePoolSnapshot } from "@usecases/ports/execution-machine";

/**
 * 执行机资源池快照（感知层）。
 *
 * 单一投影实现：HTTP `/api/execution-machines`（Web）与 agent 工具
 * `list_execution_machines`（海獭感知）共用，避免两处独立拼装漂移。
 * 统一注册制：全部条目均为 connector 注册设备（中枢机器也由 supervisor
 * 拉起本机 connector 注册，无内置特权机）；设备全量含离线（离线设备只有
 * connectorRegistry 的 devices 表可见——Registry 投影下线即注销）。
 */
export async function machinePoolSnapshot(
  deviceStatus: () => Promise<Array<{ deviceId: string; name: string; online: boolean; lastSeenAt: string | null }>>,
): Promise<ExecutionMachinePoolSnapshot> {
  const devices = (await deviceStatus()).map((d) => ({
    id: d.deviceId,
    name: d.name,
    online: d.online,
    lastSeenAt: d.lastSeenAt,
  }));
  return { machines: devices };
}
