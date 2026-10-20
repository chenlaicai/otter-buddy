/**
 * 獭调度 + 房间服务集成测试：
 *  - 解析契约（序号/对象/裸对象/越界/非法/无 JSON）
 *  - 唤醒失败重试→规则代理兜底；网关异常→兜底
 *  - 全场：mock 獭直调 + 真人注入 + 节流阀（trivial）+ 落帧链 + 终局
 *  - 真人超时→宽限→代理自动摸切（timeout-fallback）
 *  - 断线重连：新 RoomService 实例按房间恢复最新帧并续推
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteFrameStore } from "../../../../src/usecases/mahjong/room/frames";
import {
  RoomBus,
  RoomService,
  type RoomEvent,
} from "../../../../src/usecases/mahjong/room/room-service";
import {
  parseActionReply,
  wakeOtterForDecision,
  SdkOtterGateway,
  type OtterGateway,
} from "../../../../src/usecases/mahjong/room/otter-adapter";
import { SanmaEngine } from "../../../../src/usecases/mahjong/engine/engine";
import type { DecisionPoint, EngineAction, GameConfig } from "../../../../src/usecases/mahjong/engine/types";

function cfg(seed: string): GameConfig {
  return {
    seed,
    startPoints: 35000,
    players: [
      { kind: "otter", name: "A", otterId: "otter-a" },
      { kind: "human", name: "B" },
      { kind: "otter", name: "C", otterId: "otter-c" },
    ],
  };
}

/** mock 獭：从 prompt 动作表里挑（能和就和，否则第一个合法动作），固定口吻 */
function scriptedGateway(calls: { count: number }): OtterGateway {
  return {
    async invoke(_otterId: string, prompt: string): Promise<string> {
      calls.count += 1;
      const matches = [...prompt.matchAll(/^\s*(\d+)\. (\{.*\})$/gm)];
      if (matches.length === 0) return "我无法解析局面（非 JSON 回复）";
      const actions = matches.map((m) => JSON.parse(m[2]) as EngineAction);
      const winIdx = actions.findIndex((a) => a.type === "tsumo" || a.type === "ron");
      const chosen = winIdx >= 0 ? matches[winIdx]! : matches[0]!;
      return `\`\`\`json\n{"action": ${chosen[2]}, "speech": "（獭）走这步"}\n\`\`\``;
    },
  };
}

const LEGAL: EngineAction[] = [
  { type: "discard", tile: "5p" },
  { type: "discard", tile: "1z", riichi: true },
  { type: "ankan", kind: "9s" },
  { type: "kakan", tile: "0p" },
  { type: "pass" },
];

describe("parseActionReply 解析契约", () => {
  it("序号/包装对象/裸对象三形态 + speech", () => {
    expect(parseActionReply('{"action": 0}', LEGAL)).toMatchObject({ ok: true, action: LEGAL[0] });
    expect(parseActionReply('```json\n{"action": {"type":"pass"}}\n```', LEGAL)).toMatchObject({
      ok: true,
      action: LEGAL[4],
    });
    expect(parseActionReply('{"type":"pass","speech":"过"}', LEGAL)).toMatchObject({
      ok: true,
      action: LEGAL[4],
      speech: "过",
    });
    // 空串/纯空白 speech 视同未提供（不携带进事件——检视建议7加固）
    const emptySpeech = parseActionReply('{"type":"pass","speech":""}', LEGAL) as { ok: true; speech?: string };
    expect(emptySpeech.ok).toBe(true);
    expect(emptySpeech.speech).toBeUndefined();
    const blankSpeech = parseActionReply('{"type":"pass","speech":"   "}', LEGAL) as { ok: true; speech?: string };
    expect(blankSpeech.speech).toBeUndefined();
    // 立直弃牌（riichi 位精确匹配）
    expect(parseActionReply('{"action": 1}', LEGAL)).toMatchObject({ ok: true, action: LEGAL[1] });
    expect(parseActionReply('{"action": {"type":"discard","tile":"1z","riichi":false}}', LEGAL)).toMatchObject({
      ok: false,
    });
  });

  it("越界/非法/无 JSON/缺字段 → 拒绝并给出原因", () => {
    const bad = parseActionReply('{"action": 99}', LEGAL);
    expect(bad.ok).toBe(false);
    expect(parseActionReply('{"action": {"type":"chi"}}', LEGAL).ok).toBe(false);
    expect(parseActionReply("纯文本没有 json", LEGAL).ok).toBe(false);
    expect(parseActionReply('{"speech":"没动作"}', LEGAL).ok).toBe(false);
  });
});

