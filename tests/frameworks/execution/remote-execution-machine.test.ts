import { describe, expect, it, beforeEach } from "vitest";
import { SqliteConnectorRegistryRepository } from "@frameworks/db/execution/sqlite-connector-registry-repository";
import { SqliteRemoteActionRegistry } from "@frameworks/db/execution/sqlite-remote-action-registry";
import { RemoteExecutionMachine } from "@frameworks/execution/remote-execution-machine";
import type { ConnectorActionChannel } from "@frameworks/execution/connector-ws-gateway";
import type { ConnectorFrame } from "@entities/execution/connector-protocol";
import { createTestDb } from "../../helpers/db";
import type { Device } from "@entities/execution/device";
import type { OnlineSession } from "@entities/execution/online-session";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/**
 * RemoteExecutionMachine 单测——
 * 总闸①（online_sessions 事实源直查）/登记幂等/回执分发/超时落 unknown/
 * 会话下线批量收尾（五态纪律）。
 */

const T0 = 1731801600000; // 2026-11-17T00:00:00Z
const DEVICE_ID = "conn-dev-1";

/** 可编程 fake channel：捕获下发帧、手动注 result 帧/下线事件 */
function fakeChannel(): ConnectorActionChannel & {
  sent: ConnectorFrame[];
  setSendOk: (ok: boolean) => void;
  setVersion: (version: number) => void;
  emitResult: (actionId: string, status: "succeeded" | "failed" | "interrupted" | "unknown", result?: unknown, error?: string, errorCode?: string) => void;
  emitOutput: (actionId: string, text: string, stream?: "stdout" | "stderr") => void;
  emitSessionDown: (sessionId: string, reason: "device-offline" | "heartbeat-timeout" | "hub-restart") => void;
} {
  const sent: ConnectorFrame[] = [];
  let sendOk = true;
  let version = 1;
  let resultHandler: ((frame: Extract<ConnectorFrame, { type: "action.result" }>) => void) | null = null;
  let outputHandler: ((frame: Extract<ConnectorFrame, { type: "action.output" }>) => void) | null = null;
  let downHandler: ((sessionId: string, deviceId: string, reason: "device-offline" | "heartbeat-timeout" | "hub-restart") => void) | null = null;
  return {
    sent,
    setSendOk: ok => { sendOk = ok; },
    setVersion: value => { version = value; },
    negotiatedVersion: () => version,
    emitResult: (actionId, status, result, error, errorCode) => {
      resultHandler?.({ v: version, type: "action.result", seq: 1, sid: "s1", data: { actionId, status, ...(result !== undefined ? { result } : {}), ...(status === "succeeded" ? {} : { error: error ?? "x" }), ...(errorCode ? { errorCode } : {}) } });
    },
    emitOutput: (actionId, text, stream = "stdout") => {
      outputHandler?.({ v: version, type: "action.output", seq: 1, sid: "s1", data: { actionId, text, stream } });
    },
    emitSessionDown: (sessionId, reason) => { downHandler?.(sessionId, DEVICE_ID, reason); },
    sendToDevice: (_deviceId, frame) => {
      if (!sendOk) return false;
      sent.push(frame);
      return true;
    },
    onActionResult: handler => { resultHandler = handler; },
    onActionOutput: handler => { outputHandler = handler; },
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
    expect(rows[0]!.conversationId).toBe("c1"); // 关联维度落值
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

  it("shell 等回执超时 → 落 unknown 且发取消杀远端进程组", async () => {
    const h2 = setup({ timeoutMs: 40 });
    await seedOnlineSession(h2.connectorRepo);
    h2.channel.setVersion(2);
    await expect(h2.machine.run({ type: "shell.exec", input: { conversationId: "c1", command: "sleep 5" } }))
      .rejects.toThrow("remote action timeout");
    expect(h2.channel.sent.some(frame => frame.type === "action.cancel")).toBe(true);
    expect(await h2.remoteActions.listByStatuses(["unknown"])).toHaveLength(1);
  });

  it("总闸③：通道不可用（sendToDevice false）→ 登记行落 unknown + 拒发", async () => {
    await seedOnlineSession(h.connectorRepo);
    h.channel.setSendOk(false);
    await expect(h.machine.run({ type: "workspace.exists", input: { conversationId: "c1" } }))
      .rejects.toThrow("connector channel unavailable");
    expect(await h.remoteActions.listByStatuses(["unknown"])).toHaveLength(1);
  });

  it("会话下线钩子：意外断开（心跳超时）在途落 unknown + 等待者 reject", async () => {
    await seedOnlineSession(h.connectorRepo, "sess-A");
    const p1 = h.machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "a.txt" } });
    const p2 = h.machine.run({ type: "workspace.write", input: { conversationId: "c1", relativePath: "b.txt", content: "x" } });
    await new Promise(r => setTimeout(r, 0));
    expect(await h.remoteActions.listByStatuses(["requested"])).toHaveLength(2);

    h.channel.emitSessionDown("sess-A", "heartbeat-timeout"); // 意外断开（真相不明）
    await expect(p1).rejects.toThrow("device session down before result (unknown)");
    await expect(p2).rejects.toThrow("device session down before result (unknown)");
    const unknowns = await h.remoteActions.listByStatuses(["unknown"]);
    expect(unknowns).toHaveLength(2);
    expect(unknowns.every(r => r.error === "device offline before result")).toBe(true);
  });

  it("C3（方案 §6 第4步）：主动优雅下线（offline 帧）在途落 interrupted（确定性裁决）", async () => {
    await seedOnlineSession(h.connectorRepo, "sess-G");
    const p1 = h.machine.run({ type: "workspace.write", input: { conversationId: "c1", relativePath: "c.txt", content: "x" } });
    await new Promise(r => setTimeout(r, 0));

    h.channel.emitSessionDown("sess-G", "device-offline"); // 优雅下线（确定性：可安全重做）
    await expect(p1).rejects.toThrow("device session down before result (interrupted)");
    const interrupted = await h.remoteActions.listByStatuses(["interrupted"]);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.error).toContain("graceful: interrupted");
    // 分流互斥：无 unknown 落行
    expect(await h.remoteActions.listByStatuses(["unknown"])).toHaveLength(0);
  });
  it("m6（检视）：hub-restart 分流——dispose 路径在途落 unknown（与心跳超时同分支）", async () => {
    await seedOnlineSession(h.connectorRepo, "sess-H");
    const pending = h.machine.run({ type: "workspace.exists", input: { conversationId: "cH" } }, undefined, { actionId: "hub-restart-1" });
    await new Promise(r => setTimeout(r, 0));
    h.channel.emitSessionDown("sess-H", "hub-restart");
    await expect(pending).rejects.toThrow("device session down before result (unknown)");
    expect(await h.remoteActions.listByStatuses(["unknown"])).toHaveLength(1);
  });

  it("M1（检视）：多设备串扰隔离——设备 A 下线不误杀设备 B 的在途请求", async () => {
    // 广播语义 channel（对齐网关 sessionDownHandlers 全局广播）
    const downHandlers: Array<(sessionId: string, deviceId: string, reason: "device-offline" | "heartbeat-timeout" | "hub-restart") => void> = [];
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
    for (const handler of downHandlers) handler("sess-A", "conn-dev-1", "heartbeat-timeout");
    await expect(pendingA).rejects.toThrow("device session down before result (unknown): sess-A");
    // B 的在途动作仍可正常回执（未被误杀）
    for (const handler of resultHandlers) handler({ v: 1, type: "action.result", seq: 1, sid: "sess-B", data: { actionId: "m1-b", status: "succeeded", result: true } });
    await expect(pendingB).resolves.toBe(true);

    // 收尾隔离：仅 sess-A 的行落 unknown，sess-B 的行落 succeeded
    const unknowns = await h.remoteActions.listByStatuses(["unknown"]);
    expect(unknowns.map(r => r.actionId)).toEqual(["m1-a"]);
    expect((await h.remoteActions.listByStatuses(["succeeded"])).map(r => r.actionId)).toEqual(["m1-b"]);
  });

  it("远程 SDK env 必须绑定业务对话；文件面显式不支持", async () => {
    expect(() => h.machine.createExecutionEnvironment("/tmp")).toThrow("requires conversationId");
    const env = h.machine.createExecutionEnvironment("/hub/workspaces/c1", "c1");
    expect(env.id).toBe("remote:conn-dev-1");
    const result = await env.readTextFile("a.txt", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_supported");
  });

  it("协议 v1 拒发 shell；v2 流式输出与取消帧按 actionId 归路", async () => {
    await seedOnlineSession(h.connectorRepo);
    await expect(h.machine.run({ type: "shell.exec", input: { conversationId: "c1", command: "pwd" } }))
      .rejects.toThrow("requires connector protocol v2");
    expect(h.channel.sent).toHaveLength(0);
    const env = h.machine.createExecutionEnvironment("/hub/workspaces/c1", "c1");
    await expect(env.exec("pwd", undefined, BACKGROUND_CONTEXT)).rejects.toThrow("requires connector protocol v2");
    expect(h.channel.sent).toHaveLength(0);

    h.channel.setVersion(2);
    const controller = new AbortController();
    const output: string[] = [];
    const pending = h.machine.run(
      { type: "shell.exec", input: { conversationId: "c1", command: "printf ok" } },
      undefined,
      { abortSignal: controller.signal, onOutput: text => output.push(text) },
    );
    await new Promise(r => setTimeout(r, 0));
    const request = h.channel.sent[0] as Extract<ConnectorFrame, { type: "action.request" }>;
    const actionId = request.data.actionId;
    h.channel.emitOutput(actionId, "remote-out");
    expect(output).toEqual(["remote-out"]);
    controller.abort();
    expect(h.channel.sent.some(frame => frame.type === "action.cancel" && frame.data.actionId === actionId)).toBe(true);
    h.channel.emitResult(actionId, "interrupted", undefined, "aborted", "aborted");
    await expect(pending).rejects.toMatchObject({ errorCode: "aborted" });
  });

  it("RemoteExecutionEnv 把 hub 工作区 cwd 映射到设备工作区", async () => {
    await seedOnlineSession(h.connectorRepo);
    h.channel.setVersion(2);
    const env = h.machine.createExecutionEnvironment("/hub/workspaces/c1", "c1");
    const pending = env.exec("pwd", { cwd: "/hub/workspaces/c1/sub" }, BACKGROUND_CONTEXT);
    await new Promise(r => setTimeout(r, 0));
    const pathRequest = h.channel.sent[0] as Extract<ConnectorFrame, { type: "action.request" }>;
    h.channel.emitResult(pathRequest.data.actionId, "succeeded", "/device/workspaces/c1");
    await new Promise(r => setTimeout(r, 0));
    const shellRequest = h.channel.sent[1] as Extract<ConnectorFrame, { type: "action.request" }>;
    expect(shellRequest.data.action.type).toBe("shell.exec");
    expect(shellRequest.data.action.input).toMatchObject({ conversationId: "c1", cwd: "/device/workspaces/c1/sub" });
    h.channel.emitResult(shellRequest.data.actionId, "succeeded", { exitCode: 0 });
    const result = await pending;
    expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
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

    // conversation 维度查询
    const byConv = await registry.listByConversation("c1");
    expect(byConv).toHaveLength(1);
    expect(byConv[0]!.invokeId).toBe("inv-1");
    expect(await registry.listByConversation("c-other")).toHaveLength(0);
  });

  // 同毫秒 created_at 定序——rowid tie-breaker 使 DESC LIMIT 边界确定
  it("listByConversation 同毫秒 created_at：desc 后插入在前 / asc 先插入在前（rowid 定序）", async () => {
    const db = createTestDb();
    const registry = new SqliteRemoteActionRegistry(db);
    await registry.recordRequest(reqRow("tie-1"));
    await registry.recordRequest(reqRow("tie-2")); // 同 毫秒、同 conversation
    const desc = await registry.listByConversation("c1", 200, "desc");
    expect(desc.map(r => r.actionId)).toEqual(["tie-2", "tie-1"]); // DESC：后插入（rowid 大）在前
    const asc = await registry.listByConversation("c1", 200, "asc");
    expect(asc.map(r => r.actionId)).toEqual(["tie-1", "tie-2"]); // ASC：先插入在前（恢复链语义）
    // LIMIT 边界截断不再随机——desc limit=1 恒取最新插入
    expect((await registry.listByConversation("c1", 1, "desc")).map(r => r.actionId)).toEqual(["tie-2"]);
  });

  it("m1（检视）：非 PK 冲突的库故障重抛（错误归因不错位）——表不存在的场景", async () => {
    const db = createTestDb();
    const registry = new SqliteRemoteActionRegistry(db);
    db.exec("DROP TABLE remote_action_requests");
    await expect(registry.recordRequest(reqRow("a-x"))).rejects.toThrow();
  });

  it("m1/m6（检视）：sweepStaleRequested 硬崩溃重启收口——残留 requested 全落 unknown", async () => {
    const db = createTestDb();
    const registry = new SqliteRemoteActionRegistry(db);
    await registry.recordRequest(reqRow("boot-1"));
    await registry.recordRequest(reqRow("boot-2"));
    await registry.settleRequest("boot-2", "succeeded", new Date(T0).toISOString(), {});
    const swept = await registry.sweepStaleRequested(new Date(T0).toISOString());
    expect(swept).toBe(1); // 仅 requested 行被收口
    expect(await registry.listByStatuses(["unknown"])).toHaveLength(1);
    expect((await registry.listByStatuses(["succeeded"])).map(r => r.actionId)).toEqual(["boot-2"]); // 终态不动
  });

});
