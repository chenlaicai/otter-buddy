import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SqliteConnectorRegistryRepository } from "@frameworks/db/execution/sqlite-connector-registry-repository";
import { SqliteRemoteActionRegistry } from "@frameworks/db/execution/sqlite-remote-action-registry";
import { ConnectorWsGateway } from "@frameworks/execution/connector-ws-gateway";
import { RemoteExecutionMachine } from "@frameworks/execution/remote-execution-machine";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";
import { ConversationActionRouter } from "@usecases/execution/conversation-action-router";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { SqliteActionLedger } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { WorkspaceActionExecutor } from "@frameworks/execution/workspace-action-executor";
import { ConnectorActionDispatcher } from "../../../src/connector/action-dispatcher";
import { ShellActionExecutor } from "../../../src/connector/shell-action-executor";
import { FileActionExecutor } from "../../../src/connector/file-action-executor";
import { DurableSession } from "@frameworks/agent/durable-session";
import { DurableEventStream } from "@frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "@frameworks/agent/tool-builder";
import { otterInvokeStorage } from "@frameworks/agent/model-runtime-registry";
import { CONNECTOR_WS_SUBPROTOCOLS, type ConnectorFrame } from "@entities/execution/connector-protocol";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import type { Device } from "@entities/execution/device";
import type { Logger } from "@usecases/ports/logger";

/**
 * 远程文件面端到端（本切片验收锚点）：DurableSession + faux 模型脚本驱动
 * write/edit/read/bash(git) 编码工具，经真 WSS → 真 connector 执行栈物理落
 * 设备工作区。断言：
 * - 文件物理在设备目录（hub 工作区同路径无文件——绝不静默落 hub）；
 * - git 经远程 bash 在设备侧 init+commit 成功；
 * - hub 侧 remote_action_requests 与 connector 台账双侧五态落账。
 */

const DEVICE_ID = "conn-file-e2e";
const CONVERSATION_ID = "c-file-e2e";

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

/** connector 侧执行栈（复刻 main.ts buildRuntime 接线形态——独立数据目录隔离） */
async function buildConnectorRuntime() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "connector-file-e2e-"));
  const ledger = new SqliteActionLedger(path.join(dataRoot, "action-ledger.sqlite"), { deviceId: DEVICE_ID });
  await ledger.open();
  const workspaceGateway = new NodeWorkspaceGateway(dataRoot);
  return { dataRoot, ledger, workspaceGateway };
}

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

