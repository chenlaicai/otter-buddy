/**
 * Referee 三麻裁判引擎——纯函数、无 IO、无副作用。
 * 规则口径：雀魂三麻（108 张/无吃/拔北宝牌/自摸损/双响无头跳）。
 */

export { shanten, regularShanten, chiitoiShanten, kokushiShanten, type ShantenResult } from "./shanten";
export {
  decompose,
  decomposeRegular,
  decomposeChiitoi,
  decomposeKokushi,
  waits,
  isWinning,
  meldToBlocks,
  type Pattern,
  type Block,
  type SetBlock,
  type PairBlock,
  type WaitType,
  type SetForm,
} from "./decompose";
export { calcFu, type FuContext } from "./fu";
export {
  detectYaku,
  COMMON_HAN,
  YAKUMAN_MULT,
  type YakuId,
  type CommonYakuId,
  type YakumanYakuId,
  type YakuHit,
  type YakuContext,
} from "./yaku";
export { pointsFromHanFu, yakumanPoints, type PointBreakdown, type ScoreLevel, type ScoreOptions } from "./points";
export { countDora, type DoraInput, type DoraCount } from "./dora";
export { evaluateWin, type WinContext, type WinResult } from "./win";
export {
  isFuriten,
  hasTempFuriten,
  canRon,
  multiRon,
  type FuritenInput,
  type TempFuritenInput,
  type RonCheckInput,
  type MultiRonWinner,
  type MultiRonOutcome,
} from "./furiten";
export {
  canRiichi,
  canDiscard,
  canCall,
  isTenpai,
  type Legality,
  type RiichiInput,
  type DiscardInput,
  type CallInput,
  type TenpaiInput,
} from "./actions";
export {
  detectAbortiveDraw,
  notenSettlement,
  type AbortiveDrawKind,
  type AbortiveDrawInput,
  type AbortiveDrawResult,
  type NotenSettlementInput,
  type NotenSettlement,
} from "./ryuukyoku";
