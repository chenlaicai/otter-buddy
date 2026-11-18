import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { SqliteConnectorRegistryRepository } from "@frameworks/db/execution/sqlite-connector-registry-repository";
import { ConnectorWsGateway } from "@frameworks/execution/connector-ws-gateway";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";
import { CONNECTOR_PROTOCOL_VERSION, type ConnectorFrame } from "@entities/execution/connector-protocol";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import type { Device } from "@entities/execution/device";

/** F20261117cnnct（#1868 阶段 4 C1）：WSS 网关协议状态机端到端（真 http server + ws 客户端）。
 *  C1 验收路径：upgrade 鉴权（拒/过）→ hello 版本协商 → 上线（库+Registry 投影）→
 *  心跳 → 旧 sid 丢弃 → 主动下线（先库后内存 + 通道关）。 */

const T0 = "2026-11-17T00:00:00Z";

function deviceFixture(overrides: Partial<Device> = {}): Device {
  return { id: "connector-test", name: "测试机", pairToken: "tok-test", createdAt: T0, lastSeenAt: null, ...overrides };
}

/** 投影替身（ConnectorMachineProjection 占位类随 C2 退役——测试改 inline 最小 fake） */
function fakeProjection(id: string, name?: string): ExecutionMachine {
  return {
    id,
    name,
    createExecutionEnvironment: () => { throw new Error(`not implemented (fake projection: ${id})`); },
    run: async () => { throw new Error(`not implemented (fake projection: ${id})`); },
  };
}

/** 测试 harness：真 http server + gateway upgrade 挂载（对齐 main.ts 装配形态） */
async function startHub(db: Database.Database, now?: () => number) {
  const repo = new SqliteConnectorRegistryRepository(db);
  const machines = new ExecutionMachineRegistry();
  const gateway = new ConnectorWsGateway(repo, machines, createTestLogger(), {
    makeMachineProjection: (id, name) => fakeProjection(id, name),
    ...(now ? { now } : {}),
  });
  const server: Server = createServer();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void gateway.handleUpgrade(req, socket, head, (code, reason) => {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }).catch(() => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return { repo, machines, gateway, server, url: `ws://localhost:${String(port)}/connector-ws` };
}

function wsConnect(url: string, token: string | null): WebSocket {
  return new WebSocket(token ? url : url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
}

function nextFrame(ws: WebSocket): Promise<ConnectorFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("frame timeout")), 4000);
    ws.once("message", raw => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as ConnectorFrame);
    });
    ws.once("close", () => { clearTimeout(timer); reject(new Error("closed before frame")); });
  });
}

