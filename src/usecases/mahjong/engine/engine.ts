/**
 * SanmaEngine——三麻牌局状态机（东风战 4 局）。
 *
 * 分层：动作合法性全部委托裁判层（referee），引擎只管阶段流转（配牌→摸打→副露窗口→
 * 立直→和了/流局）、计分结算、供托/本场、确定性配牌与落帧快照。
 *
 * 阶段模型：
 *   turn  —— 当前行动家已持 14 张（已摸或副露后待打）；决策=打/立直/自摸/杠/拔北/九种九牌
 *   claim —— 打牌后的副露窗口（和>碰/杠，双响允许）；候选家按离打出者近者先问，全员答完后裁决
 *   win/draw —— 结算停驻；nextRound() 推进
 *
 * 口径注记（未实测项见方案文档「实现记录·口径核实」节）：
 *   - 拔北补牌从活山取（雀魂实盘待对照）；王牌 14 张固定布局 [0..3]岭上 [4..8]表宝牌 [9..13]里宝牌
 *   - 三麻本场：荣和 +200×本场（放铳者代付两家份额）、自摸每家 +100×本场（结构对称推定）
 *   - 双响供托均分（1000 可被 2 整除）
 *   - 包牌（大三元/大四喜）：仅荣和，三个/四个刻子全部由「打出牌完成」才有包牌者（取最后完成者）；自摸成刻不入包
 *   - 立直后不提供拔北（手牌锁定，引擎口径）
 */
/* eslint-disable max-lines -- SanmaEngine 单类：阶段流转/副露窗口/结算共享私有状态机不变量，方法拆入多文件需 mixin 或上下文传递，会剖裂不变量与法规对读（参照 referee 分支即条目先例） */

import type { Tile } from "../../../entities/mahjong/tile";
import type { Meld } from "../../../entities/mahjong/meld";
import {
  buildSanmaWall,
  countsByKind,
  formatTiles,
  isSanmaKind,
  parseTiles,
  sortTiles,
  tileKind,
} from "../../../entities/mahjong/tile";
import { isMenzen } from "../../../entities/mahjong/meld";
import {
  canCall,
  canDiscard,
  canRiichi,
  canRon,
  detectAbortiveDraw,
  evaluateWin,
  isFuriten,
  isTenpai,
  isWinning,
  notenSettlement,
  pointsFromHanFu,
  waits,
} from "../referee";
import type { WinContext, WinResult } from "../referee";
import { createRng, shuffle } from "./rng";
import type {
  ApplyResult,
  DecisionPoint,
  EngineAction,
  EngineEvent,
  GameConfig,
  GameState,
  PlayerState,
  RoundState,
  Seat,
  Settlement,
  WallState,
  ClaimWindow,
} from "./types";

const SEAT_WINDS = ["east", "south", "west"] as const;
type Wind = (typeof SEAT_WINDS)[number];
const DRAGON_KINDS = new Set([31, 32, 33]);
const WIND_KINDS = new Set([27, 28, 29, 30]);
const NORTH_KIND = 30;
const HONBA_RON = 200;
const HONBA_TSUMO = 100;

/** 动作非法（动作不在该座位的合法集内 / 阶段不符） */
/** 从落帧快照恢复引擎（断线重连/进程重启/复盘续跑）——state 全量替换，config 同源于快照 */
export function restoreEngine(state: GameState): SanmaEngine {
  const engine = new SanmaEngine(state.config);
  Object.assign(engine.state, state);
  return engine;
}

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}

export function notation(tile: Tile): string {
  return formatTiles([tile]);
}

function sameAction(a: EngineAction, b: EngineAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "discard" && b.type === "discard") {
    return a.tile === b.tile && (a.riichi === true) === (b.riichi === true);
  }
  if (a.type === "ankan" && b.type === "ankan") return a.kind === b.kind;
  if (a.type === "kakan" && b.type === "kakan") return a.tile === b.tile;
  return true;
}

/** 鸣牌来源（相对打出者） */
function relSource(discardSeat: Seat, caller: Seat): Meld["from"] {
  if ((caller + 1) % 3 === discardSeat) return "shimocha";
  if ((caller + 2) % 3 === discardSeat) return "kamicha";
  return "toimen";
}

export class SanmaEngine {
  readonly state: GameState;
  private events: EngineEvent[] = [];

  constructor(config: GameConfig) {
    this.state = { config, status: "playing", roundNo: 1, honba: 0, sticks: 0 };
  }

