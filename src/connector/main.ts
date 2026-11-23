#!/usr/bin/env node
/**
 * （执行通道）：connector
 * 独立进程入口（客户端侧）。packages/connector 独立分发。
 *
 * shebang：packages/connector 打包后经 bin（otter-connector）直接执行；
 * 主构建（dist/src/connector/）同样保留——无碍（不被当模块加载）。
 *
 * 轻量铁律：本进程不加载模型、embedding、主记忆——
 * 依赖闭包仅 ws + better-sqlite3 + node 内置 + 执行器/台账/网关（构建后闭包断言）。
 *
 * 通道语义：断线自动重连（指数退避 1s→30s，重连=新会话——
 * hub 侧 sid 代际天然隔离跨会话重放）；心跳半开自愈（45s 无 heartbeat.ack 判死重连）；
 * version 类协议不兼容是致命错误（重连无意义，退出进程让人介入）。
 *
 * 动作执行栈：action.request → ConnectorActionDispatcher
 * （台账 actionId 幂等快路径）→ WorkspaceActionExecutor（六动作，与中枢 local 同一执行
 * 语义与记账协议）/ ShellActionExecutor（协议 v2 的 shell.exec——独立 env +
 * AbortController，SDK 杀进程组；stdout/stderr 经 action.output 帧实时流回）
 * → action.result 回执。action.cancel（S→C）只 abort 指定动作进程组，不直接宣称成功。
 * 数据目录 ~/.otter/connector/<deviceId>/；台账开机清扫旧纪元 running 行（崩溃恢复
 * 兑底）后才执行动作。
 *
 * 用法（packages/connector 打包分发后）：
 *   otter-connector --hub https://otter.example.com --pair <码> --name <设备名>   # 首启配对
 *   otter-connector --hub https://otter.example.com                              # 凭已存身份连接
 * （仓内直跑构建产物：node packages/connector/dist/connector/main.js ...）
 * 身份落 ~/.otter/connector/device.json（deviceId + pairToken）。
 */

import { WebSocket } from "ws";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CONNECTOR_HEARTBEAT_INTERVAL_MS,
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_WS_SUBPROTOCOLS,
  HELLO_SUPPORTED_VERSIONS,
  type ConnectorFrame,
} from "@entities/execution/connector-protocol";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { SqliteActionLedger } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { WorkspaceActionExecutor } from "@frameworks/execution/workspace-action-executor";
import { ConnectorActionDispatcher } from "./action-dispatcher";
import { ShellActionExecutor } from "./shell-action-executor";
import { FileActionExecutor } from "./file-action-executor";

interface DeviceIdentity {
  deviceId: string;
  pairToken: string;
}

interface Args {
  hub: string;
  pair?: string;
  name?: string;
}

/** 心跳半开判死：3 个间隔无 ack 即认为通道死（hub 侧 90s 判死，客户端侧更早自愈） */
const HEARTBEAT_ACK_TIMEOUT_MS = CONNECTOR_HEARTBEAT_INTERVAL_MS * 3;
/** 重连退避：1s 起，指数翻倍，上限 30s */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key === "hub") args.hub = value;
    if (key === "pair") args.pair = value;
    if (key === "name") args.name = value;
  }
  if (!args.hub) {
    process.stderr.write("usage: main.js --hub <url> [--pair <code> --name <name>]\n");
    process.exit(2);
  }
  return args as Args;
}

async function identityPath(): Promise<string> {
  const dir = path.join(os.homedir(), ".otter", "connector");
  await mkdir(dir, { recursive: true });
  return path.join(dir, "device.json");
}

async function loadIdentity(): Promise<DeviceIdentity | null> {
  try {
    return JSON.parse(await readFile(await identityPath(), "utf8")) as DeviceIdentity;
  } catch {
    return null;
  }
}

async function saveIdentity(identity: DeviceIdentity): Promise<void> {
  await writeFile(await identityPath(), JSON.stringify(identity, null, 2), "utf8");
}

/** 首启配对：一次性码换长效 token（核销失败即退出——fail-closed，码过期/重放不重试） */
async function pairWithHub(hub: string, code: string, name: string): Promise<DeviceIdentity> {
  const res = await fetch(new URL("/api/connector/pair", hub), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pairing rejected (HTTP ${String(res.status)}): ${body}`);
  }
  const data = await res.json() as DeviceIdentity;
  await saveIdentity(data);
  return data;
}

function log(message: string, meta?: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg: message, ...meta })}\n`);
}

