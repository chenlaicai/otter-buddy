/**
 * 动作合法性：立直条件（门清/1000 点/余牌≥5/听牌）、食替禁止（同种/同听形）、
 * 副露（碰/明杠/暗杠/加杠/拔北，吃恒非法）、听牌判定。
 */
import { describe, expect, it } from "vitest";
import { parseTiles } from "../../../src/entities/mahjong/tile";
import {
  canCall,
  canDiscard,
  canRiichi,
  isTenpai,
} from "../../../src/usecases/mahjong/referee/actions";

const t = (s: string) => parseTiles(s);
const first = (s: string) => t(s)[0];

describe("立直条件", () => {
  const base = { menzen: true, points: 25000, remainingDraws: 70, willBeTenpai: true };

  it("条件齐备 → ok", () => {
    expect(canRiichi(base)).toEqual({ ok: true });
  });

  it("非门清 → NOT_MENZEN", () => {
    expect(canRiichi({ ...base, menzen: false }).reason).toBe("NOT_MENZEN");
  });

  it("点数不足 → LOW_POINTS；恰 1000 可立直", () => {
    expect(canRiichi({ ...base, points: 999 }).reason).toBe("LOW_POINTS");
    expect(canRiichi({ ...base, points: 1000 }).ok).toBe(true);
  });

  it("余牌 4 枚以下 → FEW_WALL_TILES；5 枚可立直", () => {
    expect(canRiichi({ ...base, remainingDraws: 4 }).reason).toBe("FEW_WALL_TILES");
    expect(canRiichi({ ...base, remainingDraws: 5 }).ok).toBe(true);
  });

  it("打出后不听牌 → NO_TILE", () => {
    expect(canRiichi({ ...base, willBeTenpai: false }).reason).toBe("NO_TILE");
  });

  it("已立直 → ALREADY_RIICHI（优先于其他检查）", () => {
    expect(canRiichi({ ...base, alreadyRiichi: true, menzen: false, points: 0 }).reason).toBe("ALREADY_RIICHI");
  });
});

describe("打牌合法性（食替）", () => {
  it("无鸣牌 → 恒 ok", () => {
    expect(canDiscard({ concealed: t("111m456p789p123s44z"), melds: [], discard: first("4z") }).ok).toBe(true);
  });

  it("碰后打同种 → KUIKAE_SAME_TILE", () => {
    const r = canDiscard({
      concealed: t("123p456p678s22s"),
      melds: [{ type: "pon", tiles: t("555s"), from: "toimen" }],
      justCalled: { type: "pon", called: first("5s") },
      discard: first("5s"),
    });
    expect(r.reason).toBe("KUIKAE_SAME_TILE");
  });

  it("碰后打同种（仅 tile 字段亦拦截）", () => {
    const r = canDiscard({
      concealed: t("123p456p678s22s"),
      melds: [{ type: "pon", tiles: t("555s"), from: "toimen" }],
      justCalled: { type: "pon", tile: first("5s") },
      discard: first("5s"),
    });
    expect(r.reason).toBe("KUIKAE_SAME_TILE");
  });

  // 注：KUIKAE_SAME_WAIT（听牌形保持禁令）在三麻碰牌结构下不可达——碰 A 后
  // post 手仅持 ≤1 张 A，鸣前雀头对已入副露变刻，要使鸣前后听牌集完全相同
  // 唯一解是弃牌 D = A（先被同种禁令拦下）。分支保留作防御，无正例可测。
  it("碰后打改变听牌形的牌（实测听 {7s} ≠ 鸣前 {2s,5s}）→ ok", () => {
    // 鸣前 13：123p456p + 678s + 22s + 鸣入 55s（听 {2s,5s}）；碰 555s 后打 7s 改听
    const r = canDiscard({
      concealed: t("123p456p678s22s"),
      melds: [{ type: "pon", tiles: t("555s"), from: "toimen" }],
      justCalled: { type: "pon", called: first("5s") },
      discard: first("7s"),
    });
    expect(r.ok).toBe(true);
  });

  it("明杠后打同种 → KUIKAE_SAME_TILE（同种禁令适用）", () => {
    const r = canDiscard({
      concealed: t("234p456p789p5s5z"),
      melds: [{ type: "daiminkan", tiles: t("1111s"), from: "toimen" }],
      justCalled: { type: "daiminkan", called: first("1s") },
      discard: first("1s"),
    });
    expect(r.reason).toBe("KUIKAE_SAME_TILE");
  });

  it("暗杠/拔北后打任意牌 → ok（无食替约束）", () => {
    const ankan = canDiscard({
      concealed: t("234p456p789p4z"),
      melds: [{ type: "ankan", tiles: t("1111s") }],
      justCalled: { type: "ankan", tile: first("1s") },
      discard: first("1s"),
    });
    expect(ankan.ok).toBe(true);
    const kita = canDiscard({
      concealed: t("234p456p789p4z"),
      melds: [{ type: "kita", tiles: t("4z") }],
      justCalled: { type: "kita", tile: first("4z") },
      discard: first("4z"),
    });
    expect(kita.ok).toBe(true);
  });
});

