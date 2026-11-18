import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { SqliteConnectorRegistryRepository } from "@frameworks/db/execution/sqlite-connector-registry-repository";
import { SqliteRemoteActionRegistry } from "@frameworks/db/execution/sqlite-remote-action-registry";
import { ConnectorWsGateway } from "@frameworks/execution/connector-ws-gateway";
import { RemoteExecutionMachine } from "@frameworks/execution/remote-execution-machine";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { SqliteActionLedger } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { WorkspaceActionExecutor } from "@frameworks/execution/workspace-action-executor";
import { ConnectorActionDispatcher } from "../../../src/connector/action-dispatcher";
import { CONNECTOR_PROTOCOL_VERSION, type ConnectorFrame } from "@entities/execution/connector-protocol";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import type { Device } from "@entities/execution/device";

/**
 * F20261118remex（#1868 阶段 4 C2）端到端验收：RemoteExecutionMachine → WSS 网关 →
 * 真 connector 执行栈（dispatcher + 公共执行器 + 本地台账 + workspace 网关临时目录）
 * → 六动作全链 / 中枢幂等拒 / connector 侧幂等快路径 / 断线在途落 unknown（方案 §8）。
 * 拓扑对齐生产装配：hub 侧 machine 投影接真 gateway 通道（app.ts 形态），
 * connector 侧执行栈对齐 main.ts buildRuntime 形态（独立数据目录）。
 */

const DEVICE_ID = "conn-e2e";

/** connector 侧执行栈（复刻 main.ts buildRuntime——独立数据目录隔离） */
async function buildConnectorRuntime() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "connector-e2e-"));
  const ledger = new SqliteActionLedger(path.join(dataRoot, "action-ledger.sqlite"), { deviceId: DEVICE_ID });
  await ledger.open();
  const executor = new WorkspaceActionExecutor(new NodeWorkspaceGateway(dataRoot), ledger);
  const sentFrames: ConnectorFrame[] = [];
  const dispatcher = new ConnectorActionDispatcher({
    executor,
    ledger,
    // sendResultFrame 形态：由 harness ws 闭包装配（回帧带 sid）
    send: data => { sentFrames.push({ v: CONNECTOR_PROTOCOL_VERSION, type: "action.result", seq: 0, sid: "harness", data }); },
  });
  return { dataRoot, ledger, executor, dispatcher, sentFrames };
}

/** hub + connector 双端 harness */
async function startE2E(db: Database.Database, opts: { actionTimeoutMs?: number } = {}) {
  const connectorRepo = new SqliteConnectorRegistryRepository(db);
  const remoteActions = new SqliteRemoteActionRegistry(db);
  const machines = new ExecutionMachineRegistry();
  const remoteMachines = new Map<string, RemoteExecutionMachine>();
  const gateway = new ConnectorWsGateway(connectorRepo, machines, createTestLogger(), {
    makeMachineProjection: (deviceId: string, deviceName: string): ExecutionMachine => {
      const existing = remoteMachines.get(deviceId);
      if (existing) return existing;
      const machine = new RemoteExecutionMachine(deviceId, deviceName, {
        channel: gateway,
        remoteActions,
        connectorRegistry: connectorRepo,
        hubBootEpoch: 42,
        ...(opts.actionTimeoutMs ? { actionTimeoutMs: opts.actionTimeoutMs } : {}),
      });
      machine.wireChannel();
      remoteMachines.set(deviceId, machine);
      return machine;
    },
  });
  const server: Server = createServer();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void gateway.handleUpgrade(req, socket, head, (code: number, reason: string) => {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }).catch(() => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    gateway, machines, connectorRepo, remoteActions, server, url: `ws://localhost:${String(port)}/connector-ws`,
    machine: () => remoteMachines.get(DEVICE_ID)!,
  };
}

/** connector 侧 ws 客户端（真执行栈接线：action.request → dispatcher → 回帧） */
async function connectConnector(url: string, runtime: Awaited<ReturnType<typeof buildConnectorRuntime>>): Promise<{ ws: WebSocket; sid: string }> {
  const ws = new WebSocket(url, { headers: { authorization: "Bearer tok-e2e" } });
  const sid = await new Promise<string>((resolve, reject) => {
    ws.once("open", () => {
      ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq: 1, data: { supportedVersions: [CONNECTOR_PROTOCOL_VERSION] } }));
    });
    ws.once("message", raw => {
      const frame = JSON.parse(String(raw)) as ConnectorFrame;
      if (frame.type === "hello.ack") resolve(frame.sid);
      else reject(new Error(`expected hello.ack, got ${String(frame.type)}`));
    });
    ws.once("error", reject);
  });
  ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as ConnectorFrame;
    if (frame.type === "action.request") {
      void runtime.dispatcher.handleActionRequest(frame).then(() => {
        // 回执：覆写 harness sid 为真实会话 sid（对齐 main.ts sendResultFrame 语义）
        const resultFrame = runtime.sentFrames.pop()!;
        ws.send(JSON.stringify({ ...resultFrame, sid }));
      }).catch(() => {});
    }
  });
  return { ws, sid };
}