  private get round(): RoundState {
    const r = this.state.round;
    if (!r) throw new Error("round not started");
    return r;
  }

  dealerSeat(): Seat {
    return ((this.state.roundNo - 1) % 3) as Seat;
  }

  seatWind(seat: Seat): Wind {
    const d = this.dealerSeat();
    return SEAT_WINDS[(seat - d + 3) % 3]!;
  }

  private liveRemain(w: WallState): number {
    return w.tiles.length - w.drawIdx;
  }

  private rinshanRemain(w: WallState): number {
    return 4 - w.rinshanIdx;
  }

  // ─────────────────────────── 轮次生命周期 ───────────────────────────

  /** 开局/开新一轮：确定性配牌 + 庄家第一摸 */
  startRound(): EngineEvent[] {
    this.events = [];
    const cfg = this.state.config;
    const prev = this.state.round;
    const carry = prev ? prev.players.map((p) => p.points) : cfg.players.map(() => cfg.startPoints);
    const rng = createRng(`${cfg.seed}:round:${this.state.roundNo}`);
    const shuffled = shuffle(buildSanmaWall(), rng);
    const deadWall = shuffled.slice(94);
    const live = shuffled.slice(0, 94);
    const players = cfg.players.map((p, i): PlayerState => {
      const seat = i as Seat;
      return {
        seat,
        kind: p.kind,
        name: p.name,
        otterId: p.otterId,
        points: carry[i]!,
        hand: [],
        melds: [],
        kitaTiles: [],
        discards: [],
        riichi: false,
        ippatsu: false,
        tempFuriten: false,
        riichiTurn: -1,
      };
    });
    let idx = 0;
    for (const p of players) {
      p.hand = sortTiles(live.slice(idx, idx + 13));
      idx += 13;
    }
    const dealer = this.dealerSeat();
    this.state.round = {
      roundWind: "east",
      roundNo: this.state.roundNo,
      honba: this.state.honba,
      sticks: this.state.sticks,
      wall: { tiles: live, drawIdx: idx, deadWall, rinshanIdx: 0, doraRevealed: 1 },
      players: players as [PlayerState, PlayerState, PlayerState],
      phase: "turn",
      turn: dealer,
      drawnRinshan: false,
      firstDiscards: [],
      firstDiscardsValid: true,
      totalKans: 0,
      fourthKanResolved: true,
      baoDragon: {},
      baoWind: {},
      seq: 0,
    };
    this.events.push({ type: "deal", roundNo: this.state.roundNo });
    this.drawInto(dealer, false);
    return this.events;
  }

  /** 结算后推进：东 4 结束→终局，否则下一轮 */
  nextRound(): EngineEvent[] {
    this.events = [];
    if (this.state.status === "finished") return this.events;
    if (this.state.roundNo >= 4) {
      this.state.status = "finished";
      const ranking = [...this.round.players]
        .map((p) => ({ seat: p.seat, name: p.name, points: p.points }))
        .sort((a, b) => b.points - a.points);
      this.events.push({ type: "gameOver", ranking });
      return this.events;
    }
    this.state.roundNo = (this.state.roundNo + 1) as 1 | 2 | 3 | 4;
    this.startRound();
    return this.events;
  }

  // ─────────────────────────── 摸牌/事件基础设施 ───────────────────────────

  private drawInto(seat: Seat, rinshan: boolean): void {
    const r = this.round;
    const w = r.wall;
    const p = r.players[seat];
    let tile: Tile;
    if (rinshan) {
      if (this.rinshanRemain(w) <= 0) throw new Error("rinshan exhausted");
      tile = w.deadWall[w.rinshanIdx]!;
      w.rinshanIdx += 1;
    } else {
      if (this.liveRemain(w) <= 0) throw new Error("wall exhausted");
      tile = w.tiles[w.drawIdx]!;
      w.drawIdx += 1;
    }
    p.hand.push(tile);
    r.turn = seat;
    r.drawn = tile;
    r.drawnRinshan = rinshan;
    if (p.tempFuriten) p.tempFuriten = false;
    this.events.push({ type: "draw", seat, tile: notation(tile), rinshan });
  }

  private flipDora(): void {
    const r = this.round;
    const w = r.wall;
    if (w.doraRevealed >= 5) return;
    w.doraRevealed += 1;
    const indicator = w.deadWall[4 + w.doraRevealed - 1]!;
    this.events.push({ type: "doraFlipped", indicator: notation(indicator), doraRevealed: w.doraRevealed });
  }

