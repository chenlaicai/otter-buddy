/**
 * F20261022mjls：lobby 等待房逻辑（自 room-service 拆出——控 max-lines）。
 * room 内部态经结构化参数注入（同 room-lifecycle.ts 先例）；定时器回调不入 class。
 */
import type { SanmaEngine } from "../engine/engine";
import type { GameConfig, Seat } from "../engine/types";
import type { MahjongDefaultOtter } from "../../settings/settings-keys";
import type { RoomView } from "./room-types";

/** lobby 控制所需的 room 内部态子集（RoomInternal 结构满足） */
export interface LobbyRoom {
  roomId: string;
  gameId: string;
  engine: SanmaEngine;
  /** lobby TTL 驱逐定时器（startRoom/close 清理） */
  lobbyEvictTimer?: ReturnType<typeof setTimeout>;
}

/** startRoom 结果（waiting→playing 转换回执） */
export type StartResult =
  | { ok: true; view: null; alreadyStarted?: boolean }
  | { ok: false; reason: string };

/** startLobbyRoom 依赖（RoomService 注入——不反向依赖 service 类） */
export interface StartLobbyDeps<R extends { engine: SanmaEngine; gameId: string }> {
  getRoom: (roomId: string) => R | null;
  defaultOtters?: (() => Promise<MahjongDefaultOtter[] | null>) | undefined;
  checkOtterUsable?: ((otterId: string) => Promise<string | null>) | undefined;
  /** 座位重配生效时回调（重建引擎 + 回写库内 config——由 service 提供） */
  onSeatsChanged: (room: R, config: GameConfig) => void;
  /** 开始后的发牌起跑链（清 lobby 定时器→发牌→落库落帧广播→kick——由 service 提供） */
  beginPlay: (room: R) => void;
}

/** F20261022mjls：waiting→playing 发牌起跑（牌桌「开始」按钮）。
 *  - 幂等：非 waiting 房重复 start 返回 alreadyStarted 不报错（牌桌刷新重进不误触发）
 *  - 可选 players 覆盖：座位 kind/name/otterId 可在开始时重配（默认獭回填/自定义切换）
 *  - 獭可用性校验（deps.checkOtterUsable 注入时）：otterId 无效/dissolved → 报错不开局（不产生半开局房）
 *  - 默认獭回填（deps.defaultOtters 注入时）：建房时 otter 座位未传 otterId（占位），开始时回填
 *  - 失败语义（PR#1609 delta 修复）：try 只覆盖 beginPlay **之前**的同步配置段（座位/獭校验/引擎重建）——
 *    那段失败才真「房保持 waiting」；beginPlay 内发牌即事实，db 写失败由 beginPlay 自兑降级继续推（见其注释） */