let seq = 0;

/** 单次连接的共享状态（处理器拆分后经对象传递） */
interface ConnState {
  sessionId: string | null;
  /** hello.ack 协商出的协议版本——此后所有上行帧 v 字段用它（v1 会话发 v1 帧） */
  version: number;
  heartbeat: NodeJS.Timeout | null;
  ackWatch: NodeJS.Timeout | null;
  lastAckAt: number;
  settled: boolean;
}

/** 心跳双循环：发送间隔 + ack 判死（3 间隔无 ack 主动断开重连——不等 TCP 超时） */
function startHeartbeatLoops(ws: WebSocket, state: ConnState): void {
  state.heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN && state.sessionId) {
      seq += 1;
      ws.send(JSON.stringify({ v: state.version, type: "heartbeat", seq, sid: state.sessionId, data: {} }));
    }
  }, CONNECTOR_HEARTBEAT_INTERVAL_MS);
  state.ackWatch = setInterval(() => {
    if (Date.now() - state.lastAckAt > HEARTBEAT_ACK_TIMEOUT_MS) {
      log("heartbeat ack timeout, reconnecting", { sessionId: state.sessionId });
      ws.terminate();
    }
  }, CONNECTOR_HEARTBEAT_INTERVAL_MS);
}

function attachMessageHandler(ws: WebSocket, identity: DeviceIdentity, state: ConnState, runtime: ConnectorRuntime, settle: (o: "closed" | "fatal") => void): void {
  ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as ConnectorFrame;
    if (frame.type === "hello.ack" && frame.sid) {
      state.sessionId = frame.sid;
      state.version = frame.data.version;
      currentSid = frame.sid; // minor-1：信号处理读最新会话
      currentVersion = frame.data.version;
      state.lastAckAt = Date.now();
      log("online", { deviceId: identity.deviceId, sessionId: frame.sid, version: frame.data.version });
      // 会话更替：读器句柄是进程内资源，旧会话代际已死——全量关闭防泄漏
      void runtime.fileExecutor.closeAllResources("session replaced");
      startHeartbeatLoops(ws, state);
    } else if (frame.type === "heartbeat.ack") {
      state.lastAckAt = Date.now();
    } else if (frame.type === "action.request") {
      // 动作执行：fire-and-forget（回执经 sendResultFrame 读当前连接——执行期间重连
      // 则带新 sid 被 hub 旧 sid 校验丢弃，语义正确：旧会话动作对新会话回答无意义）
      void runtime.dispatcher.handleActionRequest(frame).catch(err => {
        log("action dispatch failed", { actionId: frame.data.actionId, error: String(err) });
      });
    } else if (frame.type === "action.cancel") {
      // 取消（协议 v2）：只 abort 指定动作进程组——不直接宣称成功，
      // 最终状态只信随后的 action.result
      runtime.dispatcher.handleActionCancel(frame.data);
    } else if (frame.type === "error") {
      log("hub error frame", { data: frame.data });
      if (frame.data.code === "version") settle("fatal"); // 协议不兼容：重连无意义
    }
  });
}

/**
 * SIGINT/SIGTERM → 主动 offline（尽力而为发帧；hub 侧断线兜底会补收尾）。
 * 检视 minor-1：信号处理**注册一次**（main 里 connectOnce 循环外），经模块级
 * currentWs/currentSid 引用读最新连接——避免随重连循环累积监听器
 * （MaxListenersExceededWarning）与 stale handler 引用已关 ws。
 */
let currentWs: WebSocket | null = null;
let currentSid: string | null = null;
/** 当前会话协商版本（hello.ack 落定；上行帧 v 字段随会话版本） */
let currentVersion: number = CONNECTOR_PROTOCOL_VERSION;
/** （检视）：优雅退出中——重连循环见此标志不再起新连接 */
let exiting = false;

