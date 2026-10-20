/**
 * F20261015mjsg 收尾三钩测试（大獭裁决归引擎层的三条跨层缺口）：
 *  - isSeated(otterId)：D2 精确谓词（入座且进行中；终局后不算）
 *  - 真人回话：addChat 校验与广播 + 下局开局经 gateway 直调注入 + 失败留队次局重试
 *  - onGameover：局终一次性上报（名次/跨局结算亮点/獭发言/代打数），回调抛错仅告警，
 *    recover 已终局牌局不补发
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteFrameStore } from "../../../../src/usecases/mahjong/room/frames";
import {
  RoomBus,
  RoomService,
  type RoomEvent,
  type GameoverReport,
} from "../../../../src/usecases/mahjong/room/room-service";
import type { OtterGateway } from "../../../../src/usecases/mahjong/room/otter-adapter";
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

/** 记录全部唤醒 prompt 的网关：chat 注入 prompt 可注入前 N 次失败；决策挑合法动作（能和就和） */
interface RecordingGateway extends OtterGateway {
  prompts: string[];
  /** 每次 chat 注入的调用（含目标 otter——注入按 otter 座位分队并行） */
  chatInvocations: Array<{ otterId: string; prompt: string }>;
  chatFailuresLeft: number;
  /** chat 注入的应答文本（可置空白测「不广播」分支） */
  chatReply: string;
  /** chat 注入前钩子（竞态测试：注入窗口内往队里塞消息）——至多触发一次由测试自控 */
  onChatInvoke?: () => void;
}

function recordingGateway(): RecordingGateway {
  const gw: RecordingGateway = {
    prompts: [],
    chatInvocations: [],
    chatFailuresLeft: 0,
    chatReply: "收到！",
    async invoke(otterId: string, prompt: string): Promise<string> {
      gw.prompts.push(prompt);
      if (prompt.includes("# 牌桌聊天")) {
        gw.chatInvocations.push({ otterId, prompt });
        gw.onChatInvoke?.();
        if (gw.chatFailuresLeft > 0) {
          gw.chatFailuresLeft -= 1;
          throw new Error("gateway down");
        }
        return gw.chatReply;
      }
      const matches = [...prompt.matchAll(/^\s*(\d+)\. (\{.*\})$/gm)];
      if (matches.length === 0) return "我无法解析局面（非 JSON 回复）";
      const actions = matches.map((m) => JSON.parse(m[2]) as EngineAction);
      const winIdx = actions.findIndex((a) => a.type === "tsumo" || a.type === "ron");
      const chosen = winIdx >= 0 ? matches[winIdx]! : matches[0]!;
      return `\`\`\`json\n{"action": ${chosen[2]}, "speech": "（獭）走这步"}\n\`\`\``;
    },
  };
  return gw;
}

/** 等停驻；停在真人位则注入首选合法动作，直到终局（模块级——控 describe 回调行数） */
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
      const res = svc.injectHumanAction(roomId, humanSeat as 0 | 1 | 2, dp.actions[0]!);
      expect(res.ok).toBe(true);
      continue;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

