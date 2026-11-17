/**
 * F20261117cnnct（#1868 阶段 4 C1）：connector 独立进程入口（客户端侧）。
 *
 * 轻量铁律（issue #1868 阶段 4 / 方案 v3 §7）：本进程不加载模型、embedding、主记忆——
 * 依赖闭包仅 ws + node 内置（构建后由脚本断言）。
 *
 * 通道语义（检视 s1/s2/s3 处置）：断线自动重连（指数退避 1s→30s，重连=新会话——
 * hub 侧 sid 代际天然隔离跨会话重放）；心跳半开自愈（45s 无 heartbeat.ack 判死重连）；
 * version 类协议不兼容是致命错误（重连无意义，退出进程让人介入）。
 *
 * 用法：
 *   node dist/connector/main.js --hub http://localhost:3000 --pair <码> --name <设备名>   # 首启配对
 *   node dist/connector/main.js --hub http://localhost:3000                              # 凭已存身份连接
 * 身份落 ~/.otter/connector/device.json（deviceId + pairToken）。
 */

import { WebSocket } from "ws";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CONNECTOR_HEARTBEAT_INTERVAL_MS,
  CONNECTOR_PROTOCOL_VERSION,
  type ConnectorFrame,
} from "@entities/execution/connector-protocol";

interface DeviceIdentity {
  deviceId: string;
  pairToken: string;
}

interface Args {
  hub: string;
  pair?: string;
  name?: string;
}

/** 心跳半开判死：3 个间隔无 ack 即认为通道死（检视 s2——hub 侧 90s 判死，客户端侧更早自愈） */
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
  heartbeat: NodeJS.Timeout | null;
  ackWatch: NodeJS.Timeout | null;
  lastAckAt: number;
  settled: boolean;
}

/** 心跳双循环：发送间隔 + ack 判死（检视 s2：3 间隔无 ack 主动断开重连——不等 TCP 超时） */
function startHeartbeatLoops(ws: WebSocket, state: ConnState): void {
  state.heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN && state.sessionId) {
      seq += 1;
      ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "heartbeat", seq, sid: state.sessionId, data: {} }));
    }
  }, CONNECTOR_HEARTBEAT_INTERVAL_MS);
  state.ackWatch = setInterval(() => {
    if (Date.now() - state.lastAckAt > HEARTBEAT_ACK_TIMEOUT_MS) {
      log("heartbeat ack timeout, reconnecting", { sessionId: state.sessionId });
      ws.terminate();
    }
  }, CONNECTOR_HEARTBEAT_INTERVAL_MS);
}

function attachMessageHandler(ws: WebSocket, identity: DeviceIdentity, state: ConnState, settle: (o: "closed" | "fatal") => void): void {
  ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as ConnectorFrame;
    if (frame.type === "hello.ack" && frame.sid) {
      state.sessionId = frame.sid;
      state.lastAckAt = Date.now();
      log("online", { deviceId: identity.deviceId, sessionId: frame.sid, version: frame.data.version });
      startHeartbeatLoops(ws, state);
    } else if (frame.type === "heartbeat.ack") {
      state.lastAckAt = Date.now();
    } else if (frame.type === "error") {
      log("hub error frame", { data: frame.data });
      if (frame.data.code === "version") settle("fatal"); // 协议不兼容：重连无意义
    }
  });
}

/** SIGINT/SIGTERM → 主动 offline（尽力而为发帧；hub 侧断线兜底会补收尾） */
function attachSignalHandlers(ws: WebSocket, state: ConnState): void {
  const goOffline = (signal: string): void => {
    if (state.sessionId && ws.readyState === WebSocket.OPEN) {
      seq += 1;
      ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "offline", seq, sid: state.sessionId, data: {} }));
      log("offline requested", { signal });
    }
    setTimeout(() => process.exit(0), 100); // 一拍发送窗口后退出
  };
  process.on("SIGINT", () => goOffline("SIGINT"));
  process.on("SIGTERM", () => goOffline("SIGTERM"));
}

/** 单次连接生命周期。resolve "fatal" = 协议不兼容（重连无意义）；"closed" = 可重连。 */
function connectOnce(hub: string, identity: DeviceIdentity): Promise<"closed" | "fatal"> {
  return new Promise(resolve => {
    const wsUrl = new URL("/connector-ws", hub.replace(/^http/, "ws"));
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${identity.pairToken}` } });
    const state: ConnState = { sessionId: null, heartbeat: null, ackWatch: null, lastAckAt: 0, settled: false };
    const settle = (outcome: "closed" | "fatal"): void => {
      if (state.settled) return;
      state.settled = true;
      if (state.heartbeat) clearInterval(state.heartbeat);
      if (state.ackWatch) clearInterval(state.ackWatch);
      resolve(outcome);
    };
    ws.on("open", () => {
      seq += 1;
      ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq, data: { supportedVersions: [CONNECTOR_PROTOCOL_VERSION] } }));
    });
    attachMessageHandler(ws, identity, state, settle);
    attachSignalHandlers(ws, state);
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

  // 断线自动重连（检视 s1）：指数退避，重连=新会话（hub 侧 sid 代际隔离跨会话重放）
  let backoff = RECONNECT_BASE_MS;
  for (;;) {
    const outcome = await connectOnce(args.hub, identity);
    if (outcome === "fatal") {
      process.stderr.write("protocol version incompatible with hub — upgrade connector (reconnect pointless)\n");
      process.exit(3);
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
