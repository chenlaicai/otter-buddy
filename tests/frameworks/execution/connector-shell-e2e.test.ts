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
import { ConnectorWsGateway } from "@frameworks/execution/connector-ws-gateway";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { SqliteActionLedger } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { WorkspaceActionExecutor } from "@frameworks/execution/workspace-action-executor";
import { ConnectorActionDispatcher } from "../../../src/connector/action-dispatcher";
import { ShellActionExecutor } from "../../../src/connector/shell-action-executor";
import { CONNECTOR_WS_SUBPROTOCOLS, type ConnectorFrame } from "@entities/execution/connector-protocol";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import type { Device } from "@entities/execution/device";

/**
 * shell.exec 端到端（协议 v2）：hub 网关 → 真 WSS → connector 真执行栈
 * （dispatcher + ShellActionExecutor + 真台账 + 临时 dataRoot）→
 * 流式 action.output / 取消 / action.result 全链。
 * 拓扑对齐生产装配：connector 侧接线复刻 main.ts buildRuntime/消息分发形态。
 */

const DEVICE_ID = "conn-shell-e2e";

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise(r => setTimeout(r, 25));
  }
}

/** connector 侧执行栈（复刻 main.ts buildRuntime 接线形态——独立数据目录隔离） */
async function buildConnectorRuntime() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "connector-shell-e2e-"));
  const ledger = new SqliteActionLedger(path.join(dataRoot, "action-ledger.sqlite"), { deviceId: DEVICE_ID });
  await ledger.open();
  const workspaceGateway = new NodeWorkspaceGateway(dataRoot);
  const executor = new WorkspaceActionExecutor(workspaceGateway, ledger);
  return { dataRoot, ledger, workspaceGateway, executor };
}

/** hub 侧：真网关 + 注册仓 */
async function startHub(db: Database.Database) {
  const repo = new SqliteConnectorRegistryRepository(db);
  const machines = new ExecutionMachineRegistry();
  const gateway = new ConnectorWsGateway(repo, machines, createTestLogger(), {
    makeMachineProjection: (id, name): ExecutionMachine => ({
      id, name,
      createExecutionEnvironment: () => { throw new Error("fake projection"); },
      run: async () => { throw new Error("fake projection"); },
    }),
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
  return { gateway, repo, server, url: `ws://localhost:${String(port)}/connector-ws` };
}

/** connector 侧 ws 客户端（复刻 main.ts 消息分发：request → dispatcher；cancel → dispatcher；
 *  result/output 帧按当前 sid+协商版本回发） */
async function connectConnector(url: string, runtime: Awaited<ReturnType<typeof buildConnectorRuntime>>): Promise<{ ws: WebSocket; sid: string }> {
  let sid: string | null = null;
  let seq = 0;
  const ws = new WebSocket(url, [...CONNECTOR_WS_SUBPROTOCOLS], { headers: { authorization: "Bearer tok-shell-e2e" } });
  const sendFrame = (frame: ConnectorFrame): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const shellExecutor = new ShellActionExecutor({
    ledger: runtime.ledger,
    resolveWorkspaceRoot: conversationId => runtime.workspaceGateway.getWorkspacePath(conversationId),
    sendOutput: data => {
      if (!sid) return;
      seq += 1;
      sendFrame({ v: 2, type: "action.output", seq, sid, data });
    },
  });
  const dispatcher = new ConnectorActionDispatcher({
    executor: runtime.executor,
    shell: shellExecutor,
    ledger: runtime.ledger,
    send: data => {
      if (!sid) return;
      seq += 1;
      sendFrame({ v: 2, type: "action.result", seq, sid, data });
    },
  });
  const negotiated = await new Promise<string>((resolve, reject) => {
    ws.once("open", () => {
      ws.send(JSON.stringify({ v: 2, type: "hello", seq: 1, data: { supportedVersions: [1, 2] } }));
    });
    ws.once("message", raw => {
      const frame = JSON.parse(String(raw)) as ConnectorFrame;
      if (frame.type === "hello.ack") resolve(frame.sid);
      else reject(new Error(`expected hello.ack, got ${String(frame.type)}`));
    });
    ws.once("error", reject);
  });
  sid = negotiated;
  ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as ConnectorFrame;
    if (frame.type === "action.request") {
      void dispatcher.handleActionRequest(frame).catch(() => {});
    } else if (frame.type === "action.cancel") {
      dispatcher.handleActionCancel(frame.data);
    }
  });
  return { ws, sid: negotiated };
}

