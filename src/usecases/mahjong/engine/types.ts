/**
 * SanmaEngine 状态机类型——三麻牌局（东风战）单帧完整快照模型。
 * 阶段：turn（当前家已摸牌待打）/ claim（副露窗口）/ win / draw（结算停驻）/ gameover。
 */

import type { Tile } from "@entities/mahjong/tile";
import type { Meld } from "@entities/mahjong/meld";
import type { AbortiveDrawKind } from "../referee/ryuukyoku";

export type Seat = 0 | 1 | 2;

/** 玩家来源（节流阀按此+决策点类型决定是否唤醒 LLM） */
export type PlayerKind = "human" | "otter" | "proxy";

export interface PlayerConfig {
  readonly kind: PlayerKind;
  readonly name: string;
  /** kind=otter 时必填：SDK 直调目标 */
  readonly otterId?: string;
}

/** 引擎动作（玩家侧）——tile 用记谱单张（'5p'/'0p'=赤五）；ankan 的 kind 为种类记谱（'5p' 不带赤义） */
export type EngineAction =
  | { type: "discard"; tile: string; riichi?: boolean }
  | { type: "tsumo" }
  | { type: "ron" }
  | { type: "pass" }
  | { type: "pon" }
  | { type: "daiminkan" }
  | { type: "ankan"; kind: string }
  | { type: "kakan"; tile: string }
  | { type: "kita" }
  | { type: "ryuukyoku" };

export interface PlayerState {
  readonly seat: Seat;
  readonly kind: PlayerKind;
  readonly name: string;
  readonly otterId?: string;
  points: number;
  hand: Tile[];
  melds: Meld[];
  /** 本局拔北（牌张明示 + 计数） */
  kitaTiles: Tile[];
  discards: Tile[];
  /** 立直棒已供托（本局） */
  riichi: boolean;
  /** 立直后一发有效（任何鸣牌/自己下一轮打牌时清除） */
  ippatsu: boolean;
  /** 同巡振听（立直后错过和牌；自己下次摸牌清除） */
  tempFuriten: boolean;
  /** 立直轮次（供展示/结算，-1=未立直） */
  riichiTurn: number;
}

export interface WallState {
  /** 活山：洗好的 108 张去掉王牌 14 张（94 张；配牌 39 后剩 55 摸） */
  tiles: Tile[];
  /** 下一张摸牌位置 */
  drawIdx: number;
  /** 王牌 14 张（[0..3]=岭上、[4..8]=宝牌指示（[4] 初始）、[9..13]=里宝牌指示——固定布局） */
  deadWall: Tile[];
  /** 岭上取牌位置（杠用） */
  rinshanIdx: number;
  /** 已翻开的表宝牌指示牌数（初始 1） */
  doraRevealed: number;
}

export interface ClaimWindow {
  /** 被打的牌与打出者 */
  readonly discardSeat: Seat;
  readonly discardTile: Tile;
  /** 有资格应答的家（按 seat 序），已按资格生成 */
  readonly candidates: Seat[];
  /** 各家已提交的回答（未提交 = 待问） */
  readonly answers: Partial<Record<Seat, EngineAction>>;
  /** 窗口由加杠发起（枪杠调查）：全员过后执行的动作 */
  readonly pending?: { seat: Seat; action: EngineAction };
}

export interface Settlement {
  readonly kind: "tsumo" | "ron" | "noten" | "abortive";
  /** abortive 的具体条款 */
  readonly abortive?: AbortiveDrawKind;
  /** 各家点数增减（已含本场/供托归属前的裸值；供托转移由 engine 记入 deltas） */
  readonly deltas: readonly number[];
  readonly winners?: Seat[];
  readonly payer?: Seat;
  /** 包牌者（大三元/大四喜 ron 时替代放铳者付点） */
  readonly baoSeat?: Seat;
  readonly yakuSummary?: { seat: Seat; han: number; fu?: number; yakus: string[]; points: number }[];
  readonly riichiSticksToWinner?: number;
  /** 流局时三家听牌与否（仅 noten） */
  readonly tenpai?: readonly boolean[];
}

