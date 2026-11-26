import { describe, expect, it } from "vitest";
import { SqliteRemoteActionRegistry } from "@frameworks/db/execution/sqlite-remote-action-registry";
import type { RemoteActionRequest } from "@entities/execution/remote-action-request";
import { createTestDb } from "../../../helpers/db";

function request(invokeId: string, actionId: string, deviceId: string): RemoteActionRequest {
  return {
    actionId,
    onlineSessionId: `session-${deviceId}`,
    deviceId,
    actionType: "shell.exec",
    status: "requested",
    error: null,
    result: null,
    createdAt: "2026-11-25T00:00:00Z",
    settledAt: null,
    conversationId: "conv-1",
    invokeId,
  };
}

describe("SqliteRemoteActionRegistry 恢复路由查询", () => {
  it("listByInvoke 只返回目标 invoke 的动作并保留 deviceId", async () => {
    const db = createTestDb();
    const registry = new SqliteRemoteActionRegistry(db);
    await registry.recordRequest(request("invoke-a", "action-a1", "connector-a"));
    await registry.recordRequest(request("invoke-b", "action-b1", "connector-b"));
    await registry.recordRequest(request("invoke-a", "action-a2", "connector-a"));

    const rows = await registry.listByInvoke("invoke-a");
    expect(rows.map(row => row.actionId)).toEqual(["action-a1", "action-a2"]);
    expect(rows.every(row => row.deviceId === "connector-a")).toBe(true);
    expect(await registry.listByInvoke("invoke-missing")).toEqual([]);
    db.close();
  });
});