describe("收尾三钩：isSeated / 真人回话 / onGameover", () => {

  it("isSeated：入座且进行中 true；未知 otter false；终局后 false", async () => {
    const svc = new RoomService({
      store,
      gateway: recordingGateway(),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
    });
    svc.createRoom("r1", cfg("seated-seed"));
    expect(svc.isSeated("otter-a")).toBe(true);
    expect(svc.isSeated("otter-c")).toBe(true);
    expect(svc.isSeated("otter-x")).toBe(false);
    await driveUntilFinished(svc, "r1");
    expect(svc.isSeated("otter-a")).toBe(false); // 终局不再防护
    svc.close("r1");
  });

  it("addChat：入参校验 + chat 广播（回显）", async () => {
    const svc = new RoomService({
      store,
      gateway: recordingGateway(),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
    });
    svc.createRoom("r1", cfg("chat-validate"));
    expect(svc.addChat("nope", 0, "hi")).toEqual({ ok: false, reason: "room not found" });
    expect(svc.addChat("r1", 0, "   ")).toMatchObject({ ok: false });
    expect(svc.addChat("r1", 0, "x".repeat(501))).toMatchObject({ ok: false });
    expect(svc.addChat("r1", 1, "  加油！ ")).toEqual({ ok: true });
    const chatEv = events.find((e) => e.type === "chat");
    expect(chatEv).toMatchObject({ seat: 1, text: "加油！", from: "human", name: "B" });
    svc.close("r1");
  });

  it("真人回话下局开局注入：跨局时经 gateway 直调，成功清队不再重复", async () => {
    const gw = recordingGateway();
    const svc = new RoomService({
      store,
      gateway: gw,
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
    });
    svc.createRoom("r1", cfg("chat-seed-1"));
    expect(svc.addChat("r1", 1, "这局好好打")).toEqual({ ok: true });
    await driveUntilFinished(svc, "r1");

    // 注入按 otter 座位分队并行：首次跨局两个 otter 各注入一次，成功即清队
    //（R2→R3、R3→R4 队空；R4→终局被 status 守卫跳过）
    expect(gw.chatInvocations.length).toBe(2);
    expect(gw.chatInvocations.map((c) => c.otterId).sort()).toEqual(["otter-a", "otter-c"]);
    for (const inv of gw.chatInvocations) {
      expect(inv.prompt).toContain("这局好好打");
      expect(inv.prompt).toContain("[1号位 B]");
      expect(inv.prompt).toContain("东2局开局注入");
    }
    svc.close("r1");
  });

  it("注入失败留队次局重试：首跨局网关异常 → 次跨局带同一文本重试", async () => {
    const gw = recordingGateway();
    gw.chatFailuresLeft = 1;
    const svc = new RoomService({
      store,
      gateway: gw,
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
    });
    svc.createRoom("r1", cfg("chat-seed-2"));
    expect(svc.addChat("r1", 1, "重试可见吗")).toEqual({ ok: true });
    await driveUntilFinished(svc, "r1");

    // 首跨局：otter-a 失败（consumed）+ otter-c 成功；次跨局：otter-a 留队重试成功 → 共 3 次
    expect(gw.chatInvocations.length).toBe(3);
    expect(gw.chatInvocations[0]).toMatchObject({ otterId: "otter-a" });
    expect(gw.chatInvocations[1]).toMatchObject({ otterId: "otter-c" });
    expect(gw.chatInvocations[2]).toMatchObject({ otterId: "otter-a" }); // 失败留队，次局重试
    for (const inv of gw.chatInvocations) expect(inv.prompt).toContain("重试可见吗");
    svc.close("r1");
  });

  it("局终 onGameover 一次性上报：名次守恒/跨局结算亮点/獭发言/代打数", async () => {
    const reports: GameoverReport[] = [];
    const svc = new RoomService({
      store,
      gateway: recordingGateway(),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
      onGameover: (r) => {
        reports.push(r);
      },
    });
    svc.createRoom("r1", cfg("over-seed-1"));
    await driveUntilFinished(svc, "r1");

    expect(reports.length).toBe(1);
    const rep = reports[0]!;
    expect(rep.roomId).toBe("r1");
    expect(rep.seed).toBe("over-seed-1");
    expect(rep.players).toHaveLength(3);
    expect(rep.players.find((p) => p.seat === 1)).toMatchObject({ kind: "human", name: "B" });
    expect(rep.players.find((p) => p.seat === 0)).toMatchObject({ otterId: "otter-a" });

    // 名次：3 家、降序、点数守恒（35000×3——供托在终局已归还）
    expect(rep.ranking).toHaveLength(3);
    const pts = rep.ranking.map((p) => p.points);
    expect(pts).toEqual([...pts].sort((a, b) => b - a));
    expect(pts.reduce((s, p) => s + p, 0)).toBe(105000);

    // 东风战 4 局各恰一次结算（win/drawEnd/abortive）——跨局聚合（round.settlement 只留末局）
    expect(rep.highlights).toHaveLength(4);
    expect(rep.highlights.map((h) => h.roundNo)).toEqual([1, 2, 3, 4]);

    expect(rep.speeches.length).toBeGreaterThan(0);
    expect(rep.proxyFallbacks).toBe(0); // 网关健康、真人未超时代打
    expect(rep.endedAt).toBeGreaterThanOrEqual(rep.startedAt);

    await svc.settled("r1");
    expect(reports.length).toBe(1); // 幂等：终局后不再重复上报
    svc.close("r1");
  });

  it("onGameover 回调抛错仅告警：牌局照常终局、settled 正常返回", async () => {
    const warnings: string[] = [];
    const svc = new RoomService({
      store,
      gateway: recordingGateway(),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
      onGameover: () => {
        throw new Error("card send failed");
      },
      logger: {
        warn: (m: string) => {
          warnings.push(m);
        },
      },
    });
    svc.createRoom("r1", cfg("over-throw"));
    await driveUntilFinished(svc, "r1");
    expect(warnings.some((w) => w.includes("onGameover"))).toBe(true);
    expect(svc.view("r1", null)!.status).toBe("finished");
    svc.close("r1");
  });

  it("recover 已终局牌局：不补发 onGameover（防跨重启重复播报）", async () => {
    const reports: GameoverReport[] = [];
    const svc1 = new RoomService({
      store,
      gateway: recordingGateway(),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
      onGameover: (r) => {
        reports.push(r);
      },
    });
    svc1.createRoom("r1", cfg("over-recover"));
    await driveUntilFinished(svc1, "r1");
    expect(reports).toHaveLength(1);
    svc1.close("r1");

    const svc2 = new RoomService({
      store,
      gateway: recordingGateway(),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
      onGameover: (r) => {
        reports.push(r);
      },
    });
    const rec = svc2.recover("r1");
    expect(rec).not.toBeNull();
    await svc2.settled("r1");
    expect(reports).toHaveLength(1); // 恢复不补发
    svc2.close("r1");
  });

  it("检视发现3/6：终局 status 落库 + 宽限内 view 可用 + 同 roomId 重开（新 gameId、代际不误删）", async () => {
    const svc = new RoomService({
      store,
      gateway: recordingGateway(),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
      evictFinishedMs: 200,
    });
    const first = svc.createRoom("r1", cfg("evict-seed-1"));
    await driveUntilFinished(svc, "r1");

    // ① 宽限内 view 可用（页面终局展示不破）+ status 落库（updateGameStatus 不再是死代码）
    const finishedView = svc.view("r1", null);
    expect(finishedView?.status).toBe("finished");
    expect(store.findGameByRoom("r1")!.status).toBe("finished"); // updateGameStatus 落库实证
    expect(svc.getGameId("r1")).toBe(first.gameId); // 宽限期内仍占位

    // ② 同 roomId 重开：终局旧房出 Map，新 gameId（修复前永久 409）
    const reopened = svc.createRoom("r1", cfg("evict-seed-2"));
    expect(reopened.gameId).not.toBe(first.gameId);
    expect(svc.view("r1", null)!.status).toBe("playing");

    // ③ 代际校验：旧房驱逐定时器到期不得误删新房
    await new Promise((r) => setTimeout(r, 260));
    expect(svc.view("r1", null)!.status).toBe("playing");
    svc.close("r1");
  });

  it("检视发现3：驱逐到期终局房出 Map（view null）", async () => {
    const svc = new RoomService({
      store,
      gateway: recordingGateway(),
      bus,
      humanTimeoutMs: 60_000,
      humanGraceMs: 60_000,
      settleHoldMs: 10, // #1564-5：测试走快自动继续（不点「继续」）
      evictFinishedMs: 20,
    });
    svc.createRoom("r1", cfg("evict-seed-3"));
    await driveUntilFinished(svc, "r1");
    expect(svc.view("r1", null)).not.toBeNull(); // 驱逐前可读
    await new Promise((r) => setTimeout(r, 80));
    expect(svc.view("r1", null)).toBeNull(); // 到期出 Map
    svc.close("r1"); // 不存在也幂等
  });
});

