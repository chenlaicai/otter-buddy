/**
 * 点数计算——口径与 mahjong-utils PointByHanHu 一致（已源码核实，与标准早见表逐值吻合）：
 *   基本点 a = 符 × 2^(2+番)，a > 2000 截 2000（满贯）；
 *   番阶：5→满贯 6-7→跳满 8-10→倍满 11-12→三倍满 13+→累计役满；
 *   子荣 = ceil100(4a)，亲荣 = ceil100(6a)；
 *   子自摸 4p：子各 ceil100(a)、亲 ceil100(2a)；亲自摸：子各 ceil100(2a)。
 *
 * 三麻分布（方案口径「自摸按（子家点+庄家点）/2 收两家」= 3a/2 每家）：
 *   子自摸：两家各 ceil100(1.5a)（总 3a，低于荣和 → 自摸损）；
 *   亲自摸：子家各 ceil100(2a)（同 4p 每家口径）。
 */

export type ScoreLevel =
  | "normal"
  | "mangan"
  | "haneman"
  | "baiman"
  | "sanbaiman"
  | "yakuman";

export interface ScoreOptions {
  /** 切上满贯（4 翻 30 符 → 滀貫）；雀魂默认关 */
  readonly kiriageMangan?: boolean;
  /** 累计役满（13 番+ 按役满计）；雀魂开 */
  readonly kazoeYakuman?: boolean;
}

export interface PointBreakdown {
  /** 基本点 a（已按番阶/满贯截断） */
  readonly base: number;
  readonly level: ScoreLevel;
  /** 子荣和点（isDealer=false 时的有效值；否则同 ron） */
  readonly ron: number;
  /** 亲荣和点 */
  readonly ronParent: number;
  /** 三麻 子自摸：每家支付 */
  readonly tsumoEachSanma: number;
  /** 三麻 亲自摸：每家（子家）支付 */
  readonly tsumoParentEachSanma: number;
  /** 4p 参照：子自摸 子家/亲家支付 */
  readonly tsumoChildPays: number;
  readonly tsumoParentPays: number;
  /** 役满倍数（非役满为 0） */
  readonly yakumanCount: number;
}

function ceil100(x: number): number {
  return Math.ceil(x / 100) * 100;
}

/** 役满点数（倍数 ≥1）：子 32000×k / 亲 48000×k；三麻自摸按 3a/2、2a 分布 */
function yakumanPoints(k: number): PointBreakdown {
  const a = 8000 * k;
  return {
    base: a,
    level: "yakuman",
    ron: ceil100(4 * a),
    ronParent: ceil100(6 * a),
    tsumoEachSanma: ceil100(1.5 * a),
    tsumoParentEachSanma: ceil100(2 * a),
    tsumoChildPays: ceil100(a),
    tsumoParentPays: ceil100(2 * a),
    yakumanCount: k,
  };
}

/**
 * 由（含宝牌的）番、符计算点数。
 * han >= 13 且 kazoe 开 → 累计役满：1 + floor((han-13)/13) 倍。
 */
// eslint-disable-next-line complexity -- 番阶分支表（普通→満貫→跳満→倍満→三倍満→累计役满），每档即法规条目
export function pointsFromHanFu(han: number, fu: number, opts: ScoreOptions = {}): PointBreakdown {
  const kazoe = opts.kazoeYakuman !== false;

  if (han >= 13) {
    if (kazoe) {
      const k = 1 + Math.floor((han - 13) / 13);
      return yakumanPoints(k);
    }
    // 无累计役满：按三倍满封顶
    const a = 6000;
    return finish(a, "sanbaiman", 0);
  }

  if (han >= 5) {
    let a = 2000;
    let level: ScoreLevel = "mangan";
    if (han >= 11) {
      a = 6000;
      level = "sanbaiman";
    } else if (han >= 8) {
      a = 4000;
      level = "baiman";
    } else if (han >= 6) {
      a = 3000;
      level = "haneman";
    }
    return finish(a, level, 0);
  }

  let a = fu * Math.pow(2, han + 2);
  let level: ScoreLevel = "normal";
  if (han === 4 && fu >= 40) a = 2000;
  else if (han === 3 && fu >= 70) a = 2000;
  else if (opts.kiriageMangan && han === 4 && fu === 30) a = 2000;
  if (a > 2000) a = 2000;
  if (a === 2000) level = "mangan";
  return finish(a, level, 0);
}

function finish(a: number, level: ScoreLevel, yakumanCount: number): PointBreakdown {
  return {
    base: a,
    level,
    ron: ceil100(4 * a),
    ronParent: ceil100(6 * a),
    tsumoEachSanma: ceil100(1.5 * a),
    tsumoParentEachSanma: ceil100(2 * a),
    tsumoChildPays: ceil100(a),
    tsumoParentPays: ceil100(2 * a),
    yakumanCount,
  };
}

export { yakumanPoints };
