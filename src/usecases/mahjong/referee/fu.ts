/**
 * 符数计算——口径与 mahjong-utils CalcHu 一致（已源码核实）：
 * 20 底符；单骑/边张/嵌张 +2；副露碰：幺九+4/中张+2；暗杠：幺九+32/中张+16；
 * 明杠(明杠/加杠)：幺九+16/中张+8；门清暗刻：幺九+8/中张+4；
 * 双碰荣和 −2；连风雀头 +4（可关）；自风/场风雀头各 +2；三元牌雀头 +2；
 * 门清荣和 +10；非平和自摸 +2；副露最低 30；末位向 10 切上；七对 25；国士 30。
 */

import { kindToTile, tileKind } from "../../../entities/mahjong/tile";
import type { Meld } from "../../../entities/mahjong/meld";
import type { Pattern } from "./decompose";

export interface FuContext {
  /** 和了是自摸还是荣和 */
  readonly tsumo: boolean;
  /** 自风种类（z: 东=27 南=28 西=29） */
  readonly seatWindKind: number;
  /** 场风种类 */
  readonly roundWindKind: number;
  /** 连风雀头记 4 符（雀魂开；关则记 2） */
  readonly doubleWindPairFu?: boolean;
}

function isYaochuKind(kind: number): boolean {
  const t = kindToTile(kind);
  return t.suit === "z" || t.rank === 1 || t.rank === 9;
}

function isSangenKind(kind: number): boolean {
  return kind >= 31; // z5 白 z6 发 z7 中
}

/** 标准形符数（输入为已选定的分解）。 */
// eslint-disable-next-line complexity, max-statements -- 符表逐项累加（听牌形/副露/暗刻/雀头/门清/自摸/最低30/切上），规则表天然多分支
export function calcFu(pattern: Pattern, melds: readonly Meld[], ctx: FuContext): number {
  if (pattern.kind === "chiitoi") return 25;
  if (pattern.kind === "kokushi") return 30;

  const { tsumo, seatWindKind, roundWindKind } = ctx;
  let ans = 20;

  // 听牌形：单骑/边张/嵌张 +2（双碰与两面 +0）
  if (pattern.waitType === "tanki" || pattern.waitType === "kanchan" || pattern.waitType === "penchan") {
    ans += 2;
  }

  // 副露面子
  for (const m of melds) {
    if (m.type === "kita") continue;
    const kind = tileKind(m.tiles[0]);
    const yao = isYaochuKind(kind);
    if (m.type === "pon") ans += yao ? 4 : 2;
    else if (m.type === "ankan") ans += yao ? 32 : 16;
    else if (m.type === "daiminkan" || m.type === "kakan") ans += yao ? 16 : 8;
    // chi 在三麻不存在
  }

  // 门清部分的刻子（不含副露；暗杠已在上面按 melds 计）
  for (const b of pattern.blocks) {
    if (b.type === "set" && b.kindOfSet === "triplet") {
      const isConcealedBlock = b.form === "concealed";
      if (isConcealedBlock) {
        ans += isYaochuKind(b.kind) ? 8 : 4;
      }
    }
  }

  // 双碰荣和：和了刻子按明刻化 −2
  if (!tsumo && pattern.waitType === "shanpon") {
    ans -= 2;
  }

  // 役牌雀头
  const pair = pattern.blocks.find((b) => b.type === "pair");
  if (pair) {
    const k = pair.kind;
    const doubleWind = ctx.doubleWindPairFu !== false;
    if (k === seatWindKind) ans += 2;
    if (k === roundWindKind) ans += 2;
    if (k === seatWindKind && k === roundWindKind && !doubleWind) ans -= 2; // 连风仅记 2
    if (isSangenKind(k)) ans += 2;
  }

  // 门清荣和
  const menzen = melds.every((m) => m.type === "ankan" || m.type === "kita");
  if (menzen && !tsumo) ans += 10;

  // 非平和自摸 +2（平和自摸保持 20 符）
  if (ans !== 20 && tsumo) ans += 2;

  // 副露最低 30
  if (!menzen && ans < 30) ans = 30;

  // 切上
  if (ans % 10 > 0) ans += 10 - (ans % 10);
  return ans;
}