describe("副露合法性（无吃）", () => {
  const win13 = { concealed: t("123p456p55z5s6s7s8s"), melds: [] };

  it("吃 → NO_CHI_IN_SANMA（无论手牌）", () => {
    expect(canCall({ request: { type: "chi", called: first("1p") }, ...win13, turnWindow: true }).reason)
      .toBe("NO_CHI_IN_SANMA");
    expect(canCall({ request: { type: "chi" }, ...win13, turnWindow: false }).reason)
      .toBe("NOT_YOUR_TURN_STATE"); // 未轮到时先拦
  });

  it("碰：持 2 张 → ok；不足 → NO_TILE", () => {
    const ok = canCall({ request: { type: "pon", called: first("5s") }, concealed: t("5s5s123p456p789p"), melds: [], turnWindow: true });
    expect(ok.ok).toBe(true);
    const no = canCall({ request: { type: "pon", called: first("5s") }, concealed: t("5s123p456p789p"), melds: [], turnWindow: true });
    expect(no.reason).toBe("NO_TILE");
    const none = canCall({ request: { type: "pon", called: first("5s") }, concealed: t("123p456p789p"), melds: [], turnWindow: true });
    expect(none.reason).toBe("NO_TILE");
  });

  it("明杠：持 3 张 → ok；持 2 张 → NO_TILE", () => {
    const ok = canCall({ request: { type: "daiminkan", called: first("5s") }, concealed: t("5s5s5s123p456p"), melds: [], turnWindow: true });
    expect(ok.ok).toBe(true);
    const no = canCall({ request: { type: "daiminkan", called: first("5s") }, concealed: t("5s5s123p456p"), melds: [], turnWindow: true });
    expect(no.reason).toBe("NO_TILE");
  });

  it("暗杠：持 4 张 → ok；持 3 张 → NO_TILE", () => {
    const ok = canCall({ request: { type: "ankan", tile: first("5s") }, concealed: t("5s5s5s5s123p"), melds: [], turnWindow: true });
    expect(ok.ok).toBe(true);
    const no = canCall({ request: { type: "ankan", tile: first("5s") }, concealed: t("5s5s5s123p456p"), melds: [], turnWindow: true });
    expect(no.reason).toBe("NO_TILE");
  });

  it("加杠：有对应碰 → ok；无碰 → NO_TILE；无此牌 → NO_TILE", () => {
    const ok = canCall({
      request: { type: "kakan", tile: first("5s") },
      concealed: t("5s123p456p"),
      melds: [{ type: "pon", tiles: t("555s"), from: "toimen" }],
      turnWindow: true,
    });
    expect(ok.ok).toBe(true);
    const noPon = canCall({ request: { type: "kakan", tile: first("5s") }, concealed: t("5s123p456p"), melds: [], turnWindow: true });
    expect(noPon.reason).toBe("NO_TILE");
    const noTile = canCall({
      request: { type: "kakan", tile: first("7s") },
      concealed: t("5s123p456p"),
      melds: [{ type: "pon", tiles: t("555s"), from: "toimen" }],
      turnWindow: true,
    });
    expect(noTile.reason).toBe("NO_TILE");
  });

  it("拔北：持北 → ok；无北 → NO_TILE；牌山空 → WALL_EMPTY", () => {
    const ok = canCall({ request: { type: "kita", tile: first("4z") }, concealed: t("4z123p456p"), melds: [], turnWindow: true, remainingDraws: 10 });
    expect(ok.ok).toBe(true);
    const no = canCall({ request: { type: "kita", tile: first("4z") }, concealed: t("123p456p"), melds: [], turnWindow: true, remainingDraws: 10 });
    expect(no.reason).toBe("NO_TILE");
    const empty = canCall({ request: { type: "kita", tile: first("4z") }, concealed: t("4z123p456p"), melds: [], turnWindow: true, remainingDraws: 0 });
    expect(empty.reason).toBe("WALL_EMPTY");
  });

  it("非己方窗口（未轮到）→ NOT_YOUR_TURN_STATE", () => {
    const r = canCall({ request: { type: "pon", called: first("5s") }, concealed: t("5s5s123p456p"), melds: [], turnWindow: false });
    expect(r.reason).toBe("NOT_YOUR_TURN_STATE");
  });

  it("暗杠/拔北在自身回合外亦拦", () => {
    const r = canCall({ request: { type: "ankan", tile: first("5s") }, concealed: t("5s5s5s5s"), melds: [], turnWindow: false });
    expect(r.reason).toBe("NOT_YOUR_TURN_STATE");
  });
});

describe("听牌判定", () => {
  it("13 张听牌（双碰复合）→ true", () => {
    expect(isTenpai({ concealed: t("123p456p789p45s66s"), melds: [] })).toBe(true);
  });

  it("13 张不听 → false", () => {
    expect(isTenpai({ concealed: t("123p456p22s44s66s1z"), melds: [] })).toBe(false);
  });

  it("副露 1 面子后的 10 张听牌（单骑 4z）→ true", () => {
    expect(isTenpai({ concealed: t("123p456p789p4z"), melds: [{ type: "pon", tiles: t("555s"), from: "toimen" }] })).toBe(true);
  });

  it("拔北不占面子：13 张 + 拔北仍按门清算", () => {
    expect(isTenpai({ concealed: t("123p456p789p45s66s"), melds: [{ type: "kita", tiles: t("4z") }] })).toBe(true);
  });
});
