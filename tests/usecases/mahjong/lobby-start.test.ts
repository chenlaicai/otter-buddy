/**
 * F20261022mjls「建房≠开局」——lobby 等待态生命周期测试。
 *
 * 覆盖方案「验证」节七条断言：
 *  1. 建房 → status=waiting、未发牌（无 hand）、无 kick 起跑
 *  2. start → waiting→playing、发牌、kick 起跑
 *  3. start 幂等：playing 房重复 start 返回当前视图
 *  4. 默认獭回填：不传 otter 座位用 mahjong.defaultOtters；自定义 otterId 覆盖默认
 *  5. waiting 房不计 humanIdleStrikes（决策点等待不被强拆——建房即开局时代的根因场景）
 *  6. lobby TTL：waiting 房 1 小时未 start 自动清理
 *  7. start 校验：自定义獭 otterId 无效/dissolved → 报错不开局
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteFrameStore } from "../../../src/usecases/mahjong/room/frames";
import { RoomBus, RoomService, type RoomEvent } from "../../../src/usecases/mahjong/room/room-service";
import { SanmaEngine } from "../../../src/usecases/mahjong/engine/engine";
import type { GameConfig, PlayerConfig } from "../../../src/usecases/mahjong/engine/types";

/** mock 獭：从 prompt 动作表挑第一个合法动作（够驱动即可，牌局细节不在本文件关注面） */
function scriptedGateway(): { invoke: (otterId: string, prompt: string) => Promise<string> } {
  return {
    async invoke(_otterId: string, prompt: string): Promise<string> {
      const matches = [...prompt.matchAll(/^\s*(\d+)\. (\{.*\})$/gm)];
      if (matches.length === 0) return "我无法解析局面（非 JSON 回复）";
      return `\`\`\`json\n{"action": ${matches[0]![2]}, "speech": "（獭）走这步"}\n\`\`\``;
    },
  };
}

function humanCfg(seed: string): GameConfig {
  return {
    seed,
    startPoints: 35000,
    players: [
      { kind: "human", name: "chen" },
      { kind: "otter", name: "小獭一号", otterId: "otter-a" },
      { kind: "otter", name: "小獭二号", otterId: "otter-c" },
    ],
  };
}

function setup(overrides: Partial<ConstructorParameters<typeof RoomService>[0]> = {}) {
  const db = new Database(":memory:");
  initSchema(db);
  const store = new SqliteFrameStore(db);
  const bus = new RoomBus();
  const events: RoomEvent[] = [];
  bus.subscribe("r1", (e) => events.push(e));
  const svc = new RoomService({
    store,
    gateway: scriptedGateway(),
    bus,
    humanTimeoutMs: 60_000,
    humanGraceMs: 60_000,
    ...overrides,
  });
  return { db, store, bus, events, svc };
}

