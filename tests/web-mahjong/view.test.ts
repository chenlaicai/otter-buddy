/**
 * 三麻牌局页 · 纯视图层单测（web-mahjong/js/view.js）。
 *
 * 覆盖三块核心渲染逻辑：
 *  ① 视角变换（座位环 / 面板定位 / 暗牌张数推导）
 *  ② 手牌排序（种类升序 + 赤五在前 + 稳定保序）与牌面字形/标签
 *  ③ 动作按钮状态机（回合/副露/观战 × 模式切换 + 手牌可点性 → EngineAction 逐字透传）
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error 页面层原生 JS（无类型声明）——与 scripts/*.mjs 测试同一惯例，运行时 import 纯函数
import { actionBar, chunks, fieldInfo, handTileCount, panelsByPosition, seatLayout, sortHand, tileAction, tileGlyph, tileKindIndex, tileLabel, tileState } from "../../web-mahjong/js/view.js";

type Any = Record<string, any>;

function makeView(over: Any = {}): Any {
  return {
    roomId: "r1",
    gameId: "g1",
    status: "playing",
    roundNo: 1,
    honba: 2,
    sticks: 1,
    dealer: 1,
    phase: "turn",
    seatWinds: ["east", "south", "west"],
    wallRemaining: 60,
    doraIndicators: ["5s"],
    players: [0, 1, 2].map((s) => ({
      seat: s,
      name: `P${s}`,
      kind: "human",
      points: 25000 + s,
      hand: null,
      melds: [],
      kita: [],
      discards: [],
      riichi: false,
      riichiTurn: -1,
      ippatsu: false,
    })),
    decision: null,
    awaitingHuman: null,
    settlement: null,
    ...over,
  };
}

const DISCARDS = ["1z", "2p", "3s", "9m", "0p", "4z", "5z", "1m", "7s", "6p"];

describe("视角变换：座位环与面板定位", () => {
  it("viewer 视角下 bottom=自己、right=下家(+1)、left=上家(+2)", () => {
    expect(seatLayout(0)).toEqual({ bottom: 0, right: 1, left: 2 });
    expect(seatLayout(1)).toEqual({ bottom: 1, right: 2, left: 0 });
    expect(seatLayout(2)).toEqual({ bottom: 2, right: 0, left: 1 });
    // 观战（null）按 seat0 为底
    expect(seatLayout(null)).toEqual({ bottom: 0, right: 1, left: 2 });
  });

  it("panelByPosition 把对手与自己摆到对应位置，isMe/isDealer 正确", () => {
    const view = makeView({ dealer: 2 });
    view.players.forEach((p: Any) => {
      p.hand = ["1m"];
    });
    const panels = panelsByPosition(view, 1);
    expect(panels.bottom.seat).toBe(1);
    expect(panels.bottom.isMe).toBe(true);
    expect(panels.right.seat).toBe(2);
    expect(panels.left.seat).toBe(0);
    expect(panels.right.isDealer).toBe(true);
    expect(panels.left.isMe).toBe(false);
    // 观战：三家都可见牌面，但都不是"我"
    const spec = panelsByPosition(makeView({ players: view.players }), null);
    expect(spec.bottom.isSpectator).toBe(true);
    expect(spec.bottom.isMe).toBe(false);
    expect(spec.bottom.hand.visible).toBe(true);
  });

  it("暗牌张数：13 + 已摸 − 副露扣除（吃碰 2 / 明杠 3 / 暗杠 4 / 加杠 3）", () => {
    const base = () =>
      makeView({
        players: [0, 1, 2].map((s) => ({
          seat: s,
          name: `P${s}`,
          kind: "human",
          points: 25000,
          hand: null,
          melds: [],
          kita: [],
          discards: [],
          riichi: false,
          riichiTurn: -1,
          ippatsu: false,
        })),
      });
    const seat = 1;
    const withMelds = (melds: Any[]) => {
      const v = base();
      v.players[seat].melds = melds;
      return v;
    };
    expect(handTileCount(base(), seat)).toBe(13);
    // 轮到该家且已摸牌 → 14
    expect(handTileCount({ ...base(), decision: { kind: "turn", seat, actions: [], drawn: "5p" } }, seat)).toBe(14);
    expect(handTileCount(withMelds([{ type: "pon", tiles: ["1z", "1z", "1z"] }]), seat)).toBe(11);
    expect(
      handTileCount(
        { ...withMelds([{ type: "pon", tiles: ["1z", "1z", "1z"] }]), decision: { kind: "turn", seat, actions: [], drawn: "5p" } },
        seat,
      ),
    ).toBe(12);
    expect(handTileCount(withMelds([{ type: "daiminkan", tiles: ["1m", "1m", "1m", "1m"] }]), seat)).toBe(10);
    expect(handTileCount(withMelds([{ type: "ankan", tiles: ["1m", "1m", "1m", "1m"] }]), seat)).toBe(9);
    expect(handTileCount(withMelds([{ type: "kakan", tiles: ["1m", "1m", "1m", "1m"] }]), seat)).toBe(10);
    expect(
      handTileCount(
        withMelds([
          { type: "pon", tiles: ["1z", "1z", "1z"] },
          { type: "chi", tiles: ["2p", "3p", "4p"] },
          { type: "ankan", tiles: ["1m", "1m", "1m", "1m"] },
        ]),
        seat,
      ),
    ).toBe(5);
  });

  it("拔北不改手牌张数（北进拔北区、补牌回手）", () => {
    const v = makeView({
      players: [0, 1, 2].map((s) => ({
        seat: s,
        name: `P${s}`,
        kind: "human",
        points: 25000,
        hand: null,
        melds: [],
        kita: ["4z"],
        discards: [],
        riichi: false,
        riichiTurn: -1,
        ippatsu: false,
      })),
    });
    expect(handTileCount(v, 0)).toBe(13);
    expect(v.players[0].kita).toEqual(["4z"]);
  });
});

describe("手牌排序与牌面", () => {
  it("按种类升序，同种类内赤五在前，等价张稳定保序", () => {
    expect(sortHand(["1z", "1m", "9m", "0p", "5p", "1p", "4s"])).toEqual(["1m", "9m", "1p", "0p", "5p", "4s", "1z"]);
    expect(sortHand(["5p", "5p", "5p", "0p"])).toEqual(["0p", "5p", "5p", "5p"]);
    // 稳定：等种类等赤义保持输入顺序
    expect(sortHand(["2s", "1s", "1s"])).toEqual(["1s", "1s", "2s"]);
  });

  it("种类索引与实体层 SUIT_OFFSET 同源（m0/p9/s18/z27），赤五归 5", () => {
    expect(tileKindIndex("1m")).toBe(0);
    expect(tileKindIndex("9m")).toBe(8);
    expect(tileKindIndex("1p")).toBe(9);
    expect(tileKindIndex("1s")).toBe(18);
    expect(tileKindIndex("1z")).toBe(27);
    expect(tileKindIndex("4z")).toBe(30);
    expect(tileKindIndex("7z")).toBe(33);
    expect(tileKindIndex("0p")).toBe(13);
    expect(tileKindIndex("5p")).toBe(13);
    expect(tileKindIndex("junk")).toBe(-1);
  });

  it("Unicode 牌面字形（🀇-🀡、🀀-🀃、🀄🀅🀆）", () => {
    expect(tileGlyph("1m")).toBe(String.fromCodePoint(0x1f007));
    expect(tileGlyph("9m")).toBe(String.fromCodePoint(0x1f00f));
    expect(tileGlyph("1s")).toBe(String.fromCodePoint(0x1f010));
    expect(tileGlyph("9s")).toBe(String.fromCodePoint(0x1f018));
    expect(tileGlyph("1p")).toBe(String.fromCodePoint(0x1f019));
    expect(tileGlyph("9p")).toBe(String.fromCodePoint(0x1f021));
    expect(tileGlyph("1z")).toBe(String.fromCodePoint(0x1f000)); // 東
    expect(tileGlyph("4z")).toBe(String.fromCodePoint(0x1f003)); // 北（三麻拔北牌）
    expect(tileGlyph("5z")).toBe(String.fromCodePoint(0x1f006)); // 白
    expect(tileGlyph("6z")).toBe(String.fromCodePoint(0x1f005)); // 發
    expect(tileGlyph("7z")).toBe(String.fromCodePoint(0x1f004)); // 中
    // 赤五沿用五的位置（颜色由 CSS 标注）
    expect(tileGlyph("0p")).toBe(tileGlyph("5p"));
    expect(tileGlyph("0s")).toBe(tileGlyph("5s"));
    expect(tileGlyph("zzz")).toBe("");
  });

  it("牌面人读标签", () => {
    expect(tileLabel("0p")).toBe("赤五筒");
    expect(tileLabel("5p")).toBe("五筒");
    expect(tileLabel("9m")).toBe("九萬");
    expect(tileLabel("4z")).toBe("北");
    expect(tileLabel("7z")).toBe("中");
  });

  it("牌河分块 6 列", () => {
    expect(chunks(DISCARDS, 6)).toEqual([DISCARDS.slice(0, 6), DISCARDS.slice(6)]);
    expect(chunks([], 6)).toEqual([]);
  });
});

describe("动作按钮状态机", () => {
  const TURN_ACTIONS = [
    { type: "discard", tile: "1p" },
    { type: "discard", tile: "5p", riichi: true },
    { type: "tsumo" },
    { type: "kita" },
    { type: "ankan", kind: "9s" },
    { type: "kakan", tile: "3s" },
    { type: "ryuukyoku" },
  ];

  it("回合：自摸/立直/拔北/暗杠/加杠/九种九牌 按合法集显隐，提示点手牌", () => {
    const view = makeView({ decision: { kind: "turn", seat: 0, actions: TURN_ACTIONS, drawn: "1p" } });
    const bar = actionBar(view, 0, { mode: null });
    expect(bar.buttons.map((b: Any) => b.id)).toEqual(["tsumo", "riichi", "kita", "ankan", "kakan", "ryuukyoku"]);
    expect(bar.hint).toBe("点手牌打出");
    expect(bar.turnSeat).toBe(0);
    // 直接动作带 EngineAction，模式动作用 mode 字段切状态
    expect(bar.buttons[0].action).toEqual({ type: "tsumo" });
    expect(bar.buttons[1].mode).toBe("riichi");
    expect(bar.buttons[1].action).toBeUndefined();
  });

  it("立直模式：按钮 active + 取消项 + 提示切换；未选中时其余模式同理", () => {
    const view = makeView({ decision: { kind: "turn", seat: 0, actions: TURN_ACTIONS, drawn: "1p" } });
    const riichi = actionBar(view, 0, { mode: "riichi" });
    expect(riichi.buttons.find((b: Any) => b.id === "riichi").active).toBe(true);
    expect(riichi.buttons.map((b: Any) => b.id)).toContain("cancel");
    expect(riichi.hint).toContain("立直");
    const ankan = actionBar(view, 0, { mode: "ankan" });
    expect(ankan.buttons.find((b: Any) => b.id === "ankan").active).toBe(true);
    expect(ankan.buttons.find((b: Any) => b.id === "cancel").mode).toBe(null);
  });

  it("副露窗口：和/碰/杠/跳过 + 被鸣牌信息", () => {
    const view = makeView({
      phase: "claim",
      decision: {
        kind: "claim",
        seat: 1,
        actions: [{ type: "ron" }, { type: "pon" }, { type: "daiminkan" }, { type: "pass" }],
        claim: { discardSeat: 2, discardTile: "5s" },
      },
    });
    const bar = actionBar(view, 1, { mode: null });
    expect(bar.buttons.map((b: Any) => b.id)).toEqual(["ron", "pon", "daiminkan", "pass"]);
    expect(bar.claim).toEqual({ discardSeat: 2, discardTile: "5s" });
    expect(bar.hint).toContain("五索");
    expect(bar.buttons[0].tone).toBe("win");
  });

  it("观战无按钮；未轮到自己给等待提示；无决策点区分终局", () => {
    const spec = actionBar(makeView({ decision: { kind: "turn", seat: 0, actions: TURN_ACTIONS } }), null, { mode: null });
    expect(spec.buttons).toEqual([]);
    expect(spec.hint).toContain("观战");

    const waiting = actionBar(
      makeView({ decision: { kind: "turn", seat: 2, actions: [{ type: "discard", tile: "1p" }] } }),
      0,
      { mode: null },
    );
    expect(waiting.buttons).toEqual([]);
    expect(waiting.hint).toContain("P2");

    const done = actionBar(makeView({ status: "finished", decision: null }), 0, { mode: null });
    expect(done.hint).toBe("本局已结束");
    const idle = actionBar(makeView({ decision: null }), 0, { mode: null });
    expect(idle.hint).toBe("等待开局");
  });
});

describe("手牌点击 → 动作（逐字取自 decision.actions）", () => {
  const TURN_ACTIONS = [
    { type: "discard", tile: "1p" },
    { type: "discard", tile: "0p" },
    { type: "discard", tile: "5p", riichi: true },
    { type: "ankan", kind: "0s" },
    { type: "kakan", tile: "3s" },
  ];
  const view = makeView({ decision: { kind: "turn", seat: 0, actions: TURN_ACTIONS, drawn: "1p" } });

  it("普通打牌：返回同一动作对象（identity 保证逐字透传）", () => {
    expect(tileAction(view, 0, { mode: null }, "1p")).toBe(TURN_ACTIONS[0]);
    // 赤五与五各自有独立动作
    expect(tileAction(view, 0, { mode: null }, "0p")).toBe(TURN_ACTIONS[1]);
    expect(tileAction(view, 0, { mode: null }, "5p")).toBeNull();
  });

  it("立直模式：只命中带 riichi 的那条；无立直资格的张返回 null", () => {
    expect(tileAction(view, 0, { mode: "riichi" }, "5p")).toBe(TURN_ACTIONS[2]);
    expect(tileAction(view, 0, { mode: "riichi" }, "1p")).toBeNull();
    expect(tileAction(view, 0, { mode: "riichi" }, "0p")).toBeNull();
  });

  it("暗杠/加杠按种类匹配，动作对象仍原样透传（赤义记谱不在页面改写）", () => {
    // ankan kind 记谱可能是 '0s'，手牌里是 '5s' → 按种类对齐
    expect(tileAction(view, 0, { mode: "ankan" }, "5s")).toBe(TURN_ACTIONS[3]);
    expect(tileAction(view, 0, { mode: "ankan" }, "1m")).toBeNull();
    expect(tileAction(view, 0, { mode: "kakan" }, "3s")).toBe(TURN_ACTIONS[4]);
    expect(tileAction(view, 0, { mode: "kakan" }, "1p")).toBeNull();
  });

  it("观战 / 非自己回合 / 副露窗口：一律不产出动作", () => {
    expect(tileAction(view, null, { mode: null }, "1p")).toBeNull();
    expect(tileAction(view, 1, { mode: null }, "1p")).toBeNull();
    const claim = makeView({
      decision: { kind: "claim", seat: 0, actions: [{ type: "pass" }], claim: { discardSeat: 1, discardTile: "1p" } },
    });
    expect(tileAction(claim, 0, { mode: null }, "1p")).toBeNull();
    expect(tileAction(makeView({ decision: null }), 0, { mode: null }, "1p")).toBeNull();
  });
});

describe("手牌可点性（状态机消费面）", () => {
  const view = makeView({
    decision: { kind: "turn", seat: 0, actions: [{ type: "discard", tile: "1p" }, { type: "discard", tile: "9m", riichi: true }], drawn: "1p" },
  });

  it("可点张给出 clickable 与字形；食替/不可打出的张标 reason", () => {
    const ok = tileState(view, 0, { mode: null }, "1p");
    expect(ok.clickable).toBe(true);
    expect(ok.glyph).toBe(tileGlyph("1p"));
    const blocked = tileState(view, 0, { mode: null }, "2p");
    expect(blocked.clickable).toBe(false);
    expect(blocked.reason).toContain("不可打出");
  });

  it("观战 / 未到回合 / 副露窗口 / 模式不匹配 各自给出 reason", () => {
    expect(tileState(view, null, { mode: null }, "1p").reason).toBe("观战");
    expect(tileState(view, 1, { mode: null }, "1p").reason).toBe("未到你的回合");
    expect(tileState(view, 0, { mode: "riichi" }, "1p").reason).toBe("此张不能立直");
    expect(tileState(view, 0, { mode: "ankan" }, "1p").reason).toContain("暗杠");
    const claim = makeView({
      decision: { kind: "claim", seat: 0, actions: [{ type: "pass" }], claim: { discardSeat: 1, discardTile: "1p" } },
    });
    expect(tileState(claim, 0, { mode: null }, "1p").reason).toContain("副露窗口");
    expect(tileState(makeView({ decision: null }), 0, { mode: null }, "1p").reason).toBe("未到行动时机");
  });
});

describe("场况栏", () => {
  it("局数/本场/供托/余牌/宝牌指示牌/庄家/当前行动家", () => {
    const view = makeView({ decision: { kind: "turn", seat: 2, actions: [] } });
    const info = fieldInfo(view);
    expect(info.roundLabel).toBe("東一局");
    expect(info.windLabel).toBe("東風戦");
    expect(info.honbaLabel).toBe("2 本場");
    expect(info.sticksLabel).toBe("供托 1");
    expect(info.wallLabel).toBe("余牌 60");
    expect(info.dealer).toBe(1);
    expect(info.current).toBe(2);
    expect(info.doraIndicators[0].glyph).toBe(tileGlyph("5s"));
    expect(info.winds.map((w: Any) => w.cn)).toEqual(["東", "南", "西"]);
    expect(fieldInfo(makeView({ roundNo: 4 })).roundLabel).toBe("東四局");
  });

  it("牌河含立直棒横置标记（riichiTurn 为 1 基序号 → 下标 -1）", () => {
    const view = makeView();
    view.players[1].discards = ["1z", "2z", "3z", "4z"];
    view.players[1].riichi = true;
    view.players[1].riichiTurn = 3;
    const panels = panelsByPosition(view, 0);
    expect(panels.right.discards.map((d: Any) => d.riichi)).toEqual([false, false, true, false]);
    expect(panels.right.discards[2].glyph).toBe(tileGlyph("3z"));
  });
});