describe("wakeOtterForDecision 唤醒与兜底", () => {
  let db: Database.Database;
  let store: SqliteFrameStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SqliteFrameStore(db);
    void store;
  });
  afterEach(() => db.close());

  it("首答非法→携反馈重试成功（attempts=2）", async () => {
    const engine = new SanmaEngine(cfg("w1"));
    engine.startRound();
    const dp = engine.decisionPoint()!;
    let n = 0;
    const gateway: OtterGateway = {
      async invoke() {
        n += 1;
        if (n === 1) return '{"action": {"type":"chi"}}';
        const idx = dp.actions.findIndex((a) => a.type === "discard");
        return JSON.stringify({ action: idx });
      },
    };
    const res = await wakeOtterForDecision({ gateway, engine }, dp);
    expect(res.via).toBe("otter");
    expect(res.attempts).toBe(2);
    expect(res.action.type).toBe("discard");
  });

  it("全败（含异常）→ 规则代理兜底带原因", async () => {
    const engine = new SanmaEngine(cfg("w2"));
    engine.startRound();
    const dp = engine.decisionPoint()!;
    let mode: "garbage" | "throw" = "garbage";
    const gateway: OtterGateway = {
      async invoke() {
        if (mode === "throw") throw new Error("boom-invoke");
        return "全是胡话没有结构";
      },
    };
    const g1 = await wakeOtterForDecision({ gateway, engine }, dp);
    expect(g1.via).toBe("fallback");
    expect(g1.attempts).toBe(2);
    expect(g1.fallbackReason).toContain("JSON");
    mode = "throw";
    const g2 = await wakeOtterForDecision({ gateway, engine }, dp);
    expect(g2.via).toBe("fallback");
    expect(g2.fallbackReason).toContain("boom-invoke");
    // 兜底动作必须合法
    expect(dp.actions.some((a) => JSON.stringify(a) === JSON.stringify(g2.action))).toBe(true);
  });
});

describe("SdkOtterGateway 超时", () => {
  it("invoke 悬挂超时→wake 走代理兜底（锁由端口 invoke 自带，不再外层取锁）", async () => {
    const engine = new SanmaEngine(cfg("w3"));
    engine.startRound();
    const dp = engine.decisionPoint()!;
    let invokeCalls = 0;
    const port = {
      invoke: () => {
        invokeCalls += 1;
        return new Promise<never>(() => undefined); // 悬挂不返
      },
    };
    const gateway = new SdkOtterGateway(port as never, undefined, 30);
    const res = await wakeOtterForDecision({ gateway, engine }, dp);
    expect(res.via).toBe("fallback");
    expect(res.fallbackReason).toContain("timeout");
    expect(invokeCalls).toBe(2); // 两次尝试各 invoke 一次（超时各 30ms）
    expect(dp.actions).toContain(res.action);
  });
});

