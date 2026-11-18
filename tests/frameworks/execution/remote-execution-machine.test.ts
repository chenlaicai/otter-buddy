import { describe, expect, it, beforeEach } from "vitest";
import { SqliteConnectorRegistryRepository } from "@frameworks/db/execution/sqlite-connector-registry-repository";
import { SqliteRemoteActionRegistry } from "@frameworks/db/execution/sqlite-remote-action-registry";
import { RemoteExecutionMachine } from "@frameworks/execution/remote-execution-machine";
import type { ConnectorActionChannel } from "@frameworks/execution/connector-ws-gateway";
import type { ConnectorFrame } from "@entities/execution/connector-protocol";
import { createTestDb } from "../../helpers/db";
import type { Device } from "@entities/execution/device";
import type { OnlineSession } from "@entities/execution/online-session";

/**
 * F20261118remex（#1868 阶段 4 C2）：RemoteExecutionMachine 单测——
 * 总闸①（online_sessions 事实源直查）/登记幂等/回执分发/超时落 unknown/
 * 会话下线批量收尾（方案 v3 §5 五态纪律）。
 */

const T0 = 1731801600000; // 2026-11-17T00:00:00Z
const DEVICE_ID = "conn-dev-1";

/** 可编程 fake channel：捕获下发帧、手动注 result 帧/下线事件 */
function fakeChannel(): ConnectorActionChannel & {
  sent: ConnectorFrame[];
  setSendOk: (ok: boolean) => void;
  emitResult: (actionId: string, status: "succeeded" | "failed" | "interrupted" | "unknown", result?: unknown, error?: string) => void;
  emitSessionDown: (sessionId: string) => void;
} {
  const sent: ConnectorFrame[] = [];
  let sendOk = true;
  let resultHandler: ((frame: Extract<ConnectorFrame, { type: "action.result" }>) => void) | null = null;
  let downHandler: ((sessionId: string, deviceId: string) => void) | null = null;
  return {
    sent,
    setSendOk: ok => { sendOk = ok; },
    emitResult: (actionId, status, result, error) => {
      resultHandler?.({ v: 1, type: "action.result", seq: 1, sid: "s1", data: { actionId, status, ...(status === "succeeded" ? { result } : { error: error ?? "x" }) } });
    },
    emitSessionDown: sessionId => { downHandler?.(sessionId, DEVICE_ID); },
    sendToDevice: (_deviceId, frame) => {
      if (!sendOk) return false;
      sent.push(frame);
      return true;
    },
    onActionResult: handler => { resultHandler = handler; },
    onSessionDown: handler => { downHandler = handler; },
  };
}

function setup(opts: { online?: boolean; timeoutMs?: number } = {}) {
  const db = createTestDb();
  const connectorRepo = new SqliteConnectorRegistryRepository(db);
  const remoteActions = new SqliteRemoteActionRegistry(db);
  const channel = fakeChannel();
  const machine = new RemoteExecutionMachine(DEVICE_ID, "测试连接器", {
    channel,
    remoteActions,
    connectorRegistry: connectorRepo,
    hubBootEpoch: 1000,
    actionTimeoutMs: opts.timeoutMs ?? 60_000,
    now: () => T0,
  });
  machine.wireChannel();
  return { db, connectorRepo, remoteActions, channel, machine };
}

async function seedOnlineSession(repo: SqliteConnectorRegistryRepository, sessionId = "sess-1"): Promise<string> {
  const device: Device = { id: DEVICE_ID, name: "测试连接器", pairToken: "tok-1", createdAt: new Date(T0).toISOString(), lastSeenAt: null };
  await repo.createDevice(device);
  const session: OnlineSession = {
    id: sessionId, deviceId: DEVICE_ID, status: "online",
    connectedAt: new Date(T0).toISOString(), disconnectedAt: null, disconnectReason: null,
    lastSeenAt: new Date(T0).toISOString(), protocolVersion: 1,
  };
  await repo.openOnlineSession(session);
  return sessionId;
}

