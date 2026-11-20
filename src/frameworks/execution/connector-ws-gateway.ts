import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import type { Logger } from "@usecases/ports/logger";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";
import type { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import {
  actionTypeMinVersion,
  CONNECTOR_HEARTBEAT_TIMEOUT_MS,
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_WS_SUBPROTOCOLS,
  HELLO_SUPPORTED_VERSIONS,
  type ConnectorFrame,
} from "@entities/execution/connector-protocol";

/** 下线原因（收尾语义分流的依据）：device-offline=主动优雅下线（在途可确定性裁决
 * interrupted——第4步）；heartbeat-timeout/hub-restart=意外断开（在途真相
 * 不明落 unknown，不对称边界） */
export type ConnectorSessionDownReason = "device-offline" | "heartbeat-timeout" | "hub-restart";

/** 动作通道面——RemoteExecutionMachine 依赖的网关能力子集（测试可 fake） */
export interface ConnectorActionChannel {
  /** 向设备在线连接发帧；离线/无连接返回 false。
   *  协议 v2 闸：帧面超出会话协商版本（v1 会话收 shell.exec/action.cancel）时拒发
   *  返回 false + 告警日志（v1 会话只通行六动作——版本能力闸，下行即拦）。 */
  sendToDevice(deviceId: string, frame: ConnectorFrame): boolean;
  /** action.result 帧回调注册（中枢侧等待者分发） */
  onActionResult(handler: (frame: Extract<ConnectorFrame, { type: "action.result" }>) => void): void;
  /** action.output 流式输出帧回调注册（协议 v2；可选——旧 fake 缺省不实现，
   *  消费方用可选调用 `onActionOutput?.(...)` 接线） */
  onActionOutput?(handler: (frame: Extract<ConnectorFrame, { type: "action.output" }>) => void): void;
  /** 会话下线通知（每一次 online → offline，含原因）——等待者收尾钩子 */
  onSessionDown(handler: (sessionId: string, deviceId: string, reason: ConnectorSessionDownReason) => void): void;
  /** 设备当前在线会话的协商协议版本（离线/未知 → undefined）——
   *  调用方下发 v2 面动作前的预检用（可选，fail-fast 友好错误） */
  negotiatedVersion?(deviceId: string): number | undefined;
}
import type { OnlineSession } from "@entities/execution/online-session";

interface LiveConnection {
  socket: WebSocket;
  deviceId: string;
  sessionId: string;
  lastSeenAt: number;
  /** hello 协商出的会话协议版本——帧校验（v 字段）与下行发帧（v 盖章 + 能力闸）
   *  一律用它而非全局常量（v1/v2 双栈共存窗口） */
  version: number;
}

/**
 * connector WSS 网关——upgrade 鉴权（子协议 pin 双收 + Origin 白名单
 *  + Bearer token 三查）+ 协议 v2/v1 双栈
 * （hello 交集协商/heartbeat/offline + sid 会话代际 + 协商版本级帧校验与下行闸）
 *  + 总闸库层状态机。
 *
 * 事实源纪律：online_sessions 表是唯一事实源——上线/下线先落库，
 * Registry 内存投影随后（先库后内存；库写失败 fail-closed 关通道，宁误下线不误放行）。
 * 旧 sid 帧一律静默丢弃 + 计数日志（模块 C 红线：重连≠恢复）。
 *
 * 边界：只承载通道与会话；动作帧（action.request/result + v2 的 action.output 分发）
 * 落地——本网关收到未知类型帧回 error/protocol；action.cancel 是 S→C 单向帧，
 * 网关只负责按版本闸下发（不在中枢侧执行取消语义）。
 */
export class ConnectorWsGateway {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, LiveConnection>(); // key: sessionId
  /** deviceId → sessionId 反查（动作帧路由用；顶替上线时刷新） */
  private readonly deviceIndex = new Map<string, string>();
  private readonly actionResultHandlers: Array<(frame: Extract<ConnectorFrame, { type: "action.result" }>) => void> = [];
  private readonly actionOutputHandlers: Array<(frame: Extract<ConnectorFrame, { type: "action.output" }>) => void> = [];
  private readonly sessionDownHandlers: Array<(sessionId: string, deviceId: string, reason: ConnectorSessionDownReason) => void> = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  /** 旧 sid 帧丢弃计数（观测模块 C 红线命中情况） */
  private staleFrameDrops = 0;

  constructor(
    private readonly repo: ConnectorRegistryRepository,
    private readonly machineRegistry: ExecutionMachineRegistry,
    private readonly logger: Logger,
    private readonly deps: {
      /** 执行机投影工厂：上线时注册进 Registry（装配处传占位投影，换真 RemoteExecutionMachine） */
      makeMachineProjection?: (deviceId: string, deviceName: string) => ExecutionMachine;
      now?: () => number;
      /** Origin 白名单（exact match）：带 Origin 的升级请求必须命中，否则 403。
       *  未配置（空）= fail-closed 拒所有带 Origin 请求——connector 是 node 客户端不发
       *  Origin 不受影响；防浏览器 CSWSH 与公网跨站探测。 */
      allowedOrigins?: string[];
    } = {},
  ) {
    // noServer 模式：upgrade 事件由宿主 HTTP server 路由进来（同端口）；
    // 子协议回显：升级层已校验声明，握手响应回显 pin 值完成协商
    this.wss = new WebSocketServer({
      noServer: true,
      // 子协议双收优先 v2（升级层已校验声明——此处从客户端声明集里选 pin 回显）
      handleProtocols: (protocols: Set<string>) =>
        CONNECTOR_WS_SUBPROTOCOLS.find(p => protocols.has(p)) ?? false,
    });
    this.wss.on("connection", (socket, request) => this.onConnection(socket, request));
  }

  /** 宿主 server upgrade 路由挂载点：升级请求双查（子协议 pin + Origin 白名单）
   *  + Bearer token 校验（fail-closed 拒升级）。非 connector 路径直接返回 false（交还
   *  宿主处理）；鉴权失败返回 true + reject 回执（子协议/Origin 查先于 token——扫描器
   *  与通用 WS 客户端在指纹层即拒，不进 token 查询路径）。 */
  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    reject: (code: number, reason: string) => void,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/connector-ws") return false;
    const fingerprintRejection = this.checkUpgradeFingerprint(request);
    if (fingerprintRejection) { reject(fingerprintRejection[0], fingerprintRejection[1]); return true; }
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (!token) { reject(401, "missing bearer token"); return true; }
    const device = await this.repo.findDeviceByToken(token).catch(() => null);
    if (!device) { reject(401, "unknown or revoked token"); return true; }
    // token 有效：设备身份挂 request 上下文，交 ws 完成 upgrade（onConnection 读取）
    (request as IncomingMessage & { __connectorDevice?: { id: string; name: string } }).__connectorDevice = { id: device.id, name: device.name };
    this.wss.handleUpgrade(request, socket, head, ws => this.wss.emit("connection", ws, request));
    return true;
  }

  /** 升级指纹双查：①子协议 pin（必须声明 otter-connector.v1——通用客户端/扫描器
   *  挡在指纹层，不进 token 查询路径）②Origin 白名单（无 Origin 放行；带 Origin 必须
   *  命中，白名单空 = fail-closed 拒所有带 Origin 请求——浏览器 CSWSH 纵深防御）。
   *  返回 [code, reason] = 拒；null = 过。*/
  private checkUpgradeFingerprint(request: IncomingMessage): [number, string] | null {
    const subprotocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",").map(s => s.trim()).filter(Boolean);
    if (!subprotocols.some(p => CONNECTOR_WS_SUBPROTOCOLS.includes(p))) return [400, "missing required subprotocol"];
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    if (origin !== undefined && !(this.deps.allowedOrigins ?? []).includes(origin)) {
      return [403, "origin not allowed"];
    }
    return null;
  }

  private onConnection(socket: WebSocket, request: IncomingMessage & { __connectorDevice?: { id: string; name: string } }): void {
    const device = request.__connectorDevice;
    if (!device) return socket.close(1011, "internal: device context missing");
    let live: LiveConnection | null = null;

    socket.on("message", raw => {
      void (async () => {
        try {
          const frame = JSON.parse(String(raw)) as ConnectorFrame;
          if (!live) {
            live = await this.handleFirstFrame(socket, device, frame);
            return;
          }
          await this.handleSessionFrame(socket, device, live, frame);
        } catch (err) {
          this.logger.warn("connector frame handling failed", { deviceId: device.id, error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });

    socket.on("close", () => {
      if (live) void this.shutdown(live, "heartbeat-timeout", 1000, "socket closed").catch(() => {});
    });
    socket.on("error", () => {
      if (live) void this.shutdown(live, "heartbeat-timeout", 1011, "socket error").catch(() => {});
    });
  }

  /** 会话前帧处理：第一帧必须是 hello（否则 protocol 违规关通道）；返回建立的 LiveConnection */
  private async handleFirstFrame(
    socket: WebSocket,
    device: { id: string; name: string },
    frame: ConnectorFrame,
  ): Promise<LiveConnection | null> {
    if (frame.type !== "hello") {
      this.send(socket, { v: CONNECTOR_PROTOCOL_VERSION, type: "error", seq: 0, data: { code: "protocol", message: "first frame must be hello" } });
      socket.close(1002, "protocol violation");
      return null;
    }
    return this.handleHello(socket, device, frame);
  }

  /** 会话内帧处理：sid/版本校验（旧 sid 或错版本丢弃+计数——模块 C 红线）→ 类型分发 */
  private async handleSessionFrame(
    socket: WebSocket,
    device: { id: string; name: string },
    live: LiveConnection,
    frame: ConnectorFrame,
  ): Promise<void> {
    // 会话建立后：所有帧必须带正确 sid + 帧 v 等于本会话协商版本
    // （双栈共存：v1 会话不收 v2 帧，反之亦然）
    if (frame.sid !== live.sessionId || frame.v !== live.version) {
      this.staleFrameDrops += 1;
      this.logger.warn("connector frame dropped (stale sid or bad version)", { deviceId: device.id, sessionId: live.sessionId, frameSid: frame.sid, drops: this.staleFrameDrops });
      return;
    }
    live.lastSeenAt = this.now();
    if (frame.type === "action.result") {
      for (const handler of this.actionResultHandlers) handler(frame);
      return;
    }
    // action.output（协议 v2）：流式输出分发——不改终态，只喂等待者 output 回调。
    // v1 会话不该收到（端上旧版不会发）；收到即落 default → error/protocol（版本能力面）。
    if (frame.type === "action.output" && live.version >= 2) {
      for (const handler of this.actionOutputHandlers) handler(frame);
      return;
    }
    switch (frame.type) {
      case "heartbeat":
        await this.repo.touchOnlineSession(live.sessionId, new Date(this.now()).toISOString());
        this.send(socket, { v: live.version, type: "heartbeat.ack", seq: frame.seq, sid: live.sessionId, data: {} });
        break;
      case "offline":
        await this.shutdown(live, "device-offline", 1001, "device requested offline");
        break;
      default:
        this.send(socket, { v: live.version, type: "error", seq: frame.seq, sid: live.sessionId, data: { code: "protocol", message: `frame type not supported: ${String((frame as { type?: string }).type)}` } });
    }
  }

  /** hello → 版本协商（hub 支持集 ∩ connector 支持集取最高；无交集拒连——hub 支持
   *  [v1,v2] 双栈：旧 connector（仅 v1）协商落 v1 继续六动作；新 connector 落 v2 开放
   *  shell/output/cancel 面）→ 库表开 session（先库后内存）→ hello.ack 下发 sid+版本 */
  private async handleHello(
    socket: WebSocket,
    device: { id: string; name: string },
    frame: Extract<ConnectorFrame, { type: "hello" }>,
  ): Promise<LiveConnection> {
    const supported = frame.data.supportedVersions ?? [];
    const version = Math.max(0, ...HELLO_SUPPORTED_VERSIONS.filter(v => supported.includes(v)));
    if (version <= 0) {
      // 拒连回执 echo 对端 hello 的 v（旧端不核 v 也能解析；新端按自身版本校验）
      this.send(socket, { v: typeof frame.v === "number" ? frame.v : CONNECTOR_PROTOCOL_VERSION, type: "error", seq: frame.seq, data: { code: "version", message: "no overlapping protocol version" } });
      socket.close(1002, "version mismatch");
      throw new Error("version mismatch");
    }

    const now = this.now();
    const session: OnlineSession = {
      id: randomUUID(),
      deviceId: device.id,
      status: "online",
      connectedAt: new Date(now).toISOString(),
      disconnectedAt: null,
      disconnectReason: null,
      lastSeenAt: new Date(now).toISOString(),
      protocolVersion: version,
    };
    // 唯一事实源先行：库写失败 → fail-closed 关通道（不注册内存投影）
    try {
      await this.repo.openOnlineSession(session);
      await this.repo.touchDeviceLastSeen(device.id, session.connectedAt);
    } catch (err) {
      this.logger.error("connector online-session persist failed (fail-closed)", err instanceof Error ? err : new Error(String(err)), { deviceId: device.id });
      socket.close(1011, "session persist failed");
      throw err;
    }
    // 内存投影随后（顶替语义：同 id 后到者顶替旧投影）
    if (this.deps.makeMachineProjection) {
      try {
        this.machineRegistry.replace(this.deps.makeMachineProjection(device.id, device.name));
      } catch (err) {
        this.logger.warn("machine projection register failed (non-fatal, channel stays)", { deviceId: device.id, error: String(err) });
      }
    }

    const live: LiveConnection = { socket, deviceId: device.id, sessionId: session.id, lastSeenAt: now, version };
    this.connections.set(session.id, live);
    this.deviceIndex.set(device.id, session.id);
    this.ensureSweepTimer();
    this.logger.info("connector device online", { deviceId: device.id, sessionId: session.id, protocolVersion: version });
    this.send(socket, { v: version, type: "hello.ack", seq: frame.seq, sid: session.id, data: { version } });
    return live;
  }

  /** 下线五步的通道侧：库表 offline（幂等）→ Registry 注销投影 → 关通道。
   * queued/running 动作收尾与晚到回执丢弃随 remote_action_requests 落地。 */
  private async shutdown(live: LiveConnection, reason: ConnectorSessionDownReason, code: number, message: string): Promise<void> {
    this.connections.delete(live.sessionId);
    if (this.deviceIndex.get(live.deviceId) === live.sessionId) this.deviceIndex.delete(live.deviceId);
    for (const handler of this.sessionDownHandlers) handler(live.sessionId, live.deviceId, reason);
    try {
      await this.repo.closeOnlineSession(live.sessionId, reason, new Date(this.now()).toISOString());
    } catch (err) {
      this.logger.error("connector offline persist failed", err instanceof Error ? err : new Error(String(err)), { sessionId: live.sessionId });
    }
    this.machineRegistry.unregister(live.deviceId);
    this.logger.info("connector device offline", { deviceId: live.deviceId, sessionId: live.sessionId, reason });
    if (live.socket.readyState === live.socket.OPEN) live.socket.close(code, message);
  }

  /** 心跳判死扫描（90s 无心跳的连接判断开——半开检测） */
  private ensureSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const deadline = this.now() - CONNECTOR_HEARTBEAT_TIMEOUT_MS;
      for (const live of [...this.connections.values()]) {
        if (live.lastSeenAt < deadline) {
          this.logger.warn("connector heartbeat timeout", { deviceId: live.deviceId, sessionId: live.sessionId });
          void this.shutdown(live, "heartbeat-timeout", 1001, "heartbeat timeout").catch(() => {});
        }
      }
      if (this.connections.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, CONNECTOR_HEARTBEAT_TIMEOUT_MS / 3);
  }

  /** 中枢启动清扫：所有 online 行落 offline/hub-restart（幂等） */
  async sweepStaleSessionsOnBoot(): Promise<number> {
    const swept = await this.repo.sweepStaleOnlineSessions(new Date(this.now()).toISOString());
    if (swept > 0) this.logger.info("swept stale online sessions on boot", { swept });
    return swept;
  }

  /** 观测面：当前在线连接（诊断/测试） */
  listLiveSessions(): Array<{ deviceId: string; sessionId: string; lastSeenAt: number }> {
    return [...this.connections.values()].map(c => ({ deviceId: c.deviceId, sessionId: c.sessionId, lastSeenAt: c.lastSeenAt }));
  }

  get staleDropCount(): number {
    return this.staleFrameDrops;
  }

  /** 动作通道面实现（ConnectorActionChannel）。
   *  版本能力闸（协议 v2 双栈）：v1 会话只通行六动作——shell.exec 请求与 action.cancel
   *  帧面对其关闭，拒发返回 false + 告警（调用方走通道不可用路径落 unknown，不静默降级）；
   *  发帧 v 字段按会话协商版本盖章（不用全局常量——v1 会话收 v1 帧）。 */
  sendToDevice(deviceId: string, frame: ConnectorFrame): boolean {
    const sessionId = this.deviceIndex.get(deviceId);
    if (!sessionId) return false;
    const live = this.connections.get(sessionId);
    if (!live || live.socket.readyState !== live.socket.OPEN) return false;
    if (frame.type === "action.request" && actionTypeMinVersion(frame.data.action.type) > live.version) {
      this.logger.warn("action rejected by protocol version gate (not sent)", { deviceId, actionType: frame.data.action.type, sessionVersion: live.version });
      return false;
    }
    if (frame.type === "action.cancel" && live.version < 2) {
      this.logger.warn("action.cancel rejected by version gate (v1 session)", { deviceId, actionId: frame.data.actionId });
      return false;
    }
    this.send(live.socket, { ...frame, v: live.version });
    return true;
  }

  onActionResult(handler: (frame: Extract<ConnectorFrame, { type: "action.result" }>) => void): void {
    this.actionResultHandlers.push(handler);
  }

  onActionOutput(handler: (frame: Extract<ConnectorFrame, { type: "action.output" }>) => void): void {
    this.actionOutputHandlers.push(handler);
  }

  negotiatedVersion(deviceId: string): number | undefined {
    const sessionId = this.deviceIndex.get(deviceId);
    return sessionId ? this.connections.get(sessionId)?.version : undefined;
  }

  onSessionDown(handler: (sessionId: string, deviceId: string, reason: ConnectorSessionDownReason) => void): void {
    this.sessionDownHandlers.push(handler);
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const live of [...this.connections.values()]) {
      void this.shutdown(live, "hub-restart", 1001, "hub shutting down").catch(() => {});
    }
    this.wss.close();
  }

  private send(socket: WebSocket, frame: ConnectorFrame): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
