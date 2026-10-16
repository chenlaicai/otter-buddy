/**
 * 三麻将局 HTTP 面（方案模块四接口层）——建房/入座/开局/动作注入/视图/复盘/SSE/恢复。
 *
 * 端点（全在 /api/mahjong 下）：
 *   POST /rooms                建房即开局（body: {roomId?, seed?, players[3]}，东风战）
 *   POST /rooms/:roomId/join   入座（body: {seat}）→ 返回该座私有视图
 *   POST /rooms/:roomId/start  开局幂等确认（建房已开局——回执当前状态；未知房 404）
 *   POST /rooms/:roomId/actions 真人动作注入（body: {seat, action}；停驻在该座才接受）
 *   GET  /rooms/:roomId/view?seat= 视图（无 seat=观战全览）
 *   GET  /rooms/:roomId/frames 复盘帧链（默认不带快照；?state=1 带全量快照）+ 链完整性
 *   GET  /rooms/:roomId/events SSE 实时推送（RoomBus 房间粒度）
 *   POST /rooms/:roomId/recover 断线恢复（最新帧还原并续推）
 */

import type { Context } from "hono";
import { randomUUID } from "crypto";
import type { Logger } from "@usecases/ports/logger";
import type { RoomService } from "@usecases/mahjong/room/room-service";
import type { SqliteFrameStore } from "@usecases/mahjong/room/frames";
import type { GameConfig, PlayerConfig, Seat } from "@usecases/mahjong/engine/types";

interface CreateBody {
  roomId?: string;
  seed?: string;
  players?: PlayerConfig[];
}

const KINDS = new Set(["human", "otter", "proxy"]);

function badRequest(c: Context, message: string): Response {
  return c.json({ error: message }, 400);
}

export class MahjongController {
  constructor(
    private readonly rooms: RoomService,
    private readonly frameStore: SqliteFrameStore,
    private readonly logger: Logger,
  ) {}

  /** body.players 合法性（3 座位/种类/otterId 齐全）——通过即返回配置，否则 null */
  private static parsePlayers(raw: unknown): GameConfig["players"] | null {
    const players = raw;
    if (!Array.isArray(players) || players.length !== 3) return null;
    for (const p of players as PlayerConfig[]) {
      if (!p || typeof p.name !== "string" || !KINDS.has(p.kind)) return null;
      if (p.kind === "otter" && !p.otterId) return null;
    }
    return players as unknown as GameConfig["players"];
  }