export async function startLobbyRoom<R extends { engine: SanmaEngine; gameId: string }>(
  roomId: string,
  playersOverride: ReadonlyArray<{ kind: string; name: string; otterId?: string }> | undefined,
  deps: StartLobbyDeps<R>,
): Promise<StartResult> {
  const room = deps.getRoom(roomId);
  if (!room) return { ok: false, reason: "room not found" };
  if (room.engine.state.status !== "waiting") return { ok: true, view: null, alreadyStarted: true }; // 幂等
  try {
    // 座位配置：覆盖优先，否则默认獭回填（建房时未显式传 otterId 的 otter 座位）
    const base = playersOverride ?? room.engine.state.config.players;
    const players = await applyDefaultOtters(base, deps.defaultOtters);
    // 獭可用性：任一 otter 座位不可用即拒绝（不开局，房保持 waiting）
    if (deps.checkOtterUsable) {
      const bad = await checkOttersUsable(players, deps.checkOtterUsable);
      if (bad !== null) return { ok: false, reason: bad };
    }
    // 重配座位（players 覆盖/回填生效时）：重建引擎（waiting 态未发牌，重建无损失）+ 回写库内 config
    if (playersOverride !== undefined || players !== base) {
      deps.onSeatsChanged(room, { ...room.engine.state.config, players } as GameConfig);
    }
    deps.beginPlay(room); // waiting→playing + 发牌（发牌即事实；beginPlay 自兑 db 异常，不再抛出）
    return { ok: true, view: null };
  } catch (e) {
    // 只兜 beginPlay 之前的同步段（默认獭缺失/座位配置非法）——此时房保持 waiting 未被破坏
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
export function buildLobbyView(roomId: string, gameId: string, engine: SanmaEngine): RoomView {
  const cfgPlayers = engine.state.config.players;
  return {
    roomId,
    gameId,
    status: "waiting",
    lobby: {
      players: cfgPlayers.map((p, i) => ({
        seat: i as Seat,
        name: p.name,
        kind: p.kind,
        ...(p.otterId ? { otterId: p.otterId } : {}),
      })),
      canStart: true,
    },
    roundNo: engine.state.roundNo,
    honba: engine.state.honba,
    sticks: engine.state.sticks,
    dealer: 0,
    phase: null,
    seatWinds: [],
    wallRemaining: 0,
    doraIndicators: [],
    players: [],
    decision: null,
    awaitingHuman: null,
    settlement: null,
  };
}

/** lobby TTL 防占位——waiting 房到期未开始自动清房（无需 strike，纯超时）。
 *  代际校验同 scheduleEvict：清房前比对 gameId；已开始（非 waiting）不清（防御：startRoom 正常先清此定时器） */
export function scheduleLobbyEvict(room: LobbyRoom, ttlMs: number, evict: (notice: string) => void): void {
  if (room.lobbyEvictTimer) clearTimeout(room.lobbyEvictTimer);
  if (ttlMs <= 0) {
    evict("等待房立即清理（lobbyTtlMs≤0）");
    return;
  }
  const timer = setTimeout(() => {
    if (room.engine.state.status !== "waiting") return;
    evict("等待超时（1 小时未开始），房间已自动清理——可在大厅重新建房");
  }, ttlMs);
  (timer as { unref?: () => void }).unref?.();
  room.lobbyEvictTimer = timer;
}

/** 清除 lobby TTL 定时器（开始/关房时） */
export function clearLobbyEvict(room: LobbyRoom): void {
  if (room.lobbyEvictTimer) {
    clearTimeout(room.lobbyEvictTimer);
    room.lobbyEvictTimer = undefined;
  }
}

/** 默认獭回填——otter 座位缺 otterId（建房占位）时用默认陪打獭配置补齐。
 *  无默认配置且存在占位 otter 座位 → 抛错引导（不产生无法开局的房）。返回原数组引用 = 无变更 */
export async function applyDefaultOtters(
  players: ReadonlyArray<{ kind: string; name: string; otterId?: string }>,
  getDefaults: (() => Promise<MahjongDefaultOtter[] | null>) | undefined,
): Promise<ReadonlyArray<{ kind: string; name: string; otterId?: string }>> {
  const hasPlaceholder = players.some((p) => p.kind === "otter" && !p.otterId);
  if (!hasPlaceholder) return players;
  const defaults = getDefaults ? await getDefaults() : null;
  if (!defaults || defaults.length === 0) {
    throw new Error(
      "otter 座位未配置 otterId，且未设置默认陪打獭（settings mahjong.defaultOtters）——请在建房时选择獭或先配置默认陪打獭",
    );
  }
  let next = 0; // 占位座位按序取默认（不按座位号取——proxy/human 座位不消耗默认位）
  return players.map((p) => {
    if (p.kind !== "otter" || p.otterId) return p;
    const def = defaults[next % defaults.length]!;
    next += 1;
    return { ...p, otterId: def.otterId, name: p.name || def.name };
  });
}

/** 獭可用性校验（active 且未 dissolved）——任一 otter 座位不可用返回报错文案，全可用返回 null。
 *  PR#1609 delta（检视建议 4）：Promise.all 并行校验（座位互不依赖） */
export async function checkOttersUsable(
  players: ReadonlyArray<{ kind: string; name: string; otterId?: string }>,
  check: (otterId: string) => Promise<string | null>,
): Promise<string | null> {
  const otterSeats = players.filter((p) => p.kind === "otter");
  const results = await Promise.all(otterSeats.map((p) => check(p.otterId ?? "")));
  const badIdx = results.findIndex((r) => r !== null);
  if (badIdx === -1) return null;
  const bad = results[badIdx]!;
  const seat = otterSeats[badIdx]!;
  return `座位 otterId 不可用：${seat.otterId}（${bad}）——请在大厅重选陪打獭`;
}