  private clearIppatsuForAll(): void {
    for (const p of this.round.players) if (p.riichi) p.ippatsu = false;
  }

  private winCtx(
    p: PlayerState,
    winTile: Tile,
    tsumo: boolean,
    extra: { rinshan?: boolean; chankan?: boolean; haitei?: boolean; houtei?: boolean } = {},
  ): WinContext {
    const w = this.round.wall;
    return {
      concealed: tsumo ? p.hand : [...p.hand, winTile],
      melds: p.melds,
      kitaCount: p.kitaTiles.length,
      winTile,
      tsumo,
      riichi: p.riichi,
      ippatsu: p.ippatsu,
      seatWind: this.seatWind(p.seat),
      roundWind: "east",
      doraIndicators: w.deadWall.slice(4, 4 + w.doraRevealed),
      uraIndicators: p.riichi ? w.deadWall.slice(9, 9 + w.doraRevealed) : undefined,
      ...extra,
    };
  }

  // ─────────────────────────── 合法动作集 ───────────────────────────

  legalActions(seat: Seat): EngineAction[] {
    const r = this.state.round;
    if (!r || r.phase === "win" || r.phase === "draw") return [];
    if (r.phase === "turn") {
      if (seat !== r.turn) return [];
      return this.turnActions(seat);
    }
    const w = r.claim;
    if (!w || !w.candidates.includes(seat) || w.answers[seat] !== undefined) return [];
    return this.claimActions(seat, w.discardTile, w.pending !== undefined);
  }

  // eslint-disable-next-line complexity, max-statements, max-lines-per-function -- 合法动作集构建：打/立直候选/自摸/暗杠加杠/拔北/九种九牌逐条对应规则条目，拆为子构建器需在调用间反复传递窗口态与墙余量（同 referee actions.ts 规则表分派先例）
  private turnActions(seat: Seat): EngineAction[] {
    const r = this.round;
    const p = r.players[seat];
    const actions: EngineAction[] = [];
    const melds = p.melds;
    const wall = r.wall;
    const justCalled = r.justCalled?.seat === seat ? r.justCalled : undefined;

    // 打牌（食替过滤）；立直后仅允许摸切刚摸的那张（#1564-2）
    const drawnNotation = r.drawn ? notation(r.drawn) : undefined;
    const seen = new Set<string>();
    for (const t of p.hand) {
      const n = notation(t);
      if (seen.has(n)) continue;
      seen.add(n);
      if (p.riichi) {
        if (drawnNotation !== undefined && n === drawnNotation) actions.push({ type: "discard", tile: n });
        continue;
      }
      const chk = canDiscard({ concealed: p.hand, melds, justCalled, discard: t });
      if (chk.ok) actions.push({ type: "discard", tile: n });
    }

    // 立直候选（打出后听牌）
    if (isMenzen({ melds }) && !p.riichi) {
      const riichiSeen = new Set<string>();
      for (const t of p.hand) {
        const n = notation(t);
        if (riichiSeen.has(n)) continue;
        riichiSeen.add(n);
        const rest: Tile[] = [...p.hand];
        rest.splice(rest.indexOf(t), 1);
        const chk = canRiichi({
          menzen: true,
          points: p.points,
          remainingDraws: this.liveRemain(wall),
          alreadyRiichi: p.riichi,
          willBeTenpai: isTenpai({ concealed: rest, melds }),
        });
        if (chk.ok) actions.push({ type: "discard", tile: n, riichi: true });
      }
    }

    // 自摸（赢的是刚摸的那张）
    if (r.drawn) {
      const res = evaluateWin(
        this.winCtx(p, r.drawn, true, {
          rinshan: r.drawnRinshan,
          haitei: !r.drawnRinshan && this.liveRemain(wall) === 0,
        }),
      );
      if (res.valid) actions.push({ type: "tsumo" });
    }

    // 暗杠（雀魂口径：立直后仍可暗杠/加杠，枪杠风险自担——无「听牌不变」限制）
    const cnt = countsByKind(p.hand);
    for (let k = 0; k < 34; k++) {
      if (cnt[k] !== 4 || !isSanmaKind(k)) continue;
      const rep = p.hand.find((t) => tileKind(t) === k)!;
      const chk = canCall({
        request: { type: "ankan", tile: rep },
        concealed: p.hand,
        melds,
        turnWindow: true,
        remainingDraws: this.rinshanRemain(wall),
      });
      if (chk.ok) actions.push({ type: "ankan", kind: notation(rep) });
    }

    // 加杠
    for (const m of p.melds) {
      if (m.type !== "pon") continue;
      const k = tileKind(m.tiles[0]!);
      const added = p.hand.find((t) => tileKind(t) === k);
      if (!added) continue;
      const chk = canCall({
        request: { type: "kakan", tile: added },
        concealed: p.hand,
        melds,
        turnWindow: true,
        remainingDraws: this.rinshanRemain(wall),
      });
      if (chk.ok) actions.push({ type: "kakan", tile: notation(added) });
    }

    // 拔北（引擎口径：立直后不提供）
    if (!p.riichi && cnt[NORTH_KIND]! > 0) {
      const north = p.hand.find((t) => tileKind(t) === NORTH_KIND)!;
      const chk = canCall({
        request: { type: "kita", tile: north },
        concealed: p.hand,
        melds,
        turnWindow: true,
        remainingDraws: this.liveRemain(wall),
      });
      if (chk.ok) actions.push({ type: "kita" });
    }

    // 九种九牌（庄家首巡）
    if (
      seat === this.dealerSeat() &&
      r.firstDiscards.length === 0 &&
      r.firstDiscardsValid &&
      r.totalKans === 0 &&
      r.players.every((x) => x.melds.length === 0)
    ) {
      const det = detectAbortiveDraw({ dealerFirstDrawTiles: p.hand, totalKans: r.totalKans });
      if (det.kind === "nineTerminals") actions.push({ type: "ryuukyoku" });
    }
    return actions;
  }