export interface RoundState {
  readonly roundWind: "east";
  readonly roundNo: 1 | 2 | 3 | 4;
  honba: number;
  sticks: number;
  wall: WallState;
  players: [PlayerState, PlayerState, PlayerState];
  phase: "turn" | "claim" | "win" | "draw";
  /** 当前行动家（phase=turn 时有效——已摸牌、待打） */
  turn: Seat;
  /** 本回合刚摸的牌（tsumogiri 参考；副露后的回合无） */
  drawn?: Tile;
  /** 刚摸的牌是否岭上（宝牌杠后） */
  drawnRinshan: boolean;
  /** 副露窗口（phase=claim 时有效） */
  claim?: ClaimWindow;
  /** 本局前 3 打（三风连打判定；一旦有人副露即失效） */
  firstDiscards: Tile[];
  firstDiscardsValid: boolean;
  /** 全场杠数（不含拔北） */
  totalKans: number;
  /** 第 4 杠已解决（无岭上和了）→ 四杠散了 */
  fourthKanResolved: boolean;
  /** 刚完成的副露（食替约束至该家下次打牌） */
  justCalled?: { seat: Seat; type: "pon" | "daiminkan" | "kakan" | "ankan" | "kita"; called?: Tile; tile?: Tile };
  /** 吃/碰/杠鸣牌来源（碰明杠用） */
  lastDiscardSeat?: Seat;
  settlement?: Settlement;
  /** 包牌追踪：各字牌刻子由「打出者」完成时记录 {seat, seq}（大三元/大四喜包牌判定） */
  baoDragon: Partial<Record<string, { seat: Seat; seq: number }>>;
  baoWind: Partial<Record<string, { seat: Seat; seq: number }>>;
  /** 事件序号（包牌先后 / 帧内事件排序用） */
  seq: number;
}

export interface GameConfig {
  readonly seed: string;
  readonly startPoints: number;
  readonly players: readonly [PlayerConfig, PlayerConfig, PlayerConfig];
}

export interface GameState {
  readonly config: GameConfig;
  /** F20261022mjls：waiting = lobby 等待态（房建好、座位配置就绪、未发牌——构造后未 startRound 前） */
  status: "waiting" | "playing" | "finished";
  /** 当前局号（1-4 东风战；跨局继承） */
  roundNo: 1 | 2 | 3 | 4;
  honba: number;
  sticks: number;
  round?: RoundState;
}

/** 事件（apply 的输出；不入状态机本体——落帧走 frames 层） */
export type EngineEvent =
  | { type: "deal"; roundNo: number }
  | { type: "draw"; seat: Seat; tile: string; rinshan: boolean }
  | { type: "discard"; seat: Seat; tile: string; riichi: boolean; tsumogiri: boolean }
  | { type: "call"; seat: Seat; meld: { type: string; tiles: string[]; from?: string } }
  | { type: "kita"; seat: Seat; tile: string; replaced: string }
  | { type: "doraFlipped"; indicator: string; doraRevealed: number }
  | { type: "riichiSticks"; delta: number; sticks: number }
  | { type: "win"; settlement: Settlement }
  | { type: "drawEnd"; settlement: Settlement }
  | { type: "abortive"; settlement: Settlement }
  | { type: "gameOver"; ranking: { seat: Seat; name: string; points: number }[] };

export interface DecisionPoint {
  readonly kind: "turn" | "claim";
  readonly seat: Seat;
  readonly actions: readonly EngineAction[];
  /** phase=turn：刚摸的牌（记谱）；副露后无 */
  readonly drawn?: string;
  /** phase=claim：被鸣的牌与打出者 */
  readonly claim?: { discardSeat: Seat; discardTile: string };
}

/** apply 结果 */
export interface ApplyResult {
  readonly events: readonly EngineEvent[];
  /** 动作合法被拒时抛错；此处保证成功路径 */
}