  /** 建房即开局 */
  async create(ctx: Context): Promise<Response> {
    const body = (await ctx.req.json().catch(() => ({}))) as CreateBody;
    const players = MahjongController.parsePlayers(body.players);
    if (!players) {
      return badRequest(ctx, "players 必须为 3 个合法座位配置（otter 座位需 otterId）");
    }
    const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId : randomUUID();
    const seed = typeof body.seed === "string" && body.seed ? body.seed : `seed-${randomUUID()}`;
    const config: GameConfig = { seed, startPoints: 35000, players };
    try {
      const { gameId } = this.rooms.createRoom(roomId, config);
      return ctx.json({ roomId, gameId, seed, status: "playing" }, 201);
    } catch (e) {
      return ctx.json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
  }

  /** 入座：返回该座私有视图（含手牌） */
  async join(ctx: Context): Promise<Response> {
    const roomId = ctx.req.param("roomId") ?? "";
    const body = (await ctx.req.json().catch(() => ({}))) as { seat?: number };
    if (body.seat !== 0 && body.seat !== 1 && body.seat !== 2) return badRequest(ctx, "seat 必须为 0/1/2");
    const view = this.rooms.view(roomId, body.seat as Seat);
    if (!view) return ctx.json({ error: "room not found" }, 404);
    return ctx.json({ roomId, seat: body.seat, view });
  }

  /** 开局幂等确认（建房即开局——本端点回执当前状态；未知房尝试断线恢复） */
  async start(ctx: Context): Promise<Response> {
    const roomId = ctx.req.param("roomId") ?? "";
    const view = this.rooms.view(roomId, null);
    if (view) return ctx.json({ roomId, status: view.status, view });
    const recovered = this.rooms.recover(roomId);
    if (recovered) return ctx.json({ roomId, status: "recovered", gameId: recovered.gameId });
    return ctx.json({ error: "room not found" }, 404);
  }

  /** 真人动作注入（须停驻在该座位） */
  async action(ctx: Context): Promise<Response> {
    const roomId = ctx.req.param("roomId") ?? "";
    const body = (await ctx.req.json().catch(() => ({}))) as { seat?: number; action?: unknown };
    if (body.seat !== 0 && body.seat !== 1 && body.seat !== 2) return badRequest(ctx, "seat 必须为 0/1/2");
    if (!body.action || typeof body.action !== "object") return badRequest(ctx, "action 必填");
    const res = this.rooms.injectHumanAction(roomId, body.seat as Seat, body.action as never);
    if (!res.ok) return ctx.json({ error: res.reason }, 400);
    const view = this.rooms.view(roomId, body.seat as Seat);
    return ctx.json({ accepted: true, view });
  }

  /** 视图：?seat= 私有（含手牌）；缺省观战全览 */
  async view(ctx: Context): Promise<Response> {
    const roomId = ctx.req.param("roomId") ?? "";
    const seatRaw = ctx.req.query("seat");
    let viewer: Seat | null = null;
    if (seatRaw !== undefined) {
      const n = Number(seatRaw);
      if (n !== 0 && n !== 1 && n !== 2) return badRequest(ctx, "seat 必须为 0/1/2");
      viewer = n as Seat;
    }
    const view = this.rooms.view(roomId, viewer);
    if (!view) return ctx.json({ error: "room not found" }, 404);
    return ctx.json(view);
  }

  /** 复盘帧链（默认不带快照；?state=1 附全量状态）+ 链完整性 */
  async frames(ctx: Context): Promise<Response> {
    const roomId = ctx.req.param("roomId") ?? "";
    const game = this.frameStore.findGameByRoom(roomId);
    if (!game) return ctx.json({ error: "room not found" }, 404);
    const withState = ctx.req.query("state") === "1";
    const rows = this.frameStore.listFrames(game.id).map((f) => ({
      seq: f.seq,
      action: f.action,
      prevHash: f.prevHash,
      hash: f.hash,
      createdAt: f.createdAt,
      ...(withState ? { state: f.state } : {}),
    }));
    const brokenAt = this.frameStore.verifyChain(game.id);
    return ctx.json({ roomId, gameId: game.id, count: rows.length, chainOk: brokenAt === null, brokenAt, frames: rows });
  }

  /** SSE 实时推送（房间粒度；首帧 hello + 15s 心跳注释） */
  async events(ctx: Context): Promise<Response> {
    const roomId = ctx.req.param("roomId") ?? "";
    if (!this.rooms.getGameId(roomId)) return ctx.json({ error: "room not found" }, 404);
    let unsub: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (event: unknown): void => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            /* 流已关 */
          }
        };
        send({ type: "hello", roomId, gameId: this.rooms.getGameId(roomId) });
        unsub = this.rooms.subscribe(roomId, send);
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            /* 流已关 */
          }
        }, 15_000);
      },
      cancel: () => {
        if (heartbeat) clearInterval(heartbeat);
        unsub?.();
      },
    });
    this.logger.info("mahjong SSE subscribe", { roomId });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /** 断线恢复（最新帧还原并续推） */
  async recover(ctx: Context): Promise<Response> {
    const roomId = ctx.req.param("roomId") ?? "";
    const res = this.rooms.recover(roomId);
    if (!res) return ctx.json({ error: "room not found" }, 404);
    const view = this.rooms.view(roomId, null);
    return ctx.json({ roomId, gameId: res.gameId, view });
  }
}