  private claimActions(seat: Seat, tile: Tile, chankan: boolean): EngineAction[] {
    const r = this.round;
    const p = r.players[seat];
    const actions: EngineAction[] = [];
    if (isWinning([...p.hand, tile], p.melds, tileKind(tile), true)) {
      const waits13 = waits(p.hand, p.melds);
      const permanent = isFuriten({ winningKinds: waits13, ownDiscardKinds: p.discards.map(tileKind) });
      if (canRon({ permanentFuriten: permanent, tempFuriten: p.tempFuriten, tsumo: false })) {
        const res = evaluateWin(
          this.winCtx(p, tile, false, { chankan, houtei: !chankan && this.liveRemain(r.wall) === 0 }),
        );
        if (res.valid) actions.push({ type: "ron" });
      }
    }
    if (!chankan) {
      // 立直后不能副露（碰/大明杠）——只能荣和或过（#1564-2）
      if (
        !p.riichi &&
        canCall({ request: { type: "pon", called: tile }, concealed: p.hand, melds: p.melds, turnWindow: true }).ok
      ) {
        actions.push({ type: "pon" });
      }
      if (
        !p.riichi &&
        canCall({
          request: { type: "daiminkan", called: tile },
          concealed: p.hand,
          melds: p.melds,
          turnWindow: true,
          remainingDraws: this.rinshanRemain(r.wall),
        }).ok
      ) {
        actions.push({ type: "daiminkan" });
      }
    }
    actions.push({ type: "pass" });
    return actions;
  }

  /** 当前决策点（轮到谁、有哪些合法动作）；结算停驻时 null */
  decisionPoint(): DecisionPoint | null {
    const r = this.state.round;
    if (!r) return null;
    if (r.phase === "turn") {
      return {
        kind: "turn",
        seat: r.turn,
        actions: this.legalActions(r.turn),
        ...(r.drawn ? { drawn: notation(r.drawn) } : {}),
      };
    }
    if (r.phase === "claim") {
      const w = r.claim;
      if (!w) return null;
      for (const s of w.candidates) {
        if (w.answers[s] === undefined) {
          return {
            kind: "claim",
            seat: s,
            actions: this.legalActions(s),
            claim: { discardSeat: w.discardSeat, discardTile: notation(w.discardTile) },
          };
        }
      }
      return null;
    }
    return null;
  }

  // ─────────────────────────── apply 主入口 ───────────────────────────

