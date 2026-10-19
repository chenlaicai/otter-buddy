/**
 * 动作合法性：
 * - 立直条件：门清 / 点数 ≥1000 / 余牌 ≥5（雀魂：余牌 4 枚以下不可立直）
 * - 食替禁止（碰/杠后）：① 与所鸣之牌同种 ② 听牌形不变的替换打
 * - 副露：碰/明杠/暗杠/加杠/拔北；**吃在三麻恒非法**
 */

import { countsByKind, tileKind, type Tile } from "../../../entities/mahjong/tile";
import { type CallRequest, type Meld } from "../../../entities/mahjong/meld";
import { waits } from "./decompose";
import type { ShantenResult } from "./shanten";
import { shanten } from "./shanten";

export interface Legality {
  readonly ok: boolean;
  readonly reason?:
    | "NOT_MENZEN"
    | "LOW_POINTS"
    | "FEW_WALL_TILES"
    | "ALREADY_RIICHI"
    | "NO_TILE"
    | "KUIKAE_SAME_TILE"
    | "KUIKAE_SAME_WAIT"
    | "NO_CHI_IN_SANMA"
    | "NOT_YOUR_TURN_STATE"
    | "WALL_EMPTY";
}

const OK: Legality = { ok: true };
const fail = (reason: Legality["reason"]): Legality => ({ ok: false, reason });

export interface RiichiInput {
  readonly menzen: boolean;
  /** 现有点数 */
  readonly points: number;
  /** 牌山剩余可摸枚数（不含王牌） */
  readonly remainingDraws: number;
  readonly alreadyRiichi?: boolean;
  /** 打出后是否听牌（立直必须打出后听牌） */
  readonly willBeTenpai: boolean;
}

export function canRiichi(input: RiichiInput): Legality {
  if (input.alreadyRiichi) return fail("ALREADY_RIICHI");
  if (!input.menzen) return fail("NOT_MENZEN");
  if (input.points < 1000) return fail("LOW_POINTS");
  if (input.remainingDraws < 5) return fail("FEW_WALL_TILES");
  if (!input.willBeTenpai) return fail("NO_TILE");
  return OK;
}

export interface DiscardInput {
  readonly concealed: readonly Tile[];
  readonly melds: readonly Meld[];
  /** 刚才完成的鸣牌（碰/明杠）；null = 无（无食替约束的普通打） */
  readonly justCalled?: { type: "pon" | "daiminkan" | "kakan" | "ankan" | "kita"; called?: Tile; tile?: Tile };
  readonly discard: Tile;
}

/**
 * 打牌合法性（食替）。仅鸣牌后受约束：
 * ① 不得打与被鸣牌/手内目标牌同种（碰/明杠/加杠）
 * ② 碰后：不得打使听牌形与鸣牌前完全相同的牌（明杠因岭上张不可定位不适用②）
 */
// eslint-disable-next-line complexity -- 食替双规则（同种禁令 × 碰后听形对比）分支由规则条目决定，拆分会割裂与法规对读
export function canDiscard(input: DiscardInput): Legality {
  const call = input.justCalled;
  if (!call) return OK;

  const calledKind =
    call.type === "pon" || call.type === "daiminkan" || call.type === "kakan"
      ? call.called
        ? tileKind(call.called)
        : call.tile
          ? tileKind(call.tile)
          : -1
      : -1;
  const discardKind = tileKind(input.discard);

  if (calledKind >= 0 && discardKind === calledKind) return fail("KUIKAE_SAME_TILE");

  // ② 听牌形对比（仅碰）：鸣前 13 张 = 当前门清（含待打张）+ 新碰面子中手内的两张
  if (call.type === "pon" && call.called) {
    const calledTile = call.called;
    const newPon = [...input.melds].reverse().find(
      (m) => m.type === "pon" && tileKind(m.tiles[0]) === tileKind(calledTile),
    );
    if (newPon) {
      const inHand = newPon.tiles.filter((t) => !(t.suit === calledTile.suit && t.rank === calledTile.rank && t.aka === calledTile.aka));
      const preMelds = input.melds.filter((m) => m !== newPon);
      const pre = [...input.concealed, ...inHand];
      const post = input.concealed.filter(
        (t) => !(t.suit === input.discard.suit && t.rank === input.discard.rank && t.aka === input.discard.aka),
      );
      const preWaits = waitKindSet(pre, preMelds);
      const postWaits = waitKindSet(post, input.melds);
      if (preWaits.size > 0 && setsEqual(preWaits, postWaits)) return fail("KUIKAE_SAME_WAIT");
    }
  }
  return OK;
}

function waitKindSet(concealed: readonly Tile[], melds: readonly Meld[]): Set<number> {
  const meldN = melds.filter((m) => m.type !== "kita").length;
  if (concealed.length !== 13 - 3 * meldN) return new Set();
  try {
    return new Set(waits(concealed, melds));
  } catch {
    return new Set();
  }
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export interface CallInput {
  readonly request: CallRequest;
  readonly concealed: readonly Tile[];
  readonly melds: readonly Meld[];
  /** 该动作是否轮到自己（碰/杠为副露窗口、暗杠/拔北为自身回合） */
  readonly turnWindow: boolean;
  readonly menzenKept?: boolean;
  /** 剩余可摸张数（拔北需牌山有牌可补） */
  readonly remainingDraws?: number;
}

/** 副露合法性（三麻：无吃） */
// eslint-disable-next-line complexity -- 副露 6 类型 × 手牌条件的规则表分派（三麻无吃），逐分支即法规条目
export function canCall(input: CallInput): Legality {
  const { request, concealed, melds } = input;
  if (!input.turnWindow) return fail("NOT_YOUR_TURN_STATE");
  const counts = countsByKind(concealed);

  switch (request.type) {
    case "chi":
      return fail("NO_CHI_IN_SANMA");
    case "pon": {
      if (!request.called) return fail("NO_TILE");
      const k = tileKind(request.called);
      if (counts[k] < 2) return fail("NO_TILE");
      return OK;
    }
    case "daiminkan": {
      if (!request.called) return fail("NO_TILE");
      const k = tileKind(request.called);
      if (counts[k] < 3) return fail("NO_TILE");
      return OK;
    }
    case "ankan": {
      if (!request.tile) return fail("NO_TILE");
      const k = tileKind(request.tile);
      if (counts[k] < 4) return fail("NO_TILE");
      return OK;
    }
    case "kakan": {
      if (!request.tile) return fail("NO_TILE");
      const k = tileKind(request.tile);
      if (counts[k] < 1) return fail("NO_TILE");
      const hasPon = melds.some((m) => m.type === "pon" && tileKind(m.tiles[0]) === k);
      if (!hasPon) return fail("NO_TILE");
      // 加杠被抢杠 → 由和牌层处理；此处仅结构合法性
      return OK;
    }
    case "kita": {
      if (counts[30] < 1) return fail("NO_TILE"); // 北 = z4 = kind 30
      if (input.remainingDraws !== undefined && input.remainingDraws <= 0) return fail("WALL_EMPTY");
      return OK;
    }
  }
}

export interface TenpaiInput {
  readonly concealed: readonly Tile[];
  readonly melds: readonly Meld[];
}

/** 听牌判定（流局/立直用）：13 张等价手 */
export function isTenpai(input: TenpaiInput): boolean {
  const s: ShantenResult = shanten(input.concealed, input.melds.filter((m) => m.type !== "kita").length);
  return s.min === 0;
}
