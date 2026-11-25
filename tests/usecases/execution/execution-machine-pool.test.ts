/**
 * 执行机资源池快照（machinePoolSnapshot）单测。
 *
 * F20261125expot PR-1：/api/execution-machines 与 list_execution_machines
 * 工具共用同一投影。验证：
 * - local（Registry 恒在）补齐 online=true / lastSeenAt=null
 * - devices 全量透传（含离线设备——Registry 投影下线即注销，离线只有此处可见）
 * - deviceStatus 缺省退化仅 local（旧装配/测试兼容）
 * - currentMachineId 透传
 */
import { describe, it, expect } from "vitest";
import { machinePoolSnapshot } from "@usecases/execution/execution-machine-pool";

function makeRegistry(options?: { machines?: Array<{ id: string; name: string }>; currentId?: string }) {
  const machines = options?.machines ?? [{ id: "local", name: "hub-local" }];
  return {
    list: () => machines,
    currentMachineId: () => options?.currentId ?? "local",
  };
}

describe("machinePoolSnapshot", () => {
  it("local 条目补齐 online=true / lastSeenAt=null（字段形态与设备一致）", async () => {
    const snapshot = await machinePoolSnapshot(makeRegistry());
    expect(snapshot.machines[0]).toEqual({ id: "local", name: "hub-local", online: true, lastSeenAt: null, local: true });
    expect(snapshot.currentMachineId).toBe("local");
  });

  it("Registry 无 currentId 匹配项时回退 {id: currentId, name: currentId} 且仍在线", async () => {
    const snapshot = await machinePoolSnapshot(makeRegistry({ machines: [], currentId: "custom-id" }));
    expect(snapshot.machines[0]).toEqual({ id: "custom-id", name: "custom-id", online: true, lastSeenAt: null, local: true });
  });

  it("devices 全量透传（含离线）且排在 local 之后", async () => {
    const snapshot = await machinePoolSnapshot(
      makeRegistry({ machines: [{ id: "local", name: "中枢机" }] }),
      async () => [
        { deviceId: "dev-111", name: "旧笔记本", online: true, lastSeenAt: "2026-11-25T02:00:00Z" },
        { deviceId: "dev-222", name: "台式机", online: false, lastSeenAt: null },
      ],
    );
    expect(snapshot.machines).toHaveLength(3);
    expect(snapshot.machines[1]).toEqual({ id: "dev-111", name: "旧笔记本", online: true, lastSeenAt: "2026-11-25T02:00:00Z" });
    expect(snapshot.machines[2]).toEqual({ id: "dev-222", name: "台式机", online: false, lastSeenAt: null });
  });

  it("deviceStatus 缺省退化仅 local（旧装配兼容）", async () => {
    const snapshot = await machinePoolSnapshot(makeRegistry(), undefined);
    expect(snapshot.machines).toHaveLength(1);
    expect(snapshot.machines[0].id).toBe("local");
  });

  it("deviceStatus 抛错时向上传播（fail-loud——感知面不吞数据源故障）", async () => {
    await expect(
      machinePoolSnapshot(makeRegistry(), async () => {
        throw new Error("db unavailable");
      }),
    ).rejects.toThrow("db unavailable");
  });
});