function registerSignalHandlersOnce(shutdown: () => Promise<void>): void {
  let shuttingDown = false;
  const goOffline = (signal: string): void => {
    if (shuttingDown) return; // 双信号幂等——重复 offline 帧不叠退出链
    shuttingDown = true;
    exiting = true;
    // 优雅退出先取消 shell 进程组（abort → SDK 杀进程组，不留孤儿进程）
    // + 在途台账落 interrupted，再发 offline 帧收尾——hub 侧 device-offline 收尾与
    // connector 侧自杀收尾同裁决（interrupted），两侧一致。
    void shutdown().catch(() => { /* best-effort */ }).finally(() => {
      if (currentWs?.readyState === WebSocket.OPEN && currentSid) {
        seq += 1;
        currentWs.send(JSON.stringify({ v: currentVersion, type: "offline", seq, sid: currentSid, data: {} }));
        log("offline requested", { signal });
      }
      setTimeout(() => process.exit(0), 150); // 一拍发送窗口后退出
    });
  };
  process.on("SIGINT", () => goOffline("SIGINT"));
  process.on("SIGTERM", () => goOffline("SIGTERM"));
}

/** 回执发帧闭包：读当前连接（currentWs/currentSid）。执行期间重连时的两个窗口（检视
 *  修订）：新 socket 已开但 hello.ack 未回 → 回执带旧 sid 被 hub 侧 stale-sid 校验丢弃；
 *  hello.ack 已回 → 回执带新 sid 通过校验，但旧会话下线钩子已把等待者收尾（reject+删），
 *  hub 侧 onActionResult 查不到 waiter 而忽略——端到端语义一致：旧会话动作对新会话
 *  不产生落账。连接间隙（currentWs 为空）→ 丢弃并日志。 */
function sendResultFrame(data: Extract<ConnectorFrame, { type: "action.result" }>["data"]): void {
  if (currentWs?.readyState === WebSocket.OPEN && currentSid) {
    seq += 1;
    currentWs.send(JSON.stringify({ v: currentVersion, type: "action.result", seq, sid: currentSid, data }));
  } else {
    log("action result dropped (no live session)", { actionId: data.actionId });
  }
}

/** action.output 发帧闭包（协议 v2）：同 sendResultFrame 的当前连接语义——
 *  执行期间重连则带新 sid 被 hub 旧 sid 校验丢弃（输出帧不改终态，丢弃零副作用）。 */
function sendOutputFrame(data: Extract<ConnectorFrame, { type: "action.output" }>["data"]): void {
  if (currentWs?.readyState === WebSocket.OPEN && currentSid) {
    seq += 1;
    try {
      currentWs.send(JSON.stringify({ v: currentVersion, type: "action.output", seq, sid: currentSid, data }));
    } catch (err) {
      log("action output send failed (non-fatal)", { actionId: data.actionId, error: String(err) });
    }
  }
  // 无活会话时静默丢（输出是易失流，不值得日志噪声——result 帧才记 dropped）
}

/** 执行栈（数据目录 ~/.otter/connector/<deviceId>/）：workspace 网关 +
 *  本地台账（机器侧真相源）+ 公共执行器（六动作，与中枢 local 同一执行语义）+
 *  shell 执行器 + 文件执行器（协议 v2：file.* 族 + 读器句柄）+ 分发器 */
interface ConnectorRuntime {
  dispatcher: ConnectorActionDispatcher;
  shellExecutor: ShellActionExecutor;
  fileExecutor: FileActionExecutor;
  ledger: SqliteActionLedger;
}

async function buildRuntime(identity: DeviceIdentity): Promise<ConnectorRuntime> {
  const dataRoot = path.join(os.homedir(), ".otter", "connector", identity.deviceId);
  await mkdir(dataRoot, { recursive: true });
  const ledger = new SqliteActionLedger(path.join(dataRoot, "action-ledger.sqlite"), {
    deviceId: identity.deviceId, // 台账行归属设备（表结构预留的维度）
  });
  // 开机清扫：旧纪元 running 行裁决（崩溃恢复语义——断线收尾的兑底面）；
  // （检视）：清扫失败不能零日志——残留 running 行永不裁决需排障线索（best-effort 继续）
  const sweep = await ledger.open().catch((err: unknown) => {
    log("ledger boot sweep failed (stale running rows stay unresolved)", { error: String(err) });
    return null;
  });
  if (sweep) log("ledger boot sweep", { ...sweep });
  const workspaceGateway = new NodeWorkspaceGateway(dataRoot);
  const executor = new WorkspaceActionExecutor(workspaceGateway, ledger, (message, meta) => log(message, meta));
  const shellExecutor = new ShellActionExecutor({
    ledger,
    resolveWorkspaceRoot: conversationId => workspaceGateway.getWorkspacePath(conversationId),
    sendOutput: sendOutputFrame,
    log: (message, meta) => log(message, meta),
  });
  const fileExecutor = new FileActionExecutor({
    ledger,
    resolveWorkspaceRoot: conversationId => workspaceGateway.getWorkspacePath(conversationId),
    log: (message, meta) => log(message, meta),
  });
  const dispatcher = new ConnectorActionDispatcher({
    executor,
    shell: shellExecutor,
    file: fileExecutor,
    ledger,
    send: sendResultFrame,
    log: (message, meta) => log(message, meta),
  });
  return { dispatcher, shellExecutor, fileExecutor, ledger };
}