  apply(seat: Seat, action: EngineAction): ApplyResult {
    this.events = [];
    const r = this.state.round;
    if (!r) throw new IllegalActionError("round not active");
    if (r.phase === "win" || r.phase === "draw") throw new IllegalActionError("round already settled");
    const legal = this.legalActions(seat);
    if (!legal.some((a) => sameAction(a, action))) {
      throw new IllegalActionError(`illegal action seat=${seat}: ${JSON.stringify(action)}`);
    }
    if (r.phase === "claim") {
      this.submitAnswer(seat, action);
      return { events: this.events };
    }
    switch (action.type) {
      case "discard":
        this.doDiscard(seat, action);
        break;
      case "tsumo":
        this.doTsumo(seat);
        break;
      case "ankan":
        this.executeAnkan(seat, action.kind);
        break;
      case "kakan":
        this.openClaimWindow(seat, parseTiles(action.tile)[0]!, {
          seat,
          action: { type: "kakan", tile: action.tile },
        });
        break;
      case "kita":
        this.doKita(seat);
        break;
      case "ryuukyoku":
        this.settleAbort("nineTerminals");
        break;
      default:
        throw new IllegalActionError(`action not allowed in turn phase: ${action.type}`);
    }
    return { events: this.events };
  }

  // ─────────────────────────── 打牌与副露窗口 ───────────────────────────

  // eslint-disable-next-line max-statements -- 打牌结算一线闭合：食替清理/立直供托/一发窗口/首打记录/开副露窗口共享同一轮内序，拆分会引入中间态
  private doDiscard(seat: Seat, action: Extract<EngineAction, { type: "discard" }>): void {
    const r = this.round;
    const p = r.players[seat];
    const idx = p.hand.findIndex((t) => notation(t) === action.tile);
    if (idx < 0) throw new IllegalActionError(`tile not in hand: ${action.tile}`);
    const tile = p.hand[idx]!;
    const tsumogiri = r.drawn === tile;
    p.hand.splice(idx, 1);
    p.discards.push(tile);
    r.drawn = undefined;
    r.drawnRinshan = false;

    const wasRiichi = p.riichi;
    let riichiDeclared = false;
    if (action.riichi && !wasRiichi) {
      p.riichi = true;
      p.ippatsu = true;
      p.riichiTurn = p.discards.length;
      p.points -= 1000;
      r.sticks += 1;
      riichiDeclared = true;
      this.events.push({ type: "riichiSticks", delta: 1, sticks: r.sticks });
    } else if (wasRiichi) {
      p.ippatsu = false;
    }
    if (r.justCalled?.seat === seat) r.justCalled = undefined;
    this.events.push({
      type: "discard",
      seat,
      tile: notation(tile),
      riichi: riichiDeclared,
      tsumogiri,
    });
    r.lastDiscardSeat = seat;
    r.seq += 1;
    if (r.firstDiscardsValid && r.firstDiscards.length < 3) r.firstDiscards.push(tile);

    this.openClaimWindow(seat, tile, undefined);
  }

  private openClaimWindow(
    discardSeat: Seat,
    tile: Tile,
    pending: ClaimWindow["pending"],
  ): void {
    const r = this.round;
    const chankan = pending !== undefined;
    const candidates: Seat[] = [];
    for (let off = 1; off <= 2; off++) {
      const s = ((discardSeat + off) % 3) as Seat;
      const acts = this.claimActions(s, tile, chankan);
      if (acts.some((a) => a.type !== "pass")) candidates.push(s);
    }
    if (candidates.length === 0) {
      if (pending) {
        this.executeKakan(pending.seat, pending.action);
      } else {
        this.postDiscardFlow(discardSeat);
      }
      return;
    }
    r.phase = "claim";
    r.claim = { discardSeat, discardTile: tile, candidates, answers: {}, ...(pending ? { pending } : {}) };
  }

  private submitAnswer(seat: Seat, action: EngineAction): void {
    const r = this.round;
    const w = r.claim;
    if (!w) throw new IllegalActionError("no claim window");
    w.answers[seat] = action;
    if (w.candidates.every((s) => w.answers[s] !== undefined)) this.resolveClaim();
  }

  private resolveClaim(): void {
    const r = this.round;
    const w = r.claim;
    if (!w) return;
    const answers = w.candidates.map((s) => ({ seat: s, act: w.answers[s]! }));
    const ronners = answers.filter((x) => x.act.type === "ron").map((x) => x.seat);
    if (ronners.length > 0) {
      r.claim = undefined;
      this.doRonWin(w, ronners, w.pending !== undefined);
      return;
    }
    if (w.pending) {
      const pending = w.pending;
      r.claim = undefined;
      this.executeKakan(pending.seat, pending.action);
      return;
    }
    const caller = answers.find((x) => x.act.type === "pon" || x.act.type === "daiminkan");
    r.claim = undefined;
    if (caller && caller.act.type === "pon") {
      this.executePon(caller.seat, w);
    } else if (caller && caller.act.type === "daiminkan") {
      this.executeDaiminkan(caller.seat, w);
    } else {
      this.postDiscardFlow(w.discardSeat);
    }
  }