describe("shell.exec 端到端（协议 v2 全链）", () => {
  let db: Database.Database;
  let runtime: Awaited<ReturnType<typeof buildConnectorRuntime>>;

  beforeEach(async () => {
    db = createTestDb();
    const device: Device = { id: DEVICE_ID, name: "shell e2e 机", pairToken: "tok-shell-e2e", createdAt: new Date().toISOString(), lastSeenAt: null };
    await new SqliteConnectorRegistryRepository(db).createDevice(device);
    runtime = await buildConnectorRuntime();
  });
  afterEach(async () => {
    runtime.ledger.close();
    await rm(runtime.dataRoot, { recursive: true, force: true }).catch(() => {});
    db.close();
  });

  it("流式 output 先于 result 到达 + result succeeded 带 exitCode + connector 台账归因", async () => {
    const hub = await startHub(db);
    try {
      const { ws } = await connectConnector(hub.url, runtime);
      const results: Array<Extract<ConnectorFrame, { type: "action.result" }>["data"]> = [];
      const outputs: Array<Extract<ConnectorFrame, { type: "action.output" }>["data"]> = [];
      const order: string[] = [];
      hub.gateway.onActionResult(frame => { results.push(frame.data); order.push("result"); });
      hub.gateway.onActionOutput(frame => { outputs.push(frame.data); order.push("output"); });

      const sent = hub.gateway.sendToDevice(DEVICE_ID, {
        v: 2, type: "action.request", seq: 1, sid: hub.gateway.listLiveSessions()[0]!.sessionId,
        data: { actionId: "e2e-sh-1", action: { type: "shell.exec", input: { conversationId: "c1", command: "echo line1 && echo line2" } } },
      });
      expect(sent).toBe(true);

      const result = await waitFor(() => results.find(r => r.actionId === "e2e-sh-1"));
      expect(result).toMatchObject({ status: "succeeded", result: { exitCode: 0 } });
      // 流式输出按到达顺序、先于 result 结算
      const text = outputs.filter(o => o.actionId === "e2e-sh-1").map(o => o.text).join("");
      expect(text).toContain("line1");
      expect(text).toContain("line2");
      expect(order.lastIndexOf("output")).toBeLessThan(order.indexOf("result") === -1 ? order.length : order.indexOf("result"));
      // connector 台账：机器侧真相源（succeeded + 会话归因 + exitCode 摘要）
      const row = await runtime.ledger.getByActionId("e2e-sh-1");
      expect(row).toMatchObject({ status: "succeeded", kind: "shell.exec", conversationId: "c1", deviceId: DEVICE_ID });
      expect(JSON.parse(row!.resultSummary!)).toMatchObject({ exitCode: 0 });
      ws.close();
    } finally {
      hub.gateway.dispose();
      await new Promise<void>(resolve => hub.server.close(() => resolve()));
    }
  });

  it("取消：action.cancel → 该动作进程组被杀 + result interrupted/aborted + 台账同态", async () => {
    const hub = await startHub(db);
    try {
      const { ws, sid } = await connectConnector(hub.url, runtime);
      const results: Array<Extract<ConnectorFrame, { type: "action.result" }>["data"]> = [];
      hub.gateway.onActionResult(frame => results.push(frame.data));

      hub.gateway.sendToDevice(DEVICE_ID, {
        v: 2, type: "action.request", seq: 1, sid,
        data: { actionId: "e2e-sh-2", action: { type: "shell.exec", input: { conversationId: "c1", command: ["node", "-e", "setTimeout(() => {}, 30000)"] } } },
      });
      await new Promise(r => setTimeout(r, 300)); // 进程起来
      const cancelSent = hub.gateway.sendToDevice(DEVICE_ID, {
        v: 2, type: "action.cancel", seq: 2, sid, data: { actionId: "e2e-sh-2" },
      });
      expect(cancelSent).toBe(true);

      const result = await waitFor(() => results.find(r => r.actionId === "e2e-sh-2"));
      expect(result).toMatchObject({ status: "interrupted", errorCode: "aborted" });
      expect((await runtime.ledger.getByActionId("e2e-sh-2"))?.status).toBe("interrupted");
      ws.close();
    } finally {
      hub.gateway.dispose();
      await new Promise<void>(resolve => hub.server.close(() => resolve()));
    }
  });

  it("v1 会话对 shell.exec 下行即拦（sendToDevice false）——旧 connector 不应收到", async () => {
    const hub = await startHub(db);
    try {
      // v1 端（旧 connector 形态：hello 只报 [1]）
      const ws = new WebSocket(hub.url, [...CONNECTOR_WS_SUBPROTOCOLS], { headers: { authorization: "Bearer tok-shell-e2e" } });
      const sid = await new Promise<string>((resolve, reject) => {
        ws.once("open", () => ws.send(JSON.stringify({ v: 1, type: "hello", seq: 1, data: { supportedVersions: [1] } })));
        ws.once("message", raw => {
          const frame = JSON.parse(String(raw)) as ConnectorFrame;
          if (frame.type === "hello.ack") resolve(frame.sid);
          else reject(new Error("no ack"));
        });
        ws.once("error", reject);
      });
      const sent = hub.gateway.sendToDevice(DEVICE_ID, {
        v: 2, type: "action.request", seq: 1, sid,
        data: { actionId: "e2e-sh-3", action: { type: "shell.exec", input: { conversationId: "c1", command: "echo x" } } },
      });
      expect(sent).toBe(false); // 版本闸拦截
      expect(await runtime.ledger.getByActionId("e2e-sh-3")).toBeNull(); // 端上零入账（帧未达）
      ws.close();
    } finally {
      hub.gateway.dispose();
      await new Promise<void>(resolve => hub.server.close(() => resolve()));
    }
  });
});
