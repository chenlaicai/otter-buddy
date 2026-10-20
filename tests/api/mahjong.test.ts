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
});