  private removeKind(hand: Tile[], k: number, n: number): Tile[] {
    const take: Tile[] = [];
    for (const t of hand) {
      if (take.length >= n) break;
      if (tileKind(t) === k) take.push(t);
    }
    for (const t of take) hand.splice(hand.indexOf(t), 1);
    return take;
  }

  private recordBao(map: Partial<Record<string, { seat: Seat; seq: number }>>, kind: number, seat: Seat): void {
    if (!DRAGON_KINDS.has(kind) && !WIND_KINDS.has(kind)) return;
    map[String(kind)] = { seat, seq: this.round.seq };
  }

  private executePon(seat: Seat, w: ClaimWindow): void {
    const r = this.round;
    const p = r.players[seat];
    const called = w.discardTile;
    const k = tileKind(called);
    const take = this.removeKind(p.hand, k, 2);
    const meld: Meld = { type: "pon", tiles: [called, ...take], from: relSource(w.discardSeat, seat) };
    p.melds.push(meld);
    this.recordBao(r.baoDragon, k, w.discardSeat);
    this.clearIppatsuForAll();
    r.firstDiscardsValid = false;
    r.justCalled = { seat, type: "pon", called };
    r.turn = seat;
    r.drawn = undefined;
    r.drawnRinshan = false;
    r.phase = "turn";
    r.seq += 1;
    this.events.push({
      type: "call",
      seat,
      meld: { type: "pon", tiles: meld.tiles.map(notation), ...(meld.from ? { from: meld.from } : {}) },
    });
  }

  private afterKan(): void {
    const r = this.round;
    this.clearIppatsuForAll();
    r.firstDiscardsValid = false;
    r.totalKans += 1;
    if (r.totalKans >= 4) r.fourthKanResolved = false;
  }

  private executeDaiminkan(seat: Seat, w: ClaimWindow): void {
    const r = this.round;
    const p = r.players[seat];
    const called = w.discardTile;
    const k = tileKind(called);
    const take = this.removeKind(p.hand, k, 3);
    const meld: Meld = { type: "daiminkan", tiles: [called, ...take], from: relSource(w.discardSeat, seat) };
    p.melds.push(meld);
    this.recordBao(r.baoDragon, k, w.discardSeat);
    this.afterKan();
    r.justCalled = { seat, type: "daiminkan", called };
    r.turn = seat;
    r.phase = "turn";
    r.seq += 1;
    this.events.push({
      type: "call",
      seat,
      meld: { type: "daiminkan", tiles: meld.tiles.map(notation), ...(meld.from ? { from: meld.from } : {}) },
    });
    this.flipDora();
    this.drawInto(seat, true);
  }

  private executeAnkan(seat: Seat, kindNotation: string): void {
    const r = this.round;
    const p = r.players[seat];
    const k = tileKind(parseTiles(kindNotation)[0]!);
    const take = this.removeKind(p.hand, k, 4);
    if (take.length < 4) throw new IllegalActionError(`ankan tiles missing: ${kindNotation}`);
    const meld: Meld = { type: "ankan", tiles: take };
    p.melds.push(meld);
    this.afterKan();
    r.justCalled = { seat, type: "ankan" };
    r.turn = seat;
    r.phase = "turn";
    r.seq += 1;
    this.events.push({ type: "call", seat, meld: { type: "ankan", tiles: meld.tiles.map(notation) } });
    this.flipDora();
    this.drawInto(seat, true);
  }

  private executeKakan(seat: Seat, action: EngineAction): void {
    if (action.type !== "kakan") throw new IllegalActionError("pending action must be kakan");
    const r = this.round;
    const p = r.players[seat];
    const k = tileKind(parseTiles(action.tile)[0]!);
    const added = p.hand.find((t) => notation(t) === action.tile);
    if (!added) throw new IllegalActionError(`kakan tile not in hand: ${action.tile}`);
    p.hand.splice(p.hand.indexOf(added), 1);
    const mi = p.melds.findIndex((m) => m.type === "pon" && tileKind(m.tiles[0]!) === k);
    if (mi < 0) throw new IllegalActionError("kakan without matching pon");
    const old = p.melds[mi]!;
    const meld: Meld = { type: "kakan", tiles: [...old.tiles, added], ...(old.from ? { from: old.from } : {}) };
    p.melds[mi] = meld;
    this.afterKan();
    r.justCalled = { seat, type: "kakan", tile: added };
    r.turn = seat;
    r.phase = "turn";
    r.seq += 1;
    this.events.push({ type: "call", seat, meld: { type: "kakan", tiles: meld.tiles.map(notation) } });
    this.flipDora();
    this.drawInto(seat, true);
  }