describe("C2 执行通道端到端（六动作/幂等/断线收尾）", () => {
  let db: Database.Database;
  let runtime: Awaited<ReturnType<typeof buildConnectorRuntime>>;
  let dataRoot: string;

  beforeEach(async () => {
    db = createTestDb();
    runtime = await buildConnectorRuntime();
    dataRoot = runtime.dataRoot;
  });
  afterEach(async () => {
    runtime.ledger.close(); // WAL 释放（否则临时目录 rm 撞 ENOTEMPTY）
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function seedDevice(repo: SqliteConnectorRegistryRepository): Promise<void> {
    const device: Device = { id: DEVICE_ID, name: "e2e 连接器", pairToken: "tok-e2e", createdAt: new Date().toISOString(), lastSeenAt: null };
    await repo.createDevice(device);
  }

  it("六动作端到端全过（exists/write/read/list/path/delete）", async () => {
    const hub = await startE2E(db);
    await seedDevice(hub.connectorRepo);
    const { ws } = await connectConnector(hub.url, runtime);
    const machine = hub.machine();

    // write
    await machine.run({ type: "workspace.write", input: { conversationId: "c1", relativePath: "dir/a.txt", content: "hello-remote" } });
    // read
    expect(await machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "dir/a.txt" } })).toBe("hello-remote");
    // exists（会话工作区根存在性——不带 relativePath 语义）
    expect(await machine.run({ type: "workspace.exists", input: { conversationId: "c1" } })).toBe(true);
    expect(await machine.run({ type: "workspace.exists", input: { conversationId: "c-other" } })).toBe(false);
    // list
    const list = await machine.run({ type: "workspace.list", input: { conversationId: "c1", relativePath: "dir" } });
    expect(JSON.stringify(list)).toContain("a.txt");
    // path（远程侧工作区根——独立数据目录）
    const remotePath = await machine.run({ type: "workspace.path", input: { conversationId: "c1" } });
    expect(String(remotePath)).toContain(dataRoot);
    // delete（删后 read 拒——文件已不在）
    const del = await machine.run({ type: "workspace.delete", input: { conversationId: "c1", relativePath: "dir/a.txt" } });
    expect(del).toEqual({ deleted: "file" });
    await expect(machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "dir/a.txt" } }))
      .rejects.toThrow();

    // 中枢侧登记六行全 succeeded（R1 回执投影）
    const rows = await hub.remoteActions.listByStatuses(["succeeded"]);
    expect(rows).toHaveLength(7);
    expect(rows.every(r => r.deviceId === DEVICE_ID)).toBe(true);
    // R2：conversation 维度可查
    const byConv = await hub.remoteActions.listByConversation("c1");
    expect(byConv.length).toBeGreaterThanOrEqual(6);

    // connector 侧台账同步入账（机器侧真相源）
    expect(await runtime.ledger.getByActionId(rows[0]!.actionId)).toMatchObject({ status: "succeeded" });

    ws.close();
    hub.server.close();
  });

  it("中枢幂等拒：重复 actionId 不二次下发", async () => {
    const hub = await startE2E(db);
    await seedDevice(hub.connectorRepo);
    const { ws } = await connectConnector(hub.url, runtime);
    const machine = hub.machine();

    await machine.run({ type: "workspace.write", input: { conversationId: "c1", relativePath: "b.txt", content: "x" } }, undefined, { actionId: "idem-1" });
    await expect(machine.run({ type: "workspace.write", input: { conversationId: "c1", relativePath: "b.txt", content: "x" } }, undefined, { actionId: "idem-1" }))
      .rejects.toThrow("duplicate remote actionId: idem-1");

    ws.close();
    hub.server.close();
  });

  it("connector 侧幂等快路径：重放同 actionId 请求 → 回已记录结果不重执行", async () => {
    const hub = await startE2E(db);
    await seedDevice(hub.connectorRepo);
    const { ws } = await connectConnector(hub.url, runtime);
    const machine = hub.machine();

    await machine.run({ type: "workspace.write", input: { conversationId: "c1", relativePath: "b.txt", content: "once" } }, undefined, { actionId: "idem-2" });
    const ledgerRowAfterFirst = await runtime.ledger.getByActionId("idem-2");
    expect(ledgerRowAfterFirst?.status).toBe("succeeded");

    // 模拟重放：同 actionId 再触一次 dispatcher（connector 侧防线——不经 ws：
    // action.request 是 S→C 单向帧，hub 不会重发；这里直测 connector 防线本身）
    const executorRunCount = { n: 0 };
    const originalExecutorRun = runtime.executor.run.bind(runtime.executor);
    runtime.executor.run = async (action: never, options?: never) => {
      executorRunCount.n += 1;
      return originalExecutorRun(action, options);
    };
    runtime.sentFrames.length = 0;
    await runtime.dispatcher.handleActionRequest({
      v: 1, type: "action.request", seq: 99, sid: "test",
      data: { actionId: "idem-2", action: { type: "workspace.write", input: { conversationId: "c1", relativePath: "b.txt", content: "twice" } } },
    });
    expect(executorRunCount.n).toBe(0); // 快路径：未重执行
    expect(runtime.sentFrames).toHaveLength(1);
    expect((runtime.sentFrames[0] as Extract<ConnectorFrame, { type: "action.result" }>).data.status).toBe("succeeded");
    // 内容未被重写（"once" 保持）
    expect(await machine.run({ type: "workspace.read", input: { conversationId: "c1", relativePath: "b.txt" } })).toBe("once");

    ws.close();
    hub.server.close();
  });

  it("断线在途落 unknown（最小断线收尾）：等待者 reject + 登记行 unknown", async () => {
    // 慢执行器：收 request 后挂起（模拟长动作），断线在途
    const slowRuntime = runtime;
    const originalHandle = slowRuntime.dispatcher.handleActionRequest.bind(slowRuntime.dispatcher);
    let releaseExecution: () => void = () => {}; // Promise 构造器内赋真值（TS 流分析不可见）
    const gate = new Promise<void>(resolve => { releaseExecution = resolve; });
    slowRuntime.dispatcher.handleActionRequest = async (frame: unknown) => {
      const f = frame as Extract<ConnectorFrame, { type: "action.request" }>;
      if (f.data.actionId === "slow-1") { await gate; } // 在途挂起
      return originalHandle(f as never);
    };

    const hub = await startE2E(db);
    await seedDevice(hub.connectorRepo);
    const { ws } = await connectConnector(hub.url, runtime);
    const machine = hub.machine();

    const pending = machine.run({ type: "workspace.write", input: { conversationId: "c1", relativePath: "slow.txt", content: "s" } }, undefined, { actionId: "slow-1" });
    await new Promise(r => setTimeout(r, 150)); // 请求到达 connector 并挂起

    ws.terminate(); // 断线（不发 offline——心跳超时同路径，gateway close 即 shutdown）
    await expect(pending).rejects.toThrow();

    const unknowns = await hub.remoteActions.listByStatuses(["unknown"]);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]!.actionId).toBe("slow-1");
    expect(unknowns[0]!.error).toBe("device offline before result");

    releaseExecution();
    hub.server.close();
  });

  it("超时落 unknown：慢执行器 + 注入小超时（30s 纪律的可测化）", async () => {
    const hub = await startE2E(db, { actionTimeoutMs: 120 });
    await seedDevice(hub.connectorRepo);
    const { ws } = await connectConnector(hub.url, runtime);

    const machine = hub.machine();
    // 原地挂起 executor：registry 侧等待超时
    const originalHandle = runtime.dispatcher.handleActionRequest.bind(runtime.dispatcher);
    runtime.dispatcher.handleActionRequest = async (frame: unknown) => {
      const f = frame as Extract<ConnectorFrame, { type: "action.request" }>;
      await new Promise(r => setTimeout(r, 400)); // 超过 120ms 超时
      return originalHandle(f as never);
    };

    await expect(machine.run({ type: "workspace.exists", input: { conversationId: "c1" } }, undefined, { actionId: "t-o-1" }))
      .rejects.toThrow("remote action timeout");
    const rows = await hub.remoteActions.listByStatuses(["unknown"]);
    expect(rows.find(r => r.actionId === "t-o-1")).toMatchObject({ status: "unknown" });

    ws.close();
    hub.server.close();
  });
});
