/**
 * 点数层：han/fu → 点数全枚举（期望 = mahjong-utils 官方 API 实测值，oracle 对拍）
 * + 三麻自摸分布（3a/2 每家）+ 役满/累计役满 + 满贯跳切边界。
 */
import { describe, expect, it } from "vitest";
import { pointsFromHanFu, yakumanPoints } from "../../../src/usecases/mahjong/referee/points";

// oracle 实测（child ron）：[han, fu, ron]
const ORACLE_CHILD_RON: [number, number, number][] = [
  [1, 20, 700], [1, 25, 800], [1, 30, 1000], [1, 40, 1300], [1, 50, 1600],
  [1, 60, 2000], [1, 70, 2300], [1, 80, 2600], [1, 90, 2900], [1, 100, 3200], [1, 120, 3900],
  [2, 20, 1300], [2, 25, 1600], [2, 30, 2000], [2, 40, 2600], [2, 50, 3200],
  [2, 60, 3900], [2, 70, 4500], [2, 80, 5200], [2, 90, 5800], [2, 100, 6400], [2, 120, 7700],
  [3, 20, 2600], [3, 25, 3200], [3, 30, 3900], [3, 40, 5200], [3, 50, 6400], [3, 60, 7700],
  [3, 70, 8000], [3, 80, 8000], [3, 100, 8000], [3, 120, 8000],
  [4, 20, 5200], [4, 25, 6400], [4, 30, 7700], [4, 40, 8000], [4, 50, 8000], [4, 60, 8000],
  [5, 25, 8000], [5, 30, 8000], [5, 40, 8000], [5, 60, 8000],
  [6, 20, 12000], [6, 30, 12000], [6, 40, 12000],
  [7, 20, 12000], [7, 30, 12000],
  [8, 20, 16000], [8, 30, 16000], [9, 30, 16000], [10, 30, 16000],
  [11, 30, 24000], [12, 30, 24000],
  [13, 30, 32000], [14, 30, 32000], [16, 25, 32000], [18, 30, 32000],
];

describe("子家荣和点（oracle 全枚举对拍）", () => {
  it.each(ORACLE_CHILD_RON)("%i 翻 %i 符 → %i", (han, fu, ron) => {
    expect(pointsFromHanFu(han, fu).ron).toBe(ron);
  });
});

describe("亲家荣和点（oracle 抽样）", () => {
  it.each([
    [2, 30, 2900],
    [3, 40, 7700],
    [4, 25, 9600],
    [3, 70, 12000],
    [4, 40, 12000],
    [6, 30, 18000],
    [13, 30, 48000],
  ])("%i 翻 %i 符 → %i", (han, fu, ron) => {
    expect(pointsFromHanFu(han, fu).ronParent).toBe(ron);
  });
});

describe("满贯跳切边界", () => {
  it("4翻30符未切上 = 7700（非满贯）", () => {
    const p = pointsFromHanFu(4, 30);
    expect(p.ron).toBe(7700);
    expect(p.level).toBe("normal");
  });

  it("4翻30符 + 切上满贯 = 8000", () => {
    const p = pointsFromHanFu(4, 30, { kiriageMangan: true });
    expect(p.ron).toBe(8000);
    expect(p.level).toBe("mangan");
  });

  it("4翻40符 → 满贯 8000", () => {
    const p = pointsFromHanFu(4, 40);
    expect(p.ron).toBe(8000);
    expect(p.level).toBe("mangan");
  });

  it("3翻70符 → 满贯 8000", () => {
    expect(pointsFromHanFu(3, 70).ron).toBe(8000);
  });

  it("5翻起无条件满贯（与符无关）", () => {
    expect(pointsFromHanFu(5, 20).ron).toBe(8000);
    expect(pointsFromHanFu(5, 120).level).toBe("mangan");
  });

  it("6-7 翻跳满 / 8-10 翻倍满 / 11-12 三倍满", () => {
    expect(pointsFromHanFu(6, 30).level).toBe("haneman");
    expect(pointsFromHanFu(7, 30).level).toBe("haneman");
    expect(pointsFromHanFu(8, 30).level).toBe("baiman");
    expect(pointsFromHanFu(10, 30).level).toBe("baiman");
    expect(pointsFromHanFu(11, 30).level).toBe("sanbaiman");
    expect(pointsFromHanFu(12, 30).level).toBe("sanbaiman");
  });
});