  private doKita(seat: Seat): void {
    const r = this.round;
    const p = r.players[seat];
    const idx = p.hand.findIndex((t) => tileKind(t) === NORTH_KIND);
    if (idx < 0) throw new IllegalActionError("no north in hand");
    const north = p.hand[idx]!;
    p.hand.splice(idx, 1);
    p.kitaTiles.push(north);
    r.firstDiscardsValid = false;
    if (this.liveRemain(r.wall) <= 0) throw new IllegalActionError("wall empty for kita replacement");
    const rep = r.wall.tiles[r.wall.drawIdx]!;
    r.wall.drawIdx += 1;
    p.hand.push(rep);
    r.turn = seat;
    r.drawn = rep;
    r.drawnRinshan = false;
    r.seq += 1;
    this.events.push({ type: "kita", seat, tile: notation(north), replaced: notation(rep) });
  }

  // ─────────────────────────── 打后流转：流局条款 + 下一巡 ───────────────────────────

  private postDiscardFlow(discardSeat: Seat): void {
    const r = this.round;
    if (r.totalKans >= 4) r.fourthKanResolved = true;
    const det = detectAbortiveDraw({
      firstDiscards: r.firstDiscardsValid ? r.firstDiscards : undefined,
      firstDiscardsComplete: r.firstDiscardsValid && r.firstDiscards.length === 3,
      totalKans: r.totalKans,
      fourthKanResolved: r.fourthKanResolved,
    });
    if (det.kind === "threeWinds" || det.kind === "fourKans") {
      this.settleAbort(det.kind);
      return;
    }
    const next = ((discardSeat + 1) % 3) as Seat;
    if (this.liveRemain(r.wall) === 0) {
      this.settleNoten();
      return;
    }
    this.drawInto(next, false);
    r.phase = "turn";
  }

  // ─────────────────────────── 结算 ───────────────────────────

  private basePoints(res: WinResult): ReturnType<typeof pointsFromHanFu> {
    return res.points ?? pointsFromHanFu(res.totalHan, res.fu ?? 40);
  }

  private doTsumo(seat: Seat): void {
    const r = this.round;
    const p = r.players[seat];
    const res = evaluateWin(
      this.winCtx(p, r.drawn!, true, {
        rinshan: r.drawnRinshan,
        haitei: !r.drawnRinshan && this.liveRemain(r.wall) === 0,
      }),
    );
    if (!res.valid) throw new IllegalActionError(`tsumo invalid: ${res.reason}`);
    const pts = this.basePoints(res);
    const each = seat === this.dealerSeat() ? pts.tsumoParentEachSanma : pts.tsumoEachSanma;
    const honbaEach = HONBA_TSUMO * r.honba;
    const deltas = [0, 0, 0];
    let gain = 0;
    for (let s = 0; s < 3; s++) {
      if (s === seat) continue;
      const pay = each + honbaEach;
      deltas[s] = -pay;
      gain += pay;
    }
    const prevSticks = r.sticks;
    gain += prevSticks * 1000;
    r.sticks = 0;
    deltas[seat] = gain;
    if (prevSticks > 0) this.events.push({ type: "riichiSticks", delta: -prevSticks, sticks: 0 });
    const settlement: Settlement = {
      kind: "tsumo",
      deltas,
      winners: [seat],
      yakuSummary: [
        {
          seat,
          han: res.totalHan,
          ...(res.fu !== undefined ? { fu: res.fu } : {}),
          yakus: res.yakus.map((y) => y.id),
          points: each,
        },
      ],
      riichiSticksToWinner: prevSticks,
    };
    this.events.push({ type: "win", settlement });
    this.finishRound(settlement, "win");
  }