/** connector 侧 ws 客户端（复刻 main.ts：request/cancel → dispatcher；result/output 按当前 sid 回发） */
async function connectConnector(url: string, runtime: Awaited<ReturnType<typeof buildConnectorRuntime>>): Promise<{ ws: WebSocket; sid: string }> {
  let sid: string | null = null;
  let seq = 0;
  const ws = new WebSocket(url, [...CONNECTOR_WS_SUBPROTOCOLS], { headers: { authorization: "Bearer tok-file-e2e" } });
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
  const fileExecutor = new FileActionExecutor({
    ledger: runtime.ledger,
    resolveWorkspaceRoot: conversationId => runtime.workspaceGateway.getWorkspacePath(conversationId),
  });
  const dispatcher = new ConnectorActionDispatcher({
    executor: new WorkspaceActionExecutor(runtime.workspaceGateway, runtime.ledger),
    shell: shellExecutor,
    file: fileExecutor,
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

describe("远程文件面端到端（协议 v2 全链，真 WSS）", () => {
  let db: Database.Database;
  let runtime: Awaited<ReturnType<typeof buildConnectorRuntime>>;

  beforeEach(async () => {
    db = createTestDb();
    const device: Device = { id: DEVICE_ID, name: "file e2e 机", pairToken: "tok-file-e2e", createdAt: new Date().toISOString(), lastSeenAt: null };
    await new SqliteConnectorRegistryRepository(db).createDevice(device);
    runtime = await buildConnectorRuntime();
  });
  afterEach(async () => {
    runtime.ledger.close();
    await rm(runtime.dataRoot, { recursive: true, force: true }).catch(() => {});
    db.close();
  });

  it("write/edit/read/bash(git) 全链物理落设备工作区；hub 同路径无文件；双侧五态落账", { timeout: 60_000 }, async () => {
    const hub = await startHub(db);
    const hubWorkspace = await mkdtemp(path.join(tmpdir(), "hub-ws-file-e2e-"));
    try {
      const { ws } = await connectConnector(hub.url, runtime);
      // hub 侧远程执行机 + 对话路由（对话固定指向该设备）
      const remoteActions = new SqliteRemoteActionRegistry(db);
      const machine = new RemoteExecutionMachine(DEVICE_ID, "file e2e 机", {
        channel: hub.gateway,
        remoteActions,
        connectorRegistry: hub.repo,
        hubBootEpoch: 1,
        actionTimeoutMs: 60_000,
      });
      machine.wireChannel();
      const registry = new ExecutionMachineRegistry();
      registry.register(machine);
      const router = new ConversationActionRouter(registry, {
        getExecutionMachineId: async id => (id === CONVERSATION_ID ? DEVICE_ID : null),
      });

      const deviceFile = path.join(runtime.workspaceGateway.getWorkspacePath(CONVERSATION_ID), "src", "hello.txt");
      const faux = fauxProvider({});
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", { path: "src/hello.txt", content: "hello remote v1" }, { id: "w1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("edit", { path: "src/hello.txt", edits: [{ oldText: "v1", newText: "v2" }] }, { id: "e1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("read", { path: "src/hello.txt" }, { id: "r1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("bash", {
          command: "git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init && git log --oneline | head -1",
          timeout: 30,
        }, { id: "b1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("remote-file-e2e-done"),
      ]);
      const session = await DurableSession.open({
        otterId: "otter-file-e2e",
        file: path.join(hubWorkspace, "session.sqlite"),
        models,
        model: faux.getModel(),
        cwd: hubWorkspace,
        executionMachines: router,
        logger: silentLogger,
        register: createInvokeRegister(),
        invokeId: "invoke-file-e2e",
        context: BACKGROUND_CONTEXT,
        tools: { codingTools: ["write", "edit", "read", "bash"], customTools: [] },
        haltRegistry: { takeForBlock: () => [], isHalted: () => false },
      });

      try {
        const events: unknown[] = [];
        // 生产路径：pi-session-factory execute 包 otterInvokeStorage.run 后调 prompt——
        // conversationId 经 ALS 穿透到 env 工厂（路由到远程机）
        await otterInvokeStorage.run({
          otterId: "otter-file-e2e", otterPromptConfig: "", identityPrefix: "",
          currentConversationId: CONVERSATION_ID,
        } as never, () =>
          session.prompt("exercise remote file tools", undefined, new DurableEventStream(event => events.push(event)), BACKGROUND_CONTEXT),
        );

        expect(session.turnText).toBe("remote-file-e2e-done");

        // ── 物理落设备：write→edit 后的最终内容在设备工作区 ──
        expect(await readFile(deviceFile, "utf8")).toBe("hello remote v2");
        // hub 工作区同相对路径无文件（绝不静默落 hub）
        await expect(stat(path.join(hubWorkspace, "src", "hello.txt"))).rejects.toThrow();

        // ── git 经远程 bash 在设备侧跑通（init+commit+log） ──
        const toolResults = JSON.stringify(events.filter(event => (event as { type?: string }).type === "tool_execution_end"));
        expect(toolResults).toContain("hello remote v2"); // read 工具回显设备内容
        const deviceGit = path.join(runtime.workspaceGateway.getWorkspacePath(CONVERSATION_ID), ".git");
        expect((await stat(deviceGit)).isDirectory()).toBe(true); // .git 物理在设备

        // ── hub 侧登记（五态）：file.write ×2（write+edit）与 shell.exec 落行归因会话 ──
        const rows = await remoteActions.listByStatuses(["succeeded"]);
        const writeRows = rows.filter(r => r.actionType === "file.write");
        expect(writeRows.length).toBeGreaterThanOrEqual(2);
        expect(writeRows.every(r => r.conversationId === CONVERSATION_ID)).toBe(true);
        expect(rows.some(r => r.actionType === "shell.exec")).toBe(true);

        // ── connector 台账（机器侧真相源）：file.write/shell.exec succeeded（invoke 归因穿透） ──
        const ledgerRows = await runtime.ledger.listByInvoke("invoke-file-e2e");
        const succeededKinds = ledgerRows.filter(r => r.status === "succeeded").map(r => r.kind);
        expect(succeededKinds.filter(k => k === "file.write").length).toBeGreaterThanOrEqual(2);
        expect(succeededKinds).toContain("shell.exec");
        // 写类台账带 hash（崩溃恢复五态的核对面）
        const writeLedger = ledgerRows.find(r => r.kind === "file.write");
        expect(writeLedger?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await session.close(BACKGROUND_CONTEXT);
      }
      ws.close();
    } finally {
      hub.gateway.dispose();
      await new Promise<void>(resolve => hub.server.close(() => resolve()));
      await rm(hubWorkspace, { recursive: true, force: true }).catch(() => {});
    }
  });
});