describe("F20261022mjls 建房≠开局", () => {
  let db: Database.Database;
  let store: SqliteFrameStore;
  let events: RoomEvent[];
  let svc: RoomService;

  beforeEach(() => {
    ({ db, store, events, svc } = setup());
  });
  afterEach(() => {
    svc.close("r1");
    db.close();
  });

  it("① 建房开 lobby 等待房——waiting 态、未发牌、无起跑广播", async () => {
    const { gameId } = svc.createRoom("r1", humanCfg("lobby-1"));
    // 引擎态
    const engine = new SanmaEngine(humanCfg("lobby-1"));
    expect(engine.state.status).toBe("waiting"); // 构造后未 startRound 前 = waiting
    // 视图：waiting + lobby 座位况 + 无牌面
    const view = svc.view("r1", null)!;
    expect(view.status).toBe("waiting");
    expect(view.lobby).not.toBeNull();
    expect(view.lobby!.players.map((p) => [p.seat, p.kind, p.name])).toEqual([
      [0, "human", "chen"],
      [1, "otter", "小獭一号"],
      [2, "otter", "小獭二号"],
    ]);
    expect(view.players).toEqual([]); // 未发牌：无手牌数据
    expect(view.decision).toBeNull();
    // 未起跑：无 game 事件（除建房空广播外无推进帧）、无 human-wait、无 otter 唤醒
    const gameFrames = events.filter((e) => e.type === "game" && e.events.length > 0);
    expect(gameFrames.length).toBe(0);
    expect(events.filter((e) => e.type === "human-wait").length).toBe(0);
    // 落库：waiting 状态（恢复通道可用）
    expect(store.findGameByRoom("r1")!.status).toBe("waiting");
    expect(store.getGame(gameId)!.status).toBe("waiting");
  });

  it("② start 发牌起跑——waiting→playing、13+1 张手牌、kick 推进", async () => {
    svc.createRoom("r1", humanCfg("lobby-2"));
    const res = await svc.startRoom("r1");
    expect(res.ok).toBe(true);
    const view = svc.view("r1", null)!;
    expect(view.status).toBe("playing");
    expect(view.lobby).toBeNull();
    // 发牌实证：三家 13 张起手（庄家已摸 = 14），且有点数
    for (const p of view.players) {
      expect(p.hand!.length).toBeGreaterThanOrEqual(13);
      expect(p.points).toBe(35000);
    }
    expect(view.decision).not.toBeNull();
    // 库内状态同步 playing
    expect(store.findGameByRoom("r1")!.status).toBe("playing");
    // 起跑广播：deal 事件 + 真人位（庄家是 0 号 human）human-wait
    await svc.settled("r1");
    expect(events.some((e) => e.type === "game" && e.events.some((ev) => ev.type === "deal"))).toBe(true);
    expect(events.some((e) => e.type === "human-wait")).toBe(true);
  });

  it("③ start 幂等——playing 房重复 start 不报错不起第二局", async () => {
    svc.createRoom("r1", humanCfg("lobby-3"));
    await svc.startRoom("r1");
    await svc.settled("r1");
    const before = svc.view("r1", null)!;
    const again = await svc.startRoom("r1");
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.alreadyStarted).toBe(true);
    const after = svc.view("r1", null)!;
    // 仍是同一局：局数/庄家/手牌数不变（未重配牌）
    expect(after.roundNo).toBe(before.roundNo);
    expect(after.players.map((p) => p.hand!.length)).toEqual(before.players.map((p) => p.hand!.length));
  });

  it("④ 座位配置——默认獭回填 + 显式 otterId 覆盖 + start 时重配", async () => {
    // 建房时 otter 座位不传 otterId（占位）；start 无默认配置 → 报错引导（不产生半开局房）
    const cfgNoOtter: GameConfig = {
      seed: "lobby-4",
      startPoints: 35000,
      players: [
        { kind: "human", name: "chen" },
        { kind: "otter", name: "小獭一号" },
        { kind: "otter", name: "小獭二号" },
      ],
    };
    svc.createRoom("r1", cfgNoOtter);
    const noDefault = await svc.startRoom("r1").catch((e: Error) => ({ ok: false as const, reason: e.message }));
    expect(noDefault).toMatchObject({ ok: false });
    if (!noDefault.ok) expect(noDefault.reason).toContain("默认陪打獭");
    expect(svc.view("r1", null)!.status).toBe("waiting"); // 房未破坏，仍在等待

    // 默认獭回填：settings 配置两只默认獭 → start 后座位就位
    const svc2 = setup({
      defaultOtters: async () => [
        { otterId: "default-otter-1", name: "默认一号" },
        { otterId: "default-otter-2", name: "默认二号" },
      ],
    });
    try {
      svc2.svc.createRoom("r1", cfgNoOtter);
      const res = await svc2.svc.startRoom("r1");
      expect(res.ok).toBe(true);
      const view = svc2.svc.view("r1", null)!;
      expect(view.players.map((p) => p.kind)).toEqual(["human", "otter", "otter"]);
      // 回填后库内 config 同步（恢复真相源）
      const game = store2Players(svc2.store, "r1");
      expect(game.map((p) => (p as PlayerConfig).otterId ?? null)).toEqual([null, "default-otter-1", "default-otter-2"]);
    } finally {
      svc2.svc.close("r1");
      svc2.db.close();
    }

    // 显式 otterId 覆盖默认：start 带 players 覆盖
    const svc3 = setup({
      defaultOtters: async () => [{ otterId: "default-otter-1", name: "默认一号" }],
    });
    try {
      svc3.svc.createRoom("r1", humanCfg("lobby-4b"));
      const custom: PlayerConfig[] = [
        { kind: "human", name: "chen" },
        { kind: "otter", name: "换的獭", otterId: "my-custom-otter" },
        { kind: "proxy", name: "陪打" },
      ];
      const res = await svc3.svc.startRoom("r1", custom);
      expect(res.ok).toBe(true);
      const view = svc3.svc.view("r1", null)!;
      expect(view.players.map((p) => [p.kind, p.name])).toEqual([
        ["human", "chen"],
        ["otter", "换的獭"],
        ["proxy", "陪打"],
      ]);
      // 库内 config = 覆盖后的最终座位
      const game = store2Players(svc3.store, "r1");
      expect(game.map((p) => (p as PlayerConfig).otterId ?? null)).toEqual([null, "my-custom-otter", null]);
    } finally {
      svc3.svc.close("r1");
      svc3.db.close();
    }
  });

  it("⑤ waiting 房不计 humanIdleStrikes——长时间等待不被离桌止血阀强拆", async () => {
    // 根因场景复现：建房后真人不入场。建房即开局时代：獭推进 → 真人 strike 累计 → 10 决策点强拆。
    const strike = setup({
      humanTimeoutMs: 10,
      humanGraceMs: 10,
      humanIdleStrikeLimit: 2, // 收紧到 2：任何真人超时代打都会立刻计入
    });
    try {
      strike.svc.createRoom("r1", humanCfg("lobby-5"));
      // 等待 300ms（远超 timeout+grace 的 20ms×2）——waiting 房必须纹丝不动
      await new Promise((r) => setTimeout(r, 300));
      const view = strike.svc.view("r1", null)!;
      expect(view.status).toBe("waiting"); // 未被强拆、未被代打推进
      expect(strike.events.filter((e) => e.type === "error")).toEqual([]); // 无停局通知
      // start 后才进入正常超时/代打流程（waiting 豁免只覆盖未开局段）
      const res = await strike.svc.startRoom("r1");
      expect(res.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(strike.svc.view("r1", null)).toBeNull(); // playing 后离桌止血阀照常生效
    } finally {
      strike.svc.close("r1");
      strike.db.close();
    }
  });

  it("⑥ lobby TTL——waiting 房超时自动清房 + 广播通知；已 start 的房不受影响", async () => {
    const ttl = setup({ lobbyTtlMs: 50 });
    try {
      ttl.svc.createRoom("r1", humanCfg("lobby-6"));
      await new Promise((r) => setTimeout(r, 120));
      // TTL 到期清房：view 不再可见 + 通知广播
      expect(ttl.svc.view("r1", null)).toBeNull();
      const notice = ttl.events.find((e) => e.type === "error" && e.message.includes("自动清理"));
      expect(notice).toBeTruthy();
    } finally {
      ttl.svc.close("r1");
      ttl.db.close();
    }
    // 已开始（playing）的房：lobby TTL 定时器已清，不再触发清房
    const started = setup({ lobbyTtlMs: 50, humanTimeoutMs: 60_000, humanGraceMs: 60_000 });
    try {
      started.svc.createRoom("r1", humanCfg("lobby-6b"));
      await started.svc.startRoom("r1");
      await started.svc.settled("r1");
      await new Promise((r) => setTimeout(r, 120));
      expect(started.svc.view("r1", null)).not.toBeNull(); // 仍在（parked 等真人）
      expect(started.events.filter((e) => e.type === "error" && e.message.includes("自动清理"))).toEqual([]);
    } finally {
      started.svc.close("r1");
      started.db.close();
    }
  });

  // PR#1609 delta（检视建议 2）：waiting 房 recover→start 链路——「恢复真相源」核心承诺防护断言
  it("⑧ waiting 房断线恢复：新实例按库恢复 waiting 房，重挂 TTL 后 start 正常开局", async () => {
    const first = setup({ lobbyTtlMs: 300_000 });
    try {
      const { gameId } = first.svc.createRoom("r1", humanCfg("lobby-8"));
      first.svc.close("r1"); // 模拟进程重启/内存丢失（库内首帧 waiting）
      expect(first.svc.view("r1", null)).toBeNull();
      // 新实例（同库同 store）：start 走 recoverToLobby 拉回 waiting 房 → 直接开局
      const revived = new RoomService({
        store: first.store,
        gateway: scriptedGateway(),
        bus: new RoomBus(),
        humanTimeoutMs: 60_000,
        humanGraceMs: 60_000,
        lobbyTtlMs: 300_000,
      });
      try {
        const res = await revived.startRoom("r1");
        expect(res.ok).toBe(true);
        const view = revived.view("r1", null)!;
        expect(view.status).toBe("playing");
        expect(view.gameId).toBe(gameId); // 恢复的是同一场（不是新 gameId）
        expect(first.store.findGameByRoom("r1")!.status).toBe("playing");
      } finally {
        revived.close("r1");
      }
    } finally {
      first.svc.close("r1");
      first.db.close();
    }
  });
});