  private baoSeatFor(res: WinResult): Seat | undefined {
    const r = this.round;
    const pat = res.pattern;
    if (!pat || pat.kind !== "regular") return undefined;
    const trips = pat.blocks.filter((b) => b.type === "set" && b.kindOfSet === "triplet");
    const hasDaisangen = res.yakus.some((y) => y.id === "daisangen");
    const hasDaisuushii = res.yakus.some((y) => y.id === "daisuushii");
    const pick = (kinds: number[], map: Partial<Record<string, { seat: Seat; seq: number }>>): Seat | undefined => {
      const recs = kinds.map((k) => map[String(k)]);
      if (recs.some((x) => x === undefined)) return undefined;
      let best: { seat: Seat; seq: number } | undefined;
      for (const x of recs) if (!best || x!.seq > best.seq) best = x!;
      return best?.seat;
    };
    const tripKinds = trips.map((b) => b.kind);
    if (hasDaisangen) {
      const dragons = [31, 32, 33];
      if (!dragons.every((k) => tripKinds.includes(k))) return undefined;
      return pick(dragons, r.baoDragon);
    }
    if (hasDaisuushii) {
      const winds = [27, 28, 29, 30];
      if (!winds.every((k) => tripKinds.includes(k))) return undefined;
      return pick(winds, r.baoWind);
    }
    return undefined;
  }

  // eslint-disable-next-line complexity -- 逐赢家结算 + 包牌分派 + 双响供托拆分：赢家循环与包牌判定共用同一份 deltas 与供托池，拆分需在函数间传递逐赢家中间态
  private doRonWin(w: ClaimWindow, winners: Seat[], chankan: boolean): void {
    const r = this.round;
    const prevSticks = r.sticks;
    const n = winners.length;
    const stickShare = Math.floor((prevSticks * 1000) / n);
    r.sticks = 0;
    const deltas = [0, 0, 0];
    const summary: NonNullable<Settlement["yakuSummary"]> = [];
    let baoSeat: Seat | undefined;
    for (const s of winners) {
      const p = r.players[s];
      const res = evaluateWin(
        this.winCtx(p, w.discardTile, false, {
          chankan,
          houtei: !chankan && this.liveRemain(r.wall) === 0,
        }),
      );
      if (!res.valid) throw new IllegalActionError(`ron invalid seat=${s}: ${res.reason}`);
      const pts = this.basePoints(res);
      const amount = s === this.dealerSeat() ? pts.ronParent : pts.ron;
      const pay = amount + HONBA_RON * r.honba;
      const bao = chankan ? undefined : this.baoSeatFor(res);
      const payer = bao !== undefined && bao !== s ? bao : w.discardSeat;
      if (bao !== undefined) baoSeat = bao;
      deltas[s] = (deltas[s] ?? 0) + pay + stickShare;
      deltas[payer] = (deltas[payer] ?? 0) - pay;
      summary.push({
        seat: s,
        han: res.totalHan,
        ...(res.fu !== undefined ? { fu: res.fu } : {}),
        yakus: res.yakus.map((y) => y.id),
        points: amount,
      });
    }
    if (prevSticks > 0) this.events.push({ type: "riichiSticks", delta: -prevSticks, sticks: 0 });
    const settlement: Settlement = {
      kind: "ron",
      deltas,
      winners,
      payer: w.discardSeat,
      ...(baoSeat !== undefined ? { baoSeat } : {}),
      yakuSummary: summary,
      riichiSticksToWinner: prevSticks,
    };
    this.events.push({ type: "win", settlement });
    this.finishRound(settlement, "win");
  }

  private settleNoten(): void {
    const r = this.round;
    const tenpai = r.players.map((p) => isTenpai({ concealed: p.hand, melds: p.melds }));
    const s = notenSettlement({ tenpai });
    const settlement: Settlement = { kind: "noten", deltas: [...s.deltas], tenpai };
    this.events.push({ type: "drawEnd", settlement });
    this.finishRound(settlement, "draw");
  }

  private settleAbort(kind: "threeWinds" | "fourKans" | "nineTerminals"): void {
    const settlement: Settlement = { kind: "abortive", abortive: kind, deltas: [0, 0, 0] };
    this.events.push({ type: "abortive", settlement });
    this.finishRound(settlement, "draw");
  }

  private finishRound(settlement: Settlement, phase: "win" | "draw"): void {
    const r = this.round;
    settlement.deltas.forEach((d, i) => {
      r.players[i]!.points += d;
    });
    r.settlement = settlement;
    r.phase = phase;
    if (phase === "win") {
      this.state.honba = 0;
      r.sticks = 0;
    } else {
      this.state.honba = r.honba + 1;
    }
    this.state.sticks = r.sticks;
  }
}