describe("RoomService 全流程", () => {
  let db: Database.Database;
  let store: SqliteFrameStore;
  let bus: RoomBus;
  let events: RoomEvent[];

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SqliteFrameStore(db);
    bus = new RoomBus();
    events = [];
    bus.subscribe("r1", (e) => events.push(e));
  });
  afterEach(() => db.close());

  /** 等停驻；若停在真人位则注入一个合法动作（dp 首选），继续 */
  async function driveUntilFinished(svc: RoomService, roomId: string): Promise<void> {
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 20000) throw new Error("drive exceeded guard");
      await svc.settled(roomId);
      const view = svc.view(roomId, null);
      expect(view).not.toBeNull();
      if (view!.status === "finished") return;
      const wait = view!.awaitingHuman;
      if (wait) {
        const dp = view!.decision as DecisionPoint;
        const humanSeat = [0, 1, 2].find((s) => view!.players[s]!.kind === "human")!;
        expect(wait.seat).toBe(humanSeat);
        const res = svc.injectHumanAction(roomId, humanSeat as 0 | 1 | 2, dp.actions[0]!);
        expect(res.ok).toBe(true);
        continue;
      }
      // #1564-5：结算停驻（有真人的房局终暂停）——测试驱动点「继续」
      if (view!.settlement) {
        expect(svc.continueRound(roomId).ok).toBe(true);
        continue;
      }
      // 非停驻但 settled —— 推进链空转保护
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("mock 獭直调 + 真人注入跑完东风战：唤醒/节流阀/落帧链全断言", async () => {
    const svc = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
    });
    svc.createRoom("r1", cfg("room-seed-1"));
    await driveUntilFinished(svc, "r1");

    const gameEvents = events.filter((e) => e.type === "game");
    expect(gameEvents.length).toBeGreaterThan(20);
    const vias = gameEvents.map((e) => (e.type === "game" ? e.wake?.via : undefined));
    expect(vias).toContain("trivial"); // 节流阀生效
    expect(vias).toContain("human"); // 真人注入
    expect(vias).toContain("otter"); // 獭直调唤醒（非对话链）
    // 落帧链完整
    const gameId = svc.getGameId("r1")!;
    expect(store.verifyChain(gameId)).toBeNull();
    expect(store.latestFrame(gameId)).not.toBeNull();
    // 广播里有和了/流局结算事件
    const settled = gameEvents.filter(
      (e) => e.type === "game" && e.events.some((ev) => ev.type === "win" || ev.type === "drawEnd" || ev.type === "abortive"),
    );
    expect(settled.length).toBeGreaterThan(0);
    svc.close("r1");
  });

  it("真人超时→宽限→代理自动摸切（timeout-fallback）", async () => {
    const svc = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 20,
      humanGraceMs: 30,
    });
    // 人类坐庄（第 1 个）：开局即停驻
    const config: GameConfig = {
      ...cfg("room-timeout-1"),
      players: [
        { kind: "human", name: "H" },
        { kind: "otter", name: "A", otterId: "otter-a" },
        { kind: "otter", name: "C", otterId: "otter-c" },
      ],
    };
    svc.createRoom("r1", config);
    await svc.settled("r1");
    expect(svc.view("r1", null)!.awaitingHuman).not.toBeNull();
    // 不注入：等超时+宽限自动摸切
    await new Promise((r) => setTimeout(r, 150));
    await svc.settled("r1");
    const vias = events
      .filter((e): e is Extract<RoomEvent, { type: "game" }> => e.type === "game")
      .map((e) => e.wake?.via);
    expect(vias).toContain("timeout-fallback");
    svc.close("r1");
  });

  it("断线重连：新实例按房间恢复最新帧并续推", async () => {
    const svc1 = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
    });
    svc1.createRoom("r1", cfg("recover-room"));
    // 走到第一个真人停驻
    await svc1.settled("r1");
    const before = svc1.view("r1", null)!;
    expect(before.awaitingHuman).not.toBeNull();
    const gameId = svc1.getGameId("r1")!;
    const seqBefore = store.latestFrame(gameId)!.seq;
    svc1.close("r1"); // 模拟进程内存丢失（库保留）

    const svc2 = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
    });
    const rec = svc2.recover("r1");
    expect(rec).not.toBeNull();
    expect(rec!.gameId).toBe(gameId);
    await svc2.settled("r1"); // 推进链异步 park 到真人位后再看视图
    const after = svc2.view("r1", null)!;
    expect(after.awaitingHuman).not.toBeNull(); // 重新 park 到同一决策
    expect(after.decision?.seat).toBe(before.decision?.seat);
    expect(JSON.stringify(after.players)).toBe(JSON.stringify(before.players));
    expect(store.latestFrame(gameId)!.seq).toBe(seqBefore); // 恢复本身不落新帧
    // 续推：注入后帧链继续
    const dp = after.decision!;
    expect(svc2.injectHumanAction("r1", dp.seat, dp.actions[0]!).ok).toBe(true);
    await svc2.settled("r1");
    expect(store.latestFrame(gameId)!.seq).toBeGreaterThan(seqBefore);
    expect(store.verifyChain(gameId)).toBeNull();
    svc2.close("r1");
  });

  it("检视发现2：注入非法动作 → 400 且房间不冻结（重开窗口后续推至终局）", async () => {
    const svc = new RoomService({
      store,
      gateway: scriptedGateway({ count: 0 }),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
    });
    svc.createRoom("r1", cfg("bad-action-seed"));
    const humanSeat = [0, 1, 2].find((s) => svc.view("r1", null)!.players[s]!.kind === "human")! as 0 | 1 | 2;

    // 推进到真人停驻（dealer 是 otter 位时链自驱至人位）
    let guard = 0;
    while (!svc.view("r1", null)!.awaitingHuman) {
      guard += 1;
      if (guard > 20000) throw new Error("park guard");
      await svc.settled("r1");
      await new Promise((r) => setTimeout(r, 5));
    }

    // 非法动作（非法记谱 9z，不在任何合法集）
    const bad = svc.injectHumanAction("r1", humanSeat, { type: "discard", tile: "9z" } as never);
    expect(bad.ok).toBe(false);

    // 关键断言：重挂推进链后窗口重开（修复前 awaiting=null 且无 kick = 永久冻结）
    await svc.settled("r1");
    const reopened = svc.view("r1", null)!;
    expect(reopened.awaitingHuman).not.toBeNull();
    expect(reopened.decision?.seat).toBe(humanSeat);

    // 合法注入可续推 → 全场至终局（不冻结实证）
    const dp2 = reopened.decision!;
    const legal = dp2.actions.find((a) => a.type === "discard") ?? dp2.actions[0]!;
    expect(svc.injectHumanAction("r1", humanSeat, legal as never).ok).toBe(true);
    await driveUntilFinished(svc, "r1");
    expect(svc.view("r1", null)!.status).toBe("finished");
    svc.close("r1");
  });
});
