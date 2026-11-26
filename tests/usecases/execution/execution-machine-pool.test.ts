/**
 * 执行机资源池快照（machinePoolSnapshot）单测。
 *
 * 统一注册制：全部条目均为 connector 注册设备（devices 表投影，含离线）——
 * 无内置 local 特条目、无 currentMachineId（无默认机语义）。
 */
import { describe, it, expect } from "vitest";
import { machinePoolSnapshot } from "@usecases/execution/execution-machine-pool";

function devices(...rows: Array<{ deviceId: string; name: string; online: boolean; lastSeenAt: string | null }>) {
  return async () => rows;
}

describe("machinePoolSnapshot (uniform registration)", () => {
  it("设备全量透传（含离线设备与 lastSeenAt）", async () => {
    const snapshot = await machinePoolSnapshot(devices(
      { deviceId: "dev-a", name: "中枢本机", online: true, lastSeenAt: "2026-11-25T15:00:00Z" },
      { deviceId: "dev-b", name: "开发机", online: false, lastSeenAt: "2026-11-25T14:02:00Z" },
    ));
    expect(snapshot).toEqual({
      machines: [
        { id: "dev-a", name: "中枢本机", online: true, lastSeenAt: "2026-11-25T15:00:00Z" },
        { id: "dev-b", name: "开发机", online: false, lastSeenAt: "2026-11-25T14:02:00Z" },
      ],
    });
  });

  it("空设备表 → 空池（无内置特例条目）", async () => {
    const snapshot = await machinePoolSnapshot(devices());
    expect(snapshot.machines).toEqual([]);
    expect("currentMachineId" in snapshot).toBe(false);
  });

  it("数据源抛错不吞（fail-loud——快照故障让调用方吵着失败）", async () => {
    await expect(machinePoolSnapshot(async () => { throw new Error("db down"); })).rejects.toThrow("db down");
  });
});
