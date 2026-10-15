/**
 * 振听三变体（雀魂三麻口径）：
 * 1. 舍张振听：自己河里有任一听牌张 → 持续性振听（自摸不受限）
 * 2. 立直后同巡振听：立直后本巡内错过和牌（或听牌张被他人打出未和）→ 至自己下次摸牌前
 * 3. 头跳（atamahane）三麻不适用——双响成立，多家和时各家全额由放铳者支付
 */

export interface FuritenInput {
  /** 听牌种类（waits() 输出） */
  readonly winningKinds: readonly number[];
  /** 自己的舍牌（种类） */
  readonly ownDiscardKinds: readonly number[];
}

/** 舍张振听（永久，直到听牌形改变） */
export function isFuriten(input: FuritenInput): boolean {
  return input.winningKinds.some((k) => input.ownDiscardKinds.includes(k));
}

export interface TempFuritenInput {
  readonly riichi: boolean;
  /** 立直后、自己下次摸牌前：错过和牌（能和未和） */
  readonly passedRon?: boolean;
  /** 立直后、自己下次摸牌前：别人打出的自己的听牌张（未和时） */
  readonly waitsDiscardedByOthersSinceDraw?: readonly number[];
  /** 自己刚摸牌（清除同巡标记） */
  readonly justDrew?: boolean;
}

/** 立直后同巡振听（临时，至自己下次摸牌） */
export function hasTempFuriten(input: TempFuritenInput): boolean {
  if (input.justDrew) return false;
  if (!input.riichi) return false;
  if (input.passedRon) return true;
  return (input.waitsDiscardedByOthersSinceDraw ?? []).length > 0;
}

export interface RonCheckInput {
  readonly permanentFuriten: boolean;
  readonly tempFuriten: boolean;
  /** 自摸和牌（振听下仍可自摸） */
  readonly tsumo: boolean;
}

/** 荣和资格（振听裁决）：振听仅封荣和，自摸恒可。 */
export function canRon(input: RonCheckInput): boolean {
  if (input.tsumo) return true;
  return !input.permanentFuriten && !input.tempFuriten;
}

export interface MultiRonWinner {
  readonly name: string;
  readonly furiten: boolean;
}

export interface MultiRonOutcome {
  /** 三麻双响成立：所有非振听者皆可和（无头跳） */
  readonly winners: string[];
  /** 放铳者对每位赢家的支付（各自全额） */
  readonly payments: { winner: string; points: number }[];
}

/** 双响/多响分配：无头跳，放铳者对每家全额支付。points 由 win 层算出。 */
export function multiRon(
  winners: readonly MultiRonWinner[],
  pointsFor: (winner: MultiRonWinner) => number,
): MultiRonOutcome {
  const eligible = winners.filter((w) => !w.furiten);
  return {
    winners: eligible.map((w) => w.name),
    payments: eligible.map((w) => ({ winner: w.name, points: pointsFor(w) })),
  };
}