describe("#1532 獭侧回应广播（注入回合；harness 模块级共用）", () => {
  it("#1532 獭侧：注入回应广播 chat 事件（from=otter，观战端同流可见）", async () => {
    const gw = recordingGateway();
    const svc = new RoomService({ store, gateway: gw, bus, humanTimeoutMs: 60_000, humanGraceMs: 60_000, settleHoldMs: 10 });
    svc.createRoom("r1", cfg("chat-echo-seed"));
    expect(svc.addChat("r1", 1, "有人在吗")).toEqual({ ok: true });
    await driveUntilFinished(svc, "r1");

    const otterChats = events.filter(
      (e): e is Extract<RoomEvent, { type: "chat" }> => e.type === "chat" && e.from === "otter",
    );
    expect(otterChats.length).toBe(2); // 两个 otter 座位各注入一次各回应一次（跨局首迁即回）
    expect(otterChats.map((c) => c.seat).sort()).toEqual([0, 2]);
    expect(otterChats.map((c) => c.name).sort()).toEqual(["A", "C"]);
    for (const c of otterChats) expect(c.text).toBe("收到！");
    // 人类回话事件同构带 from/name
    expect(events.some((e) => e.type === "chat" && e.from === "human" && e.name === "B")).toBe(true);
  });

  it("#1532 獭侧：空白回应不广播（session 已注入但不留空泡）", async () => {
    const gw = recordingGateway();
    gw.chatReply = "   ";
    const svc = new RoomService({ store, gateway: gw, bus, humanTimeoutMs: 60_000, humanGraceMs: 60_000, settleHoldMs: 10 });
    svc.createRoom("r1", cfg("chat-echo-blank"));
    expect(svc.addChat("r1", 1, "能听到吗")).toEqual({ ok: true });
    await driveUntilFinished(svc, "r1");

    expect(gw.chatInvocations.length).toBeGreaterThan(0); // 注入发生过
    expect(events.filter((e) => e.type === "chat" && e.from === "otter")).toHaveLength(0);
    expect(events.some((e) => e.type === "chat" && e.from === "human")).toBe(true);
  });

  it("#1532 检视发现2：注入窗口内 addChat 不丢——快照换队，窗口内消息留次局补注入", async () => {
    const gw = recordingGateway();
    let svcRef: RoomService | null = null;
    let midPushed = false;
    gw.onChatInvoke = () => {
      if (midPushed || !svcRef) return;
      midPushed = true;
      // 模拟注入窗口（LLM 调用在途）内真人发言：addChat push 进活队
      expect(svcRef.addChat("r1", 1, "窗口内的话")).toEqual({ ok: true });
    };
    const svc = new RoomService({ store, gateway: gw, bus, humanTimeoutMs: 60_000, humanGraceMs: 60_000, settleHoldMs: 10 });
    svcRef = svc;
    svc.createRoom("r1", cfg("chat-race-seed"));
    expect(svc.addChat("r1", 1, "先说这句")).toEqual({ ok: true });
    await driveUntilFinished(svc, "r1");

    // 双 otter 队列同构；以 otter-a 为准：首迁只带旧消息、窗口内消息次迁必达（修复前被 set([]) 丢弃 → 红）
    const aInv = gw.chatInvocations.filter((c) => c.otterId === "otter-a");
    expect(aInv.length).toBe(2);
    expect(aInv[0]!.prompt).toContain("先说这句");
    expect(aInv[0]!.prompt).not.toContain("窗口内的话");
    expect(aInv[1]!.prompt).toContain("窗口内的话"); // 关键断言：窗口内消息不丢
    svc.close("r1");
  });
});