describe("4p 自摸参照（oracle 对拍）", () => {
  it("2翻30符：子各 500 / 亲 1000", () => {
    const p = pointsFromHanFu(2, 30);
    expect(p.tsumoChildPays).toBe(500);
    expect(p.tsumoParentPays).toBe(1000);
  });
  it("3翻40符：子各 1300 / 亲 2600", () => {
    const p = pointsFromHanFu(3, 40);
    expect(p.tsumoChildPays).toBe(1300);
    expect(p.tsumoParentPays).toBe(2600);
  });
  it("4翻25符：子各 1600 / 亲 3200", () => {
    const p = pointsFromHanFu(4, 25);
    expect(p.tsumoChildPays).toBe(1600);
    expect(p.tsumoParentPays).toBe(3200);
  });
  it("满贯：子自摸 2000/4000；亲自摸各家 4000", () => {
    const p = pointsFromHanFu(5, 30);
    expect(p.tsumoChildPays).toBe(2000);
    expect(p.tsumoParentPays).toBe(4000);
    expect(p.tsumoParentEachSanma).toBe(4000);
  });
});

describe("三麻自摸分布（3a/2 每家，自摸损）", () => {
  it("子家自摸：每家 = ceil100(1.5×基本点)；总 3a < 荣和", () => {
    // 2翻30符: a = 480 → 每家 720→800? ceil100(720)=800
    const p = pointsFromHanFu(2, 30);
    expect(p.tsumoEachSanma).toBe(800);
    expect(p.tsumoEachSanma * 2).toBeLessThan(p.ron); // 自摸损
  });

  it("满贯：子自摸 3000all（总 6000 < 荣和 8000）", () => {
    const p = pointsFromHanFu(5, 30);
    expect(p.tsumoEachSanma).toBe(3000);
    expect(p.tsumoEachSanma * 2).toBe(6000);
    expect(p.ron).toBe(8000);
  });

  it("跳满 4500all / 倍满 6000all / 三倍满 9000all", () => {
    expect(pointsFromHanFu(6, 30).tsumoEachSanma).toBe(4500);
    expect(pointsFromHanFu(8, 30).tsumoEachSanma).toBe(6000);
    expect(pointsFromHanFu(11, 30).tsumoEachSanma).toBe(9000);
  });

  it("3翻30符 a=960 → 每家 1440→1500", () => {
    expect(pointsFromHanFu(3, 30).tsumoEachSanma).toBe(1500);
  });

  it("1翻30符 a=240 → 每家 360→400", () => {
    expect(pointsFromHanFu(1, 30).tsumoEachSanma).toBe(400);
  });

  it("亲自摸每家 = 2a（同 4p 口径）", () => {
    expect(pointsFromHanFu(3, 30).tsumoParentEachSanma).toBe(2000); // 2×960→2000
    expect(pointsFromHanFu(1, 30).tsumoParentEachSanma).toBe(500); // 2×240→500
  });
});

describe("役满与累计役满", () => {
  it("单倍役满：子 32000 / 亲 48000 / 自摸 12000all", () => {
    const p = pointsFromHanFu(13, 30);
    expect(p.ron).toBe(32000);
    expect(p.ronParent).toBe(48000);
    expect(p.tsumoEachSanma).toBe(12000);
    expect(p.tsumoParentEachSanma).toBe(16000);
    expect(p.yakumanCount).toBe(1);
    expect(p.level).toBe("yakuman");
  });

  it("累计役满：26 翻 = 2 倍（64000）", () => {
    const p = pointsFromHanFu(26, 30);
    expect(p.yakumanCount).toBe(2);
    expect(p.ron).toBe(64000);
  });

  it("累计役满：39 翻 = 3 倍；25 翻 = 1 倍", () => {
    expect(pointsFromHanFu(39, 30).yakumanCount).toBe(3);
    expect(pointsFromHanFu(25, 30).yakumanCount).toBe(1);
    expect(pointsFromHanFu(25, 30).ron).toBe(32000);
  });

  it("关累计役满：13+ 按三倍满封顶", () => {
    const p = pointsFromHanFu(18, 30, { kazoeYakuman: false });
    expect(p.ron).toBe(24000);
    expect(p.yakumanCount).toBe(0);
  });

  it("双倍役满点数：子 64000 / 亲 96000", () => {
    const p = yakumanPoints(2);
    expect(p.ron).toBe(64000);
    expect(p.ronParent).toBe(96000);
    expect(p.tsumoEachSanma).toBe(24000);
  });

  it("4 倍役满（大四喜+字一色+四暗刻 叠加口径）：128000", () => {
    const p = yakumanPoints(4);
    expect(p.ron).toBe(128000);
    expect(p.tsumoChildPays).toBe(32000); // oracle 对拍：4p 子自摸每家 32000
    expect(p.tsumoParentPays).toBe(64000);
  });
});