describe("F20261022mjls 建房≠开局（獭校验段——自上段拆出控 describe 行数）", () => {
  let db: Database.Database;
  let svc: RoomService;

  beforeEach(() => {
    ({ db, svc } = setup());
  });
  afterEach(() => {
    svc.close("r1");
    db.close();
  });

  // PR#1609 delta（检视严重发现）：beginPlay 落库失败自兑——内存照常开局，接口不撒谎
  it("⑦b beginPlay 落库失败自兑：db 写入抛错时内存照常开局，接口仍 ok:true（事实一致）", async () => {
    const base = setup();
    try {
      // 构造 updateGameStatus 抛错的 store 代理（sqlite 锁模拟）：帧链照走，仅 status 落库失败
      const brokenStore = Object.create(base.store) as typeof base.store;
      brokenStore.updateGameStatus = () => {
        throw new Error("sqlite locked (simulated)");
      };
      const svcBroken = new RoomService({
        store: brokenStore,
        gateway: scriptedGateway(),
        bus: new RoomBus(),
        humanTimeoutMs: 60_000,
        humanGraceMs: 60_000,
      });
      try {
        svcBroken.createRoom("r1", humanCfg("lobby-9"));
        const res = await svcBroken.startRoom("r1");
        // 修复前：db 抛错穿透外层 catch → ok:false 谎报「房保持 waiting」（实际已发牌）
        // 修复后：beginPlay 自兑 → ok:true，内存 playing（真相源），接口与事实一致
        expect(res.ok).toBe(true);
        expect(svcBroken.view("r1", null)!.status).toBe("playing");
      } finally {
        svcBroken.close("r1");
      }
    } finally {
      base.svc.close("r1");
      base.db.close();
    }
  });

  it("⑦ start 獭可用性校验——无效/dissolved otterId 报错不开局，房保持 waiting", async () => {
    const svc7 = setup({
      checkOtterUsable: async (otterId: string) => {
        if (otterId === "ghost-otter") return "otter not found";
        if (otterId === "dead-otter") return "otter dissolved";
        return null;
      },
    });
    try {
      // 无效 otterId
      svc7.svc.createRoom("r1", {
        seed: "lobby-7",
        startPoints: 35000,
        players: [
          { kind: "human", name: "chen" },
          { kind: "otter", name: "幽灵獭", otterId: "ghost-otter" },
          { kind: "otter", name: "正常獭", otterId: "ok-otter" },
        ],
      });
      const bad = await svc7.svc.startRoom("r1");
      expect(bad).toMatchObject({ ok: false });
      if (!bad.ok) expect(bad.reason).toContain("ghost-otter");
      expect(svc7.svc.view("r1", null)!.status).toBe("waiting"); // 未产生半开局房
      expect(svc7.store.findGameByRoom("r1")!.status).toBe("waiting");

      // dissolved otterId（start 覆盖换獭路径同样校验）
      const dead = await svc7.svc.startRoom("r1", [
        { kind: "human", name: "chen" },
        { kind: "otter", name: "亡獭", otterId: "dead-otter" },
        { kind: "otter", name: "正常獭", otterId: "ok-otter" },
      ]);
      expect(dead).toMatchObject({ ok: false });
      if (!dead.ok) expect(dead.reason).toContain("otter dissolved");

      // 换成全可用座位 → 开局成功（同一房修复后可开）
      const ok = await svc7.svc.startRoom("r1", [
        { kind: "human", name: "chen" },
        { kind: "otter", name: "正常獭A", otterId: "ok-otter" },
        { kind: "proxy", name: "陪打" },
      ]);
      expect(ok.ok).toBe(true);
      expect(svc7.svc.view("r1", null)!.status).toBe("playing");
    } finally {
      svc7.svc.close("r1");
      svc7.db.close();
    }
  });
});

/** 从库内读最终座位配置（config 回写断言用） */
function store2Players(store: SqliteFrameStore, roomId: string): GameConfig["players"] {
  const game = store.findGameByRoom(roomId)!;
  const cfg = game.config as unknown as GameConfig;
  return cfg.players;
}