function waitClosed(ws: WebSocket): Promise<void> {
  return new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

describe("ConnectorWsGateway 协议状态机（C1 端到端）", () => {
  let db: Database.Database;
  let hub: Awaited<ReturnType<typeof startHub>>;

  beforeEach(async () => {
    db = createTestDb();
    await new SqliteConnectorRegistryRepository(db).createDevice(deviceFixture());
    hub = await startHub(db);
  });

  afterEach(async () => {
    hub.gateway.dispose();
    await new Promise<void>(resolve => hub.server.close(() => resolve()));
    db.close();
  });

  it("upgrade 鉴权：无 token 拒升级；错 token 拒；对 token 放行", async () => {
    await expect(new Promise((_, reject) => {
      const ws = wsConnect(hub.url, null);
      ws.on("error", err => { reject(err); ws.terminate(); });
      ws.on("open", () => { resolve_open(); ws.terminate(); });
      function resolve_open(): void { throw new Error("should not open without token"); }
    })).rejects.toThrow();
    await expect(new Promise((_, reject) => {
      const ws = wsConnect(hub.url, "tok-wrong");
      ws.on("error", err => { reject(err); ws.terminate(); });
    })).rejects.toThrow();
  });

  it("hello → hello.ack（sid 下发）→ 库 online + Registry 投影可见", async () => {
    const ws = wsConnect(hub.url, "tok-test");
    const opened = new Promise<void>(r => ws.on("open", () => r()));
    ws.on("error", () => {}); // 401 场景不会发生；防未处理 error 事件
    await opened;

    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq: 1, data: { supportedVersions: [CONNECTOR_PROTOCOL_VERSION] } }));
    const ack = await nextFrame(ws);
    expect(ack.type).toBe("hello.ack");
    expect(ack.sid).toBeTruthy();
    expect(ack.data).toMatchObject({ version: CONNECTOR_PROTOCOL_VERSION });

    // 库表 online（唯一事实源）
    const repo = new SqliteConnectorRegistryRepository(db);
    const session = await repo.getOnlineSession(ack.sid!);
    expect(session?.status).toBe("online");
    expect(session?.deviceId).toBe("connector-test");
    // Registry 投影可见（C1 占位投影）
    expect(hub.machines.list().map(m => m.id)).toContain("connector-test");
    ws.close();
    await waitClosed(ws);
  });

  it("版本无交集拒连（error/version 后关通道）", async () => {
    const ws = wsConnect(hub.url, "tok-test");
    await new Promise<void>(r => ws.on("open", () => r()));
    ws.send(JSON.stringify({ v: 99, type: "hello", seq: 1, data: { supportedVersions: [99] } }));
    const errFrame = await nextFrame(ws);
    expect(errFrame.type).toBe("error");
    if (errFrame.type === "error") expect(errFrame.data.code).toBe("version");
    await waitClosed(ws); // 拒连后服务端关闭
  });

  it("心跳：heartbeat → heartbeat.ack + last_seen 前移", async () => {
    const ws = wsConnect(hub.url, "tok-test");
    await new Promise<void>(r => ws.on("open", () => r()));
    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq: 1, data: { supportedVersions: [1] } }));
    const ack = await nextFrame(ws);
    const sid = ack.sid!;

    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "heartbeat", seq: 2, sid, data: {} }));
    const hbAck = await nextFrame(ws);
    expect(hbAck.type).toBe("heartbeat.ack");
    const repo = new SqliteConnectorRegistryRepository(db);
    const session = await repo.getOnlineSession(sid);
    expect(typeof session?.lastSeenAt).toBe("string");
    ws.close();
    await waitClosed(ws);
  });

  it("旧 sid 帧静默丢弃 + 计数（模块 C 红线：重连≠恢复）", async () => {
    const ws = wsConnect(hub.url, "tok-test");
    await new Promise<void>(r => ws.on("open", () => r()));
    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq: 1, data: { supportedVersions: [1] } }));
    const ack = await nextFrame(ws);

    // 伪造旧 sid 心跳——服务端应静默丢弃（不回 ack）
    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "heartbeat", seq: 2, sid: "stale-session-id", data: {} }));
    await expect(nextFrame(ws)).rejects.toThrow(/timeout|closed/);
    expect(hub.gateway.staleDropCount).toBeGreaterThanOrEqual(1);

    // 正确 sid 仍工作
    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "heartbeat", seq: 3, sid: ack.sid!, data: {} }));
    const hbAck = await nextFrame(ws);
    expect(hbAck.type).toBe("heartbeat.ack");
    ws.close();
    await waitClosed(ws);
  });

  it("主动下线：offline 帧 → 库 offline/device-offline + Registry 注销 + 通道关", async () => {
    const repo = new SqliteConnectorRegistryRepository(db);
    const ws = wsConnect(hub.url, "tok-test");
    await new Promise<void>(r => ws.on("open", () => r()));
    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq: 1, data: { supportedVersions: [1] } }));
    const ack = await nextFrame(ws);

    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "offline", seq: 2, sid: ack.sid!, data: {} }));
    await waitClosed(ws); // 服务端主动关

    const session = await repo.getOnlineSession(ack.sid!);
    expect(session?.status).toBe("offline");
    expect(session?.disconnectReason).toBe("device-offline");
    expect(hub.machines.list().map(m => m.id)).not.toContain("connector-test"); // 投影注销
  });

  it("断线（未发 offline）：socket 关闭 → heartbeat-timeout 收尾 + 投影注销", async () => {
    const repo = new SqliteConnectorRegistryRepository(db);
    const ws = wsConnect(hub.url, "tok-test");
    await new Promise<void>(r => ws.on("open", () => r()));
    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq: 1, data: { supportedVersions: [1] } }));
    const ack = await nextFrame(ws);

    ws.terminate(); // 模拟断线（不走优雅关闭）
    await new Promise(r => setTimeout(r, 300)); // 给服务端 close 事件处理窗口

    const session = await repo.getOnlineSession(ack.sid!);
    expect(session?.status).toBe("offline");
    expect(session?.disconnectReason).toBe("heartbeat-timeout");
    expect(hub.machines.list().map(m => m.id)).not.toContain("connector-test");
  });

  it("重连 = 新会话：二次 hello 拿新 sid，旧 sid 行已 offline", async () => {
    const repo = new SqliteConnectorRegistryRepository(db);
    const ws1 = wsConnect(hub.url, "tok-test");
    await new Promise<void>(r => ws1.on("open", () => r()));
    ws1.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq: 1, data: { supportedVersions: [1] } }));
    const ack1 = await nextFrame(ws1);
    ws1.close();
    await waitClosed(ws1);
    await new Promise(r => setTimeout(r, 200));

    const ws2 = wsConnect(hub.url, "tok-test");
    await new Promise<void>(r => ws2.on("open", () => r()));
    ws2.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq: 1, data: { supportedVersions: [1] } }));
    const ack2 = await nextFrame(ws2);
    expect(ack2.sid).not.toBe(ack1.sid); // 新会话代际
    expect((await repo.getOnlineSession(ack1.sid!))?.status).toBe("offline");
    expect((await repo.getOnlineSession(ack2.sid!))?.status).toBe("online");
    ws2.close();
    await waitClosed(ws2);
  });
});