describe("RemoteExecutionMachine（C2 执行通道核心）", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => { h = setup(); });

  it("总闸①：设备无 online 会话 → fail-closed 拒发（不下发不登记）", async () => {
    await expect(h.machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "a.txt" } }))
      .rejects.toThrow("connector device offline or unpaired");
    expect(h.channel.sent).toHaveLength(0);
    expect(await h.remoteActions.listByStatuses(["requested"])).toHaveLength(0);
  });

  it("在线 → 登记下发，result 帧回执 resolve + 登记行落 succeeded", async () => {
    await seedOnlineSession(h.connectorRepo);
    const pending = h.machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "a.txt" } });
    await new Promise(r => setTimeout(r, 0)); // 登记完成
    expect(h.channel.sent).toHaveLength(1);
    const frame = h.channel.sent[0] as Extract<ConnectorFrame, { type: "action.request" }>;
    expect(frame.type).toBe("action.request");
    const actionId = frame.data.actionId;
    expect(actionId.startsWith("1000-")).toBe(true); // hubBootEpoch 前缀

    h.channel.emitResult(actionId, "succeeded", "file-content");
    await expect(pending).resolves.toBe("file-content");
    const rows = await h.remoteActions.listByStatuses(["succeeded"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe(JSON.stringify("file-content"));
    expect(rows[0]!.conversationId).toBe("c1"); // R2 关联维度落值
  });

  it("自铸 actionId 前缀跨重启唯一（bootEpoch 防碰撞）；透传 actionId 优先", async () => {
    await seedOnlineSession(h.connectorRepo);
    const p1 = h.machine.run({ type: "workspace.exists", input: { conversationId: "c1" } });
    await new Promise(r => setTimeout(r, 0));
    const id1 = (h.channel.sent[0] as Extract<ConnectorFrame, { type: "action.request" }>).data.actionId;
    h.channel.emitResult(id1, "succeeded", true);
    await p1;

    const p2 = h.machine.run({ type: "workspace.exists", input: { conversationId: "c1" } }, undefined, { actionId: "caller-42" });
    await new Promise(r => setTimeout(r, 0));
    const frame2 = h.channel.sent[1] as Extract<ConnectorFrame, { type: "action.request" }>;
    expect(frame2.data.actionId).toBe("caller-42"); // 调用方透传优先
    h.channel.emitResult("caller-42", "succeeded", false);
    await p2;
  });

  it("重复 actionId → fail-closed 拒重复下发（登记 PK 冲突）", async () => {
    await seedOnlineSession(h.connectorRepo);
    const first = h.machine.run({ type: "workspace.exists", input: { conversationId: "c1" } }, undefined, { actionId: "dup-1" });
    await new Promise(r => setTimeout(r, 0));
    await expect(h.machine.run({ type: "workspace.exists", input: { conversationId: "c1" } }, undefined, { actionId: "dup-1" }))
      .rejects.toThrow("duplicate remote actionId: dup-1");
    expect(h.channel.sent).toHaveLength(1); // 未二次下发
    h.channel.emitResult("dup-1", "succeeded", true);
    await first;
  });

  it("failed 回执 → reject + 登记行落 failed（error 带回）", async () => {
    await seedOnlineSession(h.connectorRepo);
    const pending = h.machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "no.txt" } });
    await new Promise(r => setTimeout(r, 0));
    const actionId = (h.channel.sent[0] as Extract<ConnectorFrame, { type: "action.request" }>).data.actionId;
    h.channel.emitResult(actionId, "failed", undefined, "ENOENT");
    await expect(pending).rejects.toThrow("ENOENT");
    expect(await h.remoteActions.listByStatuses(["failed"])).toHaveLength(1);
  });

  it("超时 → 落 unknown（不盲重试）+ 等待者 reject", async () => {
    const h2 = setup({ timeoutMs: 40 });
    await seedOnlineSession(h2.connectorRepo);
    await expect(h2.machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "a.txt" } }))
      .rejects.toThrow("remote action timeout");
    const rows = await h2.remoteActions.listByStatuses(["unknown"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toContain("timeout");
  });

  it("总闸③：通道不可用（sendToDevice false）→ 登记行落 unknown + 拒发", async () => {
    await seedOnlineSession(h.connectorRepo);
    h.channel.setSendOk(false);
    await expect(h.machine.run({ type: "workspace.exists", input: { conversationId: "c1" } }))
      .rejects.toThrow("connector channel unavailable");
    expect(await h.remoteActions.listByStatuses(["unknown"])).toHaveLength(1);
  });

  it("会话下线钩子：在途等待 reject + 该会话 requested 行批量落 unknown", async () => {
    await seedOnlineSession(h.connectorRepo, "sess-A");
    const p1 = h.machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "a.txt" } });
    const p2 = h.machine.run({ type: "workspace.write", input: { conversationId: "c1", relativePath: "b.txt", content: "x" } });
    await new Promise(r => setTimeout(r, 0));
    expect(await h.remoteActions.listByStatuses(["requested"])).toHaveLength(2);

    h.channel.emitSessionDown("sess-A"); // 断线/下线（C2 最小断线收尾）
    await expect(p1).rejects.toThrow("device session down");
    await expect(p2).rejects.toThrow("device session down");
    const unknowns = await h.remoteActions.listByStatuses(["unknown"]);
    expect(unknowns).toHaveLength(2);
    expect(unknowns.every(r => r.error === "device offline before result")).toBe(true);
  });

  it("M1（检视）：多设备串扰隔离——设备 A 下线不误杀设备 B 的在途请求", async () => {
    // 广播语义 channel（对齐网关 sessionDownHandlers 全局广播）
    const downHandlers: Array<(sessionId: string, deviceId: string) => void> = [];
    const resultHandlers: Array<(frame: Extract<ConnectorFrame, { type: "action.result" }>) => void> = [];
    const broadcastChannel: ConnectorActionChannel = {
      sendToDevice: () => true,
      onActionResult: handler => { resultHandlers.push(handler); },
      onSessionDown: handler => { downHandlers.push(handler); },
    };
    const machineA = new RemoteExecutionMachine("conn-dev-1", "A", {
      channel: broadcastChannel, remoteActions: h.remoteActions, connectorRegistry: h.connectorRepo, hubBootEpoch: 1000,
    });
    const machineB = new RemoteExecutionMachine("conn-dev-2", "B", {
      channel: broadcastChannel, remoteActions: h.remoteActions, connectorRegistry: h.connectorRepo, hubBootEpoch: 1000,
    });
    machineA.wireChannel();
    machineB.wireChannel();

    // 双设备各自在线（同库不同 session 行）
    await seedOnlineSession(h.connectorRepo, "sess-A");
    const deviceB: Device = { id: "conn-dev-2", name: "B", pairToken: "tok-2", createdAt: new Date(T0).toISOString(), lastSeenAt: null };
    await h.connectorRepo.createDevice(deviceB);
    const sessionB: OnlineSession = {
      id: "sess-B", deviceId: "conn-dev-2", status: "online",
      connectedAt: new Date(T0).toISOString(), disconnectedAt: null, disconnectReason: null,
      lastSeenAt: new Date(T0).toISOString(), protocolVersion: 1,
    };
    await h.connectorRepo.openOnlineSession(sessionB);

    const pendingA = machineA.run({ type: "workspace.exists", input: { conversationId: "cA" } }, undefined, { actionId: "m1-a" });
    const pendingB = machineB.run({ type: "workspace.exists", input: { conversationId: "cB" } }, undefined, { actionId: "m1-b" });
    await new Promise(r => setTimeout(r, 0));

    // 设备 A 会话下线（广播给所有 handler）——B 不受影响
    for (const handler of downHandlers) handler("sess-A", "conn-dev-1");
    await expect(pendingA).rejects.toThrow("device session down before result: sess-A");
    // B 的在途动作仍可正常回执（未被误杀）
    for (const handler of resultHandlers) handler({ v: 1, type: "action.result", seq: 1, sid: "sess-B", data: { actionId: "m1-b", status: "succeeded", result: true } });
    await expect(pendingB).resolves.toBe(true);

    // 收尾隔离：仅 sess-A 的行落 unknown，sess-B 的行落 succeeded
    const unknowns = await h.remoteActions.listByStatuses(["unknown"]);
    expect(unknowns.map(r => r.actionId)).toEqual(["m1-a"]);
    expect((await h.remoteActions.listByStatuses(["succeeded"])).map(r => r.actionId)).toEqual(["m1-b"]);
  });

  it("createExecutionEnvironment 不支持（远程无 SDK 执行环境——阶段 5/7 语义）", () => {
    expect(() => h.machine.createExecutionEnvironment("/tmp")).toThrow("does not host SDK execution environments");
  });
});

