import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteConnectorRegistryRepository } from "@frameworks/db/execution/sqlite-connector-registry-repository";
import { SqliteRemoteActionRegistry } from "@frameworks/db/execution/sqlite-remote-action-registry";
import { RemoteExecutionMachine } from "@frameworks/execution/remote-execution-machine";
import type { ConnectorActionChannel } from "@frameworks/execution/connector-ws-gateway";
import type { ConnectorFrame } from "@entities/execution/connector-protocol";
import type { Device } from "@entities/execution/device";
import type { OnlineSession } from "@entities/execution/online-session";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { SqliteActionLedger } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { WorkspaceActionExecutor } from "@frameworks/execution/workspace-action-executor";
import { ConnectorActionDispatcher } from "../../src/connector/action-dispatcher";
import { ShellActionExecutor } from "../../src/connector/shell-action-executor";
import { FileActionExecutor } from "../../src/connector/file-action-executor";
import { createTestDb } from "./db";

/**
 * 回环桥：真 hub 侧 RemoteExecutionMachine ↔ 内存 channel ↔ 真 connector 执行栈
 * （NodeWorkspaceGateway + SqliteActionLedger + Workspace/Shell/File 执行器 +
 *  ConnectorActionDispatcher）。不经网络，但走完整协议帧与五态登记——
 *  供 RemoteExecutionEnv 文件面测试与 pi-durable conformance 子集复用。
 */

export const LOOPBACK_DEVICE_ID = "loopback-dev";
export const LOOPBACK_SESSION_ID = "sess-loopback";

export interface RemoteLoopbackStack {
  machine: RemoteExecutionMachine;
  connectorRepo: SqliteConnectorRegistryRepository;
  remoteActions: SqliteRemoteActionRegistry;
  deviceDataRoot: string;
  deviceWorkspaceGateway: NodeWorkspaceGateway;
  deviceLedger: SqliteActionLedger;
  fileExecutor: FileActionExecutor;
  shellExecutor: ShellActionExecutor;
  dispatcher: ConnectorActionDispatcher;
  /** 模拟设备下线（触发 hub 侧会话下线收尾） */
  emitSessionDown(reason: "device-offline" | "heartbeat-timeout" | "hub-restart"): void;
  /** 模拟设备重连为新会话（新 sid；旧句柄由 connector 侧会话更替清理） */
  reconnect(): void;
  cleanup(): Promise<void>;
}

export async function createRemoteLoopback(opts: { protocolVersion?: 1 | 2 } = {}): Promise<RemoteLoopbackStack> {
  const version = opts.protocolVersion ?? 2;
  const hubDb = createTestDb();
  const connectorRepo = new SqliteConnectorRegistryRepository(hubDb);
  const remoteActions = new SqliteRemoteActionRegistry(hubDb);

  // ── 设备侧执行栈（真实件，临时 dataRoot） ──
  const deviceDataRoot = await mkdtemp(path.join(tmpdir(), "remote-loopback-"));
  const deviceWorkspaceGateway = new NodeWorkspaceGateway(deviceDataRoot);
  const deviceLedger = new SqliteActionLedger(path.join(deviceDataRoot, "action-ledger.sqlite"), { deviceId: LOOPBACK_DEVICE_ID });
  await deviceLedger.open();

  let resultHandler: ((frame: Extract<ConnectorFrame, { type: "action.result" }>) => void) | null = null;
  let outputHandler: ((frame: Extract<ConnectorFrame, { type: "action.output" }>) => void) | null = null;
  let downHandler: ((sessionId: string, deviceId: string, reason: "device-offline" | "heartbeat-timeout" | "hub-restart") => void) | null = null;
  let sid = LOOPBACK_SESSION_ID;

  const sendResultFrame = (data: Extract<ConnectorFrame, { type: "action.result" }>["data"]): void => {
    resultHandler?.({ v: version, type: "action.result", seq: 1, sid, data });
  };
  const sendOutputFrame = (data: Extract<ConnectorFrame, { type: "action.output" }>["data"]): void => {
    outputHandler?.({ v: version, type: "action.output", seq: 1, sid, data });
  };

  const workspaceExecutor = new WorkspaceActionExecutor(deviceWorkspaceGateway, deviceLedger, () => {});
  const shellExecutor = new ShellActionExecutor({
    ledger: deviceLedger,
    resolveWorkspaceRoot: conversationId => deviceWorkspaceGateway.getWorkspacePath(conversationId),
    sendOutput: sendOutputFrame,
    log: () => {},
  });
  const fileExecutor = new FileActionExecutor({
    ledger: deviceLedger,
    resolveWorkspaceRoot: conversationId => deviceWorkspaceGateway.getWorkspacePath(conversationId),
    log: () => {},
  });
  const dispatcher = new ConnectorActionDispatcher({
    executor: workspaceExecutor,
    shell: shellExecutor,
    file: fileExecutor,
    ledger: deviceLedger,
    send: sendResultFrame,
    log: () => {},
  });

  const channel: ConnectorActionChannel = {
    sendToDevice: (_deviceId, frame) => {
      if ((frame as { type?: string }).type === "action.cancel") {
        dispatcher.handleActionCancel((frame as Extract<ConnectorFrame, { type: "action.cancel" }>).data);
        return true;
      }
      const request = frame as Extract<ConnectorFrame, { type: "action.request" }>;
      void dispatcher.handleActionRequest({
        ...request,
        sid,
        v: version,
      } as Extract<ConnectorFrame, { type: "action.request" }>).catch(() => {});
      return true;
    },
    onActionResult: handler => { resultHandler = handler; },
    onActionOutput: handler => { outputHandler = handler; },
    onSessionDown: handler => { downHandler = handler; },
    negotiatedVersion: () => version,
  };

  const machine = new RemoteExecutionMachine(LOOPBACK_DEVICE_ID, "回环设备", {
    channel,
    remoteActions,
    connectorRegistry: connectorRepo,
    hubBootEpoch: 1,
    actionTimeoutMs: 60_000,
  });
  machine.wireChannel();

  // 设备登记 + 在线会话（总闸①事实源）
  const device: Device = {
    id: LOOPBACK_DEVICE_ID, name: "回环设备", pairToken: "tok-loopback",
    createdAt: new Date().toISOString(), lastSeenAt: null,
  };
  await connectorRepo.createDevice(device);
  const session: OnlineSession = {
    id: LOOPBACK_SESSION_ID, deviceId: LOOPBACK_DEVICE_ID, status: "online",
    connectedAt: new Date().toISOString(), disconnectedAt: null, disconnectReason: null,
    lastSeenAt: new Date().toISOString(), protocolVersion: version,
  };
  await connectorRepo.openOnlineSession(session);

  return {
    machine,
    connectorRepo,
    remoteActions,
    deviceDataRoot,
    deviceWorkspaceGateway,
    deviceLedger,
    fileExecutor,
    shellExecutor,
    dispatcher,
    emitSessionDown(reason) {
      downHandler?.(sid, LOOPBACK_DEVICE_ID, reason);
    },
    reconnect() {
      sid = `${LOOPBACK_SESSION_ID}-r${Date.now()}`;
    },
    async cleanup() {
      await shellExecutor.shutdown("test teardown").catch(() => {});
      await fileExecutor.closeAllResources("test teardown").catch(() => {});
      deviceLedger.close();
      await rm(deviceDataRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