/** 单次连接生命周期。resolve "fatal" = 协议不兼容（重连无意义）；"closed" = 可重连。 */
function connectOnce(hub: string, identity: DeviceIdentity, runtime: ConnectorRuntime): Promise<"closed" | "fatal"> {
  return new Promise(resolve => {
    const wsUrl = new URL("/connector-ws", hub.replace(/^http/, "ws"));
    // 子协议 pin 声明（hub 升级层校验；缺声明的旧版客户端会被 hub 拒——升级
    // connector 包即可，配对身份/协议状态机不变）
    const ws = new WebSocket(wsUrl, [...CONNECTOR_WS_SUBPROTOCOLS], { headers: { authorization: `Bearer ${identity.pairToken}` } });
    const state: ConnState = { sessionId: null, version: CONNECTOR_PROTOCOL_VERSION, heartbeat: null, ackWatch: null, lastAckAt: 0, settled: false };
    const settle = (outcome: "closed" | "fatal"): void => {
      if (state.settled) return;
      state.settled = true;
      if (state.heartbeat) clearInterval(state.heartbeat);
      if (state.ackWatch) clearInterval(state.ackWatch);
      resolve(outcome);
    };
    ws.on("open", () => {
      seq += 1;
      // hello 携带本端支持集（[1,2]）——hub 取交集最高；v1 中枢协商落 v1（六动作面）
      ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq, data: { supportedVersions: [...HELLO_SUPPORTED_VERSIONS] } }));
    });
    attachMessageHandler(ws, identity, state, runtime, settle);
    currentWs = ws; // minor-1：信号处理读最新连接（注册一次，见 registerSignalHandlersOnce）
    ws.on("close", () => {
      log("disconnected", { note: "will reconnect with a fresh session (reconnect ≠ resume)" });
      settle("closed");
    });
    ws.on("error", err => log("ws error", { error: err.message }));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  let identity = await loadIdentity();
  if (args.pair) {
    if (!args.name) throw new Error("--pair requires --name");
    identity = await pairWithHub(args.hub, args.pair, args.name);
    log("paired", { deviceId: identity.deviceId });
  }
  if (!identity) {
    process.stderr.write("no device identity: run with --pair <code> --name <name> first\n");
    process.exit(2);
  }

  // 断线自动重连：指数退避，重连=新会话（hub 侧 sid 代际隔离跨会话重放）
  const runtime = await buildRuntime(identity); // 执行栈（台账清扫后才开始执行动作）
  // 信号处理注册一次（runtime 后——自杀收尾读 dispatcher 在途集）。
  // 先取消 shell 进程组（不留孤儿进程），再落台账 interrupted 收尾。
  registerSignalHandlersOnce(async () => {
    await runtime.shellExecutor.shutdown("connector shutting down (graceful offline)")
      .catch(err => log("shell executor shutdown failed (non-fatal)", { error: String(err) }));
    // 读器句柄全量关闭（进程内资源随下线释放）
    await runtime.fileExecutor.closeAllResources("connector shutting down (graceful offline)")
      .catch(err => log("file executor close failed (non-fatal)", { error: String(err) }));
    await runtime.dispatcher.markInflightInterrupted();
  });
  let backoff = RECONNECT_BASE_MS;
  for (;;) {
    const outcome = await connectOnce(args.hub, identity, runtime);
    if (outcome === "fatal") {
      process.stderr.write("protocol version incompatible with hub — upgrade connector (reconnect pointless)\n");
      process.exit(3);
    }
    if (exiting) { // （检视）：优雅退出中不顶替重连（防新会话被退出再带走）
      log("exit before reconnect", {});
      return;
    }
    log("reconnecting", { inMs: backoff });
    await new Promise(r => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

main().catch(err => {
  process.stderr.write(`connector failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
