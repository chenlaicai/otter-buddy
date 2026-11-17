/**
 * F20261117cnnct（#1868 阶段 4 C1）：connector 独立进程入口（客户端侧）。
 *
 * 轻量铁律（issue #1868 阶段 4 / 方案 v3 §7）：本进程不加载模型、embedding、主记忆——
 * 依赖闭包仅 ws + node 内置（构建后由脚本断言）。C1 承载通道与会话：
 * 首启配对（HTTP 换 token）→ WSS 连接（Bearer upgrade 鉴权）→ hello → 心跳 →
 * SIGINT/SIGTERM 主动 offline（总闸）。
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
import { CONNECTOR_HEARTBEAT_INTERVAL_MS, CONNECTOR_PROTOCOL_VERSION } from "@entities/execution/connector-protocol";

interface DeviceIdentity {
  deviceId: string;
  pairToken: string;
}

interface Args {
  hub: string;
  pair?: string;
  name?: string;
}

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
function connect(hub: string, identity: DeviceIdentity): void {
  const wsUrl = new URL("/connector-ws", hub.replace(/^http/, "ws"));
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${identity.pairToken}` } });
  let sessionId: string | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  ws.on("open", () => {
    seq += 1;
    ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "hello", seq, data: { supportedVersions: [CONNECTOR_PROTOCOL_VERSION] } }));
  });

  ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as { type: string; sid?: string; data?: Record<string, unknown> };
    if (frame.type === "hello.ack" && frame.sid) {
      sessionId = frame.sid;
      log("online", { deviceId: identity.deviceId, sessionId, version: frame.data?.version });
      heartbeat = setInterval(() => {
        if (sessionId && ws.readyState === ws.OPEN) {
          seq += 1;
          ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "heartbeat", seq, sid: sessionId, data: {} }));
        }
      }, CONNECTOR_HEARTBEAT_INTERVAL_MS);
    } else if (frame.type === "heartbeat.ack") {
      // 心跳被确认——通道健康
    } else if (frame.type === "error") {
      log("hub error frame", { data: frame.data });
    }
  });

  const goOffline = (signal: string): void => {
    if (sessionId && ws.readyState === ws.OPEN) {
      seq += 1;
      ws.send(JSON.stringify({ v: CONNECTOR_PROTOCOL_VERSION, type: "offline", seq, sid: sessionId, data: {} }));
      log("offline requested", { signal });
    }
    if (heartbeat) clearInterval(heartbeat);
    // 给 offline 帧一拍发送窗口后退出（100ms——尽力而为，中枢侧断线兜底会补收尾）
    setTimeout(() => process.exit(0), 100).unref?.();
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGINT", () => goOffline("SIGINT"));
  process.on("SIGTERM", () => goOffline("SIGTERM"));

  ws.on("close", (code, reason) => {
    if (heartbeat) clearInterval(heartbeat);
    log("disconnected", { code, reason: String(reason), note: "reconnect = new session (resume ≠ restore)" });
    process.exit(0);
  });
  ws.on("error", err => {
    log("ws error", { error: err.message });
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
  connect(args.hub, identity);
}

main().catch(err => {
  process.stderr.write(`connector failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
