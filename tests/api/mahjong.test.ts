/**
 * 三麻将局 API 集成测试（真实 sqlite + 真实 router 注册面）：
 *  - 建房（proxy+human+proxy 座位——不触发 SDK）→ 视图/入座/开局幂等
 *  - SSE 首帧（hello）+ 房间粒度推送
 *  - 真人动作注入循环跑完东风战 → 帧链 chainOk
 *  - 断线恢复端点 + 复盘帧链端点
 *  - 非法输入 400/404
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

const PLAYERS: PlayerConfig[] = [
  { kind: "proxy", name: "P0" },
  { kind: "human", name: "H1" },
  { kind: "proxy", name: "P2" },
];

async function json(res: Response): Promise<Record<string, any>> {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return (await res.json()) as Record<string, any>;
}

describe("三麻将局 API", () => {
  let db: ReturnType<typeof createTestDb>;
  let store: SqliteFrameStore;
  let rooms: RoomService;
  let app: ReturnType<typeof createRouter>;
  let logger: ReturnType<typeof createTestLogger>;
  const ROOM = "api-room-1";

  beforeEach(() => {
    db = createTestDb();
    store = new SqliteFrameStore(db);
    const bus = new RoomBus();
    const gateway: OtterGateway = {
      invoke: async () => {
        throw new Error("api test 无 otter 座位——不应触发唤醒");
      },
    };
    rooms = new RoomService({ store, gateway, bus, humanTimeoutMs: 60_000, humanGraceMs: 60_000, settleHoldMs: 10 });
    logger = createTestLogger();
    const controller = new MahjongController(rooms, store, logger);
    app = createRouter({ mahjong: controller } as unknown as Controllers, logger);
  });

  afterEach(() => {
    rooms.close(ROOM);
    db.close();
  });

  async function sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  /** 等真人停驻（或终局）；HTTP 面无 settled 句柄 → 轮询视图 */
  async function waitHumanOrDone(roomId: string): Promise<Record<string, any>> {
    for (let i = 0; i < 4000; i++) {
      const view = (await json(await app.request(`/api/mahjong/rooms/${roomId}/view`))) as Record<string, any>;
      if (view.status === "finished" || view.awaitingHuman) return view;
      await sleep(5);
    }
    throw new Error("waitHumanOrDone timeout");
  }

  it("建房→视图/入座/开局幂等→真人注入跑完→帧链+SSE+恢复", async () => {
    // ① 建房即开局
    const created = await json(
      await app.request("/api/mahjong/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: ROOM, seed: "api-seed-1", players: PLAYERS }),
      }),
    );
    expect(created.status).toBe("playing");
    expect(created.seed).toBe("api-seed-1");

    // ② SSE 首帧 hello（读一段即断开）
    const sse = await app.request(`/api/mahjong/rooms/${ROOM}/events`);
    expect(sse.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = sse.body!.getReader();
    const first = await reader.read();
    const helloLine = new TextDecoder().decode(first.value);
    expect(helloLine).toContain('"type":"hello"');
    expect(helloLine).toContain(ROOM);
    await reader.cancel();

    // ③ 视图：入座私有（含手牌）+ 观战全览 + 开局幂等回执
    const joined = await json(
      await app.request(`/api/mahjong/rooms/${ROOM}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seat: 1 }),
      }),
    );
    expect(joined.view.players[1].hand).not.toBeNull();
    expect(joined.view.players[0].hand).toBeNull();
    const spectate = (await json(await app.request(`/api/mahjong/rooms/${ROOM}/view`))) as Record<string, any>;
    expect(spectate.players.every((p: { hand: string[] | null }) => p.hand !== null)).toBe(true);
    const started = await json(await app.request(`/api/mahjong/rooms/${ROOM}/start`, { method: "POST" }));
    expect(started.status).toBe("playing");

    // ④ 真人注入循环跑完东风战
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 20000) throw new Error("api drive guard");
      const view = await waitHumanOrDone(ROOM);
      if (view.status === "finished") break;
      expect(view.awaitingHuman.seat).toBe(1);
      const injected = await app.request(`/api/mahjong/rooms/${ROOM}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seat: 1, action: view.decision.actions[0] }),
      });
      expect(injected.status).toBe(200);
    }

    // ⑤ 帧链端点：完整且校验通过
    const frames = (await json(await app.request(`/api/mahjong/rooms/${ROOM}/frames`))) as Record<string, any>;
    expect(frames.chainOk).toBe(true);
    expect(frames.count).toBeGreaterThan(30);
    expect(frames.frames[0].seq).toBe(0);
    expect(frames.frames[0].action).toBeNull();
    expect(frames.frames[1].prevHash).toBe(frames.frames[0].hash);
    // 结算态
    expect(spectate.status === "playing").toBe(true); // 首查时在打
    const finalView = (await json(await app.request(`/api/mahjong/rooms/${ROOM}/view`))) as Record<string, any>;
    expect(finalView.status).toBe("finished");
    const pointsSum = finalView.players.reduce((s: number, p: { points: number }) => s + p.points, 0);
    expect(pointsSum).toBe(105000 - finalView.sticks * 1000);

    // ⑥ 断线恢复端点（内存房间仍在——幂等回执；关房后再 recover 走库）
    rooms.close(ROOM);
    const recovered = await json(await app.request(`/api/mahjong/rooms/${ROOM}/recover`, { method: "POST" }));
    expect(recovered.gameId).toBe(created.gameId);
    expect(recovered.view.status).toBe("finished");
    rooms.close(ROOM);
  });

  it("非法输入：缺 players/坏 seat/未知房/非法动作", async () => {
    const bad1 = await app.request("/api/mahjong/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ players: [{ kind: "proxy", name: "x" }] }),
    });
    expect(bad1.status).toBe(400);

    const bad2 = await app.request("/api/mahjong/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: "bad-room",
        players: [{ kind: "otter", name: "noId" }, { kind: "human", name: "h" }, { kind: "proxy", name: "p" }],
      }),
    });
    expect(bad2.status).toBe(400);

    expect((await app.request("/api/mahjong/rooms/nope/view")).status).toBe(404);
    expect((await app.request("/api/mahjong/rooms/nope/frames")).status).toBe(404);
    expect((await app.request("/api/mahjong/rooms/nope/events")).status).toBe(404);
    expect((await app.request("/api/mahjong/rooms/nope/recover", { method: "POST" })).status).toBe(404);

    // 房间存在但动作不在停驻位 → 400
    await app.request("/api/mahjong/rooms/bad-room2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: "bad-room2",
        players: PLAYERS,
      }),
    });
    const notParked = await app.request("/api/mahjong/rooms/bad-room2/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: 1, action: { type: "discard", tile: "1p" } }),
    });
    expect(notParked.status).toBe(400);
    rooms.close("bad-room2");
  });

  it("真人回话端点：404 未知房/400 校验/200 入队回执/409 终局拒收", async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // 未知房 404
    expect((await post("/api/mahjong/rooms/nope/chat", { seat: 1, text: "hi" })).status).toBe(404);

    // 建房即开局
    const created = await json(
      await post("/api/mahjong/rooms", { roomId: ROOM, seed: "api-chat-seed", players: PLAYERS }),
    );
    expect(created.status).toBe("playing");

    // 400：坏 seat / 非字符串 text / 缺 text
    expect((await post(`/api/mahjong/rooms/${ROOM}/chat`, { seat: 7, text: "x" })).status).toBe(400);
    expect((await post(`/api/mahjong/rooms/${ROOM}/chat`, { seat: 1, text: 123 })).status).toBe(400);
    expect((await post(`/api/mahjong/rooms/${ROOM}/chat`, { seat: 1 })).status).toBe(400);

    // 200：入队回执（含视图，供页面刷新）
    const ok = (await json(
      await post(`/api/mahjong/rooms/${ROOM}/chat`, { seat: 1, text: " 加油！" }),
    )) as Record<string, any>;
    expect(ok.accepted).toBe(true);
    expect(ok.seat).toBe(1);
    expect(ok.view.status).toBe("playing");

    // 驱动到终局 → 409
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 20000) throw new Error("chat test drive guard");
      const view = await waitHumanOrDone(ROOM);
      if (view.status === "finished") break;
      const injected = await post(`/api/mahjong/rooms/${ROOM}/actions`, {
        seat: 1,
        action: view.decision.actions[0],
      });
      expect(injected.status).toBe(200);
    }
    expect((await post(`/api/mahjong/rooms/${ROOM}/chat`, { seat: 1, text: "晚了" })).status).toBe(409);
  });

  it("继续/停局端点契约：continue 404/400/200/409 + stop 404/200（#1564-5/#1564-6）", async () => {
    // 自建长停驻服务（settleHoldMs=60s）——停驻窗口可控，不靠 10ms 自动放行抢拍
    const rooms2 = new RoomService({
      store,
      gateway: { invoke: async () => { throw new Error("api test 无 otter 座位——不应触发唤醒"); } },
      bus: new RoomBus(),
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 60_000,
    });
    const app2 = createRouter({ mahjong: new MahjongController(rooms2, store, logger) } as unknown as Controllers, logger);
    const post2 = async (path: string, body?: unknown): Promise<Response> =>
      app2.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    const view2 = async (roomId: string): Promise<Record<string, any>> =>
      (await json(await app2.request(`/api/mahjong/rooms/${roomId}/view`))) as Record<string, any>;
    const waitView = async (roomId: string, label: string): Promise<Record<string, any>> => {
      for (let i = 0; i < 4000; i++) {
        const v = await view2(roomId);
        if (v.status === "finished" || v.awaitingHuman || v.settlement) return v;
        await sleep(5);
      }
      throw new Error(`waitView timeout: ${label}`);
    };
    const R = "api-life-1";
    try {
      // 未知房：continue/stop 均 404
      expect((await post2("/api/mahjong/rooms/nope/continue")).status).toBe(404);
      expect((await post2("/api/mahjong/rooms/nope/stop")).status).toBe(404);

      // 建房（human 在 1 号座）→ 非停驻态 continue 400（等真人动作时）
      const created = (await json(await post2("/api/mahjong/rooms", { roomId: R, seed: "api-life-seed", players: PLAYERS }))) as Record<string, any>;
      expect(created.status).toBe("playing");
      let v = await waitView(R, "first await");
      expect(v.awaitingHuman).toBeTruthy();
      expect((await post2(`/api/mahjong/rooms/${R}/continue`)).status).toBe(400);

      // 驱动到局终停驻（settlement 可见 = 停驻中，60s 不自动放行）→ continue 200
      for (;;) {
        if (v.settlement) break;
        if (v.status === "finished") throw new Error("unexpected early finish before settle park");
        expect((await post2(`/api/mahjong/rooms/${R}/actions`, { seat: 1, action: v.decision.actions[0] })).status).toBe(200);
        v = await waitView(R, "drive to settle");
      }
      const continued = (await json(await post2(`/api/mahjong/rooms/${R}/continue`))) as Record<string, any>;
      expect(continued.accepted).toBe(true);

      // 续跑至终局（局终停驻处放行）→ continue 409
      for (;;) {
        v = await waitView(R, "drive to gameover");
        if (v.status === "finished") break;
        if (v.settlement) {
          expect((await post2(`/api/mahjong/rooms/${R}/continue`)).status).toBe(200);
          continue;
        }
        expect((await post2(`/api/mahjong/rooms/${R}/actions`, { seat: 1, action: v.decision.actions[0] })).status).toBe(200);
      }
      expect((await post2(`/api/mahjong/rooms/${R}/continue`)).status).toBe(409);
      // 终局房可停（止血阀对已终局同样可关）→ 200；再停 404（已出 Map）
      expect((await post2(`/api/mahjong/rooms/${R}/stop`)).status).toBe(200);
      expect((await post2(`/api/mahjong/rooms/${R}/stop`)).status).toBe(404);

      // 进行中停局：新局直接停 → 200，视图随即 404（房已出 Map）
      const R2 = "api-life-2";
      await json(await post2("/api/mahjong/rooms", { roomId: R2, seed: "api-life-seed-2", players: PLAYERS }));
      const stopped = (await json(await post2(`/api/mahjong/rooms/${R2}/stop`))) as Record<string, any>;
      expect(stopped.stopped).toBe(true);
      expect((await app2.request(`/api/mahjong/rooms/${R2}/view`)).status).toBe(404);
    } finally {
      rooms2.close(R);
      rooms2.close("api-life-2");
    }
  });
});
