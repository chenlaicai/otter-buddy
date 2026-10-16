/**
 * F20261015mjsg 模块四·API 联动集成测试。
 *
 * ① api.js：七个 JSON 端点对真实 Hono 路由的调用面（join 私有视图 / 观战全览 /
 *    动作注入逐字透传 / 复盘帧链 / 404 错误上抛）
 * ② sse.js：假 EventSource + 假 fetch——断线退避、先 recover 再重连、看门狗静默断链
 * ③ 真 SSE 端点桥接：假 EventSource 直连 app.request 的事件流，验证
 *    hello 首帧 → game 推送 → human-wait 推送 → close 干净收尾
 *
 * 测试约束：不用 toHaveBeenCalledTimes/toHaveBeenCalledWith（tests/ lint 禁）——
 * 全部改断言"记录下来的事实数组 / 返回值"。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";
import { createRouter, type Controllers } from "../../src/interface-adapters/http/router";
import { MahjongController } from "../../src/interface-adapters/http/controllers/mahjong-controller";
import { SqliteFrameStore } from "../../src/usecases/mahjong/room/frames";
import { RoomBus, RoomService } from "../../src/usecases/mahjong/room/room-service";
import type { OtterGateway } from "../../src/usecases/mahjong/room/otter-adapter";
import type { PlayerConfig } from "../../src/usecases/mahjong/engine/types";
// @ts-expect-error 页面层原生 JS（无类型声明）——与 scripts/*.mjs 测试同一惯例
import { createApi } from "../../web-mahjong/js/api.js";
// @ts-expect-error 页面层原生 JS（无类型声明）——与 scripts/*.mjs 测试同一惯例
import { connect } from "../../web-mahjong/js/sse.js";

const PLAYERS: PlayerConfig[] = [
  { kind: "proxy", name: "獭 A" },
  { kind: "human", name: "你" },
  { kind: "proxy", name: "獭 B" },
];

async function json(res: Response): Promise<Record<string, any>> {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return (await res.json()) as Record<string, any>;
}

async function waitUntil(fn: () => boolean, ms = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitUntil timeout: ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── ① api.js 对真实路由 ─────────────────────────

describe("api.js × 真实 Hono 路由", () => {
  let db: ReturnType<typeof createTestDb>;
  let store: SqliteFrameStore;
  let rooms: RoomService;
  let app: ReturnType<typeof createRouter>;
  let api: ReturnType<typeof createApi>;
  const ROOM = "api-client-room";

  beforeEach(() => {
    db = createTestDb();
    store = new SqliteFrameStore(db);
    const bus = new RoomBus();
    const gateway: OtterGateway = { invoke: async () => { throw new Error("测试无 otter 座位"); } };
    rooms = new RoomService({ store, gateway, bus, humanTimeoutMs: 60_000, humanGraceMs: 60_000 });
    const logger = createTestLogger();
    app = createRouter({ mahjong: new MahjongController(rooms, store, logger) } as unknown as Controllers, logger);
    // 页面侧 fetch → 直连 app.request（不开端口）
    api = createApi({
      fetchImpl: (path: string, init?: RequestInit) => app.request(path, init ?? {}) as unknown as Promise<Response>,
    });
  });

  afterEach(() => {
    rooms.close(ROOM);
    db.close();
  });

  it("建房 → join 私有视图 → 观战全览 → 动作注入逐字透传 → 复盘帧链", async () => {
    const created = await api.createRoom({ roomId: ROOM, seed: "client-seed", players: PLAYERS });
    expect(created.roomId).toBe(ROOM);
    expect(created.status).toBe("playing");
    expect(created.seed).toBe("client-seed");

    // 入座：自己看得到手牌，别家看不到
    const joined = await api.join(ROOM, 1);
    expect(joined.seat).toBe(1);
    expect(joined.view.players[1].hand).not.toBeNull();
    expect(joined.view.players[0].hand).toBeNull();
    expect(joined.view.players[1].hand.length).toBeGreaterThan(0);

    // 观战：三家手牌全可见
    const spectate = await api.view(ROOM, null);
    expect(spectate.players.every((p: { hand: string[] | null }) => p.hand !== null)).toBe(true);
    expect(spectate.roomId).toBe(ROOM);

    // 停驻在真人座才注入；动作对象原样往返（decision.actions 的这一条就是发出去的那条）
    const parked = await waitUntilPark(ROOM, api);
    const action = parked.decision.actions[0];
    const sent = await api.action(ROOM, 1, action);
    expect(sent.accepted).toBe(true);
    expect(sent.view.players[1].hand).not.toBeNull();
    // 动作只对停驻座生效：注给隔壁座（proxy）→ 400；不是“同一动作重放”——那会碰上并发重停驻的时序
    await expect(api.action(ROOM, 0, action)).rejects.toMatchObject({ status: 400 });

    // 幂等开局回执 + 复盘帧链
    const started = await api.start(ROOM);
    expect(started.status).toBe("playing");
    const frames = await api.frames(ROOM);
    expect(frames.chainOk).toBe(true);
    expect(frames.count).toBeGreaterThan(1);

    // 未知房：404 上抛且带 status
    await expect(api.view("no-such-room")).rejects.toMatchObject({ status: 404 });
    await expect(api.join("no-such-room", 0)).rejects.toMatchObject({ status: 404 });
  });

  async function waitUntilPark(roomId: string, client: ReturnType<typeof createApi>): Promise<Record<string, any>> {
    for (let i = 0; i < 3000; i++) {
      const view = await client.view(roomId, 1);
      if (view.awaitingHuman && view.decision) return view;
      await sleep(5);
    }
    throw new Error("真人未停驻");
  }
});

// ───────────────────────── ② sse.js 重连/恢复策略 ─────────────────────────

describe("sse.js 断线重连与 recover", () => {
  type Status = "connecting" | "open" | "reconnecting" | "error" | "closed";

  it("收帧 → open；断线 → 退避重连（先 recover 再重开）；close 后彻底安静", async () => {
    const sockets: any[] = [];
    const fetchLog: string[] = [];
    const statuses: Status[] = [];
    const events: any[] = [];

    const FakeES = class {
      url: string;
      stopped = false;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      close() {
        this.stopped = true;
      }
      emit(data: unknown) {
        this.onmessage?.({ data: JSON.stringify(data) });
      }
      fail() {
        this.onerror?.();
      }
    };

    const fetchImpl = (async (path: string) => {
      fetchLog.push(path);
      return new Response(JSON.stringify({ roomId: "r" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const handle = connect({
      roomId: "r",
      EventSourceImpl: FakeES as unknown as typeof EventSource,
      fetchImpl,
      backoffMs: (n: number) => n, // 退避压到 1ms，测试跑得动
      onStatus: (s: Status) => statuses.push(s),
      onEvent: (e: any) => events.push(e),
    });

    await waitUntil(() => statuses.includes("open"), 1000, "首连 open");
    sockets[0].emit({ type: "hello", roomId: "r", gameId: "g1" });
    await waitUntil(() => events.length === 1, 1000, "hello 事件");
    expect(events[0].type).toBe("hello");

    // 断线 → 至少重连一次，且第 2 次起先打 recover
    sockets[0].fail();
    await waitUntil(() => sockets.length >= 2, 2000, "重连出第二个 socket");
    await waitUntil(() => fetchLog.some((p) => p.endsWith("/recover")), 2000, "recover 端点被打到");
    expect(fetchLog.find((p) => p.endsWith("/recover"))).toContain("/api/mahjong/rooms/r/recover");
    expect(statuses).toContain("reconnecting");

    // 重连后的新 socket 收帧 → 状态回到 open，退避归零
    sockets[1].emit({ type: "game", roomId: "r", frameSeq: 3 });
    await waitUntil(() => events.some((e) => e.type === "game"), 1000, "game 事件");
    expect(handle.status()).toBe("open");

    const socketCount = sockets.length;
    handle.close();
    expect(handle.status()).toBe("closed");
    // close 后不再产生新连接、也不再有回调进列表
    await sleep(30);
    sockets[1].emit({ type: "game", roomId: "r", frameSeq: 99 });
    await sleep(30);
    expect(sockets.length).toBe(socketCount);
    expect(events.some((e) => e.frameSeq === 99)).toBe(false);
    expect(statuses[statuses.length - 1]).toBe("closed");
  });

  it("静默断链（心跳超时）由看门狗主动重连", async () => {
    const sockets: any[] = [];
    const FakeES = class {
      stopped = false;
      url: string;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      close() {
        this.stopped = true;
      }
    };
    let clock = Date.now();
    const handle = connect({
      roomId: "watch",
      EventSourceImpl: FakeES as unknown as typeof EventSource,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      backoffMs: () => 1,
      idleTimeoutMs: 50,
      now: () => clock,
    });
    await waitUntil(() => sockets.length === 1, 1000, "首连");
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "hello" }) });
    // 模拟心跳断了 100ms（> idleTimeoutMs 50ms）
    clock += 100;
    await waitUntil(() => sockets.length >= 2, 2000, "看门狗触发重连");
    handle.close();
  });
});

// ───────────────────────── ③ 真 SSE 端点 × 假 EventSource ─────────────────────────

describe("真 SSE 端点桥接（hello/game/human-wait）", () => {
  let db: ReturnType<typeof createTestDb>;
  let store: SqliteFrameStore;
  let rooms: RoomService;
  let app: ReturnType<typeof createRouter>;
  let logger: ReturnType<typeof createTestLogger>;
  const ROOM = "sse-bridge-room";

  beforeEach(() => {
    db = createTestDb();
    store = new SqliteFrameStore(db);
    const bus = new RoomBus();
    const gateway: OtterGateway = { invoke: async () => { throw new Error("测试无 otter 座位"); } };
    // 真人停驻 80ms 发 human-wait；宽限 5s 内不会被自动摸切抢走
    rooms = new RoomService({ store, gateway, bus, humanTimeoutMs: 80, humanGraceMs: 5000 });
    logger = createTestLogger();
    app = createRouter({ mahjong: new MahjongController(rooms, store, logger) } as unknown as Controllers, logger);
  });

  afterEach(() => {
    rooms.close(ROOM);
    db.close();
  });

  it("hello 首帧 → 动作后 game 推送 → 停驻后 human-wait 推送 → close 干净收尾", async () => {
    await json(
      await app.request("/api/mahjong/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: ROOM, seed: "sse-seed", players: PLAYERS }),
      }),
    );

    const frames: any[] = [];
    const statuses: string[] = [];

    /** 假 EventSource：把真 SSE 流读出来按 data 帧上抛（浏览器行为的最小等价物） */
    class BridgeES {
      private stopped = false;
      private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(private url: string) {
        queueMicrotask(() => void this.run());
      }
      close() {
        this.stopped = true;
        // 关流：否则读端阻在下一个分片上，服务端心跳定时器与房间订阅要拖到超时才释放
        this.reader?.cancel().catch(() => {});
      }
      private async run(): Promise<void> {
        try {
          const res = await app.request(this.url);
          if (!res.ok || !res.body) throw new Error(`sse http ${res.status}`);
          this.onopen?.();
          const reader = res.body.getReader();
          this.reader = reader;
          const dec = new TextDecoder();
          let buf = "";
          while (!this.stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx = buf.indexOf("\n\n");
            while (idx >= 0) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const line = chunk.split("\n").find((l) => l.startsWith("data:"));
              if (line) {
                frames.push(JSON.parse(line.slice(5).trim()));
              }
              idx = buf.indexOf("\n\n");
            }
          }
          await reader.cancel();
          if (!this.stopped) this.onerror?.();
        } catch {
          if (!this.stopped) this.onerror?.();
        }
      }
    }

    const api = createApi({
      fetchImpl: (path: string, init?: RequestInit) => app.request(path, init ?? {}) as unknown as Promise<Response>,
    });
    const handle = connect({
      roomId: ROOM,
      EventSourceImpl: BridgeES as unknown as typeof EventSource,
      fetchImpl: (path: string, init?: RequestInit) => app.request(path, init ?? {}) as unknown as Promise<Response>,
      backoffMs: () => 5,
      onStatus: (s: string) => statuses.push(s),
      onEvent: () => {},
    });

    // ① hello 首帧
    await waitUntil(() => frames.some((f) => f.type === "hello"), 3000, "hello 首帧");
    const hello = frames.find((f) => f.type === "hello");
    expect(hello.roomId).toBe(ROOM);
    expect(hello.gameId).toBeTruthy();
    expect(statuses).toContain("open");

    // ② 等真人停驻 → 注入动作 → 收到 game 推送（decision/frameSeq 在帧上）
    let parked: Record<string, any> | null = null;
    for (let i = 0; i < 3000 && !parked; i++) {
      const v = await api.view(ROOM, 1);
      if (v.awaitingHuman && v.decision) parked = v;
      else await sleep(5);
    }
    expect(parked, "真人座应停驻").not.toBeNull();
    const before = frames.filter((f) => f.type === "game").length;
    const res = await api.action(ROOM, 1, parked!.decision.actions[0]);
    expect(res.accepted).toBe(true);
    await waitUntil(() => frames.filter((f) => f.type === "game").length > before, 3000, "game 推送");
    const gameFrame = frames.filter((f) => f.type === "game").pop();
    expect(gameFrame.roomId).toBe(ROOM);
    expect(typeof gameFrame.frameSeq).toBe("number");
    if (gameFrame.decision) expect(typeof gameFrame.decision.kind).toBe("string");

    // ③ human-wait（停驻 80ms 后由房间定时器广播）
    await waitUntil(() => frames.some((f) => f.type === "human-wait"), 3000, "human-wait 推送");
    const waitFrame = frames.find((f) => f.type === "human-wait");
    expect(waitFrame.roomId).toBe(ROOM);
    expect(Number.isNaN(new Date(waitFrame.deadline).getTime())).toBe(false);

    // ④ close：状态收在 closed，不再新增帧
    handle.close();
    expect(handle.status()).toBe("closed");
    const count = frames.length;
    await sleep(50);
    expect(frames.length).toBe(count);
  });
});