describe("SqliteRemoteActionRegistry（五态登记幂等）", () => {
  function reqRow(actionId: string): import("@entities/execution/remote-action-request").RemoteActionRequest {
    return {
      actionId, onlineSessionId: "s1", deviceId: DEVICE_ID, actionType: "workspace.write",
      status: "requested", error: null, result: null, createdAt: new Date(T0).toISOString(), settledAt: null,
      conversationId: "c1", invokeId: "inv-1",
    };
  }

  it("settleRequest 幂等：先到真相保持，晚到回执不改写", async () => {
    const db = createTestDb();
    const registry = new SqliteRemoteActionRegistry(db);
    expect(await registry.recordRequest(reqRow("a-1"))).toBe(true);
    // 重复登记拒（PK 冲突）
    expect(await registry.recordRequest(reqRow("a-1"))).toBe(false);

    await registry.settleRequest("a-1", "succeeded", new Date(T0).toISOString(), { bytes: 3 });
    // 晚到 unknown 不覆盖 succeeded
    await registry.settleRequest("a-1", "unknown", new Date(T0).toISOString(), undefined, "late");
    const rows = await registry.listByStatuses(["succeeded"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe(JSON.stringify({ bytes: 3 }));

    // R2：conversation 维度查询
    const byConv = await registry.listByConversation("c1");
    expect(byConv).toHaveLength(1);
    expect(byConv[0]!.invokeId).toBe("inv-1");
    expect(await registry.listByConversation("c-other")).toHaveLength(0);
  });

  it("m1（检视）：非 PK 冲突的库故障重抛（错误归因不错位）——表不存在的场景", async () => {
    const db = createTestDb();
    const registry = new SqliteRemoteActionRegistry(db);
    db.exec("DROP TABLE remote_action_requests");
    await expect(registry.recordRequest(reqRow("a-x"))).rejects.toThrow();
  });
});
