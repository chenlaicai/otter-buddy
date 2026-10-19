/**
 * 三麻牌局页 · 纯视图层（零 DOM、零网络）——供单测直接 import。
 *
 * 输入：GET /api/mahjong/rooms/:roomId/view 返回的 RoomView 快照（字段签名见
 * docs/features/2026/10/15/F20261015mjsg-mahjong-sanma.md「实现记录（Engine 层）·页面獭接口面」）。
 * 输出：渲染所需的结构化视图模型。DOM 组装在 app.js，不回流本模块；
 * 动作发出的 EngineAction 必须逐字取自 view.decision.actions（HTTP 面按此校验）。
 */

/** 记谱字尾 → 花色偏移（与 src/entities/mahjong/tile.ts SUIT_OFFSET 同源） */
const SUIT_OFFSET = { m: 0, p: 9, s: 18, z: 27 };

/** 1z..7z 字牌字面：東南西北 · 白發中（Unicode 序 白=U+1F006 / 發=U+1F005 / 中=U+1F004） */
const HONOR_GLYPHS = ["\u{1F000}", "\u{1F001}", "\u{1F002}", "\u{1F003}", "\u{1F006}", "\u{1F005}", "\u{1F004}"];
/** 花色首码点：萬 U+1F007 起 / 索 U+1F010 起 / 筒 U+1F019 起 */
const SUIT_BASE = { m: 0x1f007, s: 0x1f010, p: 0x1f019 };
const SUIT_CN = { m: "萬", p: "筒", s: "索" };
const RANK_CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const HONOR_CN = ["東", "南", "西", "北", "白", "發", "中"];
/** 场风/座风展示（引擎 SEAT_WINDS = east/south/west，三麻无北家座） */
const WIND_CN = { east: "東", south: "南", west: "西", north: "北" };
const WIND_NAME = { east: "東風", south: "南風", west: "西風", north: "北風" };
const ROUND_CN = ["一", "二", "三", "四"];
/** 副露扣掉的手牌张数（吃/碰 2、明杠 3、暗杠 4、加杠 3——加杠由碰 2 + 手内补 1） */
const MELD_HAND_COST = { chi: 2, pon: 2, daiminkan: 3, ankan: 4, kakan: 3 };
const MELD_CN = { chi: "吃", pon: "碰", daiminkan: "明杠", ankan: "暗杠", kakan: "加杠", kita: "拔北" };
const FROM_CN = { kamicha: "上家", toimen: "对家", shimocha: "下家" };

/** 记谱单张（'5p' / '0p'=赤五）→ 种类索引 0..33；无法解析返回 -1 */
export function tileKindIndex(code) {
  if (typeof code !== "string" || code.length < 2) return -1;
  const suit = code.slice(-1);
  const offset = SUIT_OFFSET[suit];
  if (offset === undefined) return -1;
  const rank = Number(code.slice(0, -1));
  if (!Number.isInteger(rank)) return -1;
  const r = rank === 0 ? 5 : rank;
  if (r < 1 || r > 9) return -1;
  return offset + r - 1;
}

/** 是否赤五（'0p' / '0s'） */
export function isRed(code) {
  return typeof code === "string" && code.length === 2 && code[0] === "0";
}

/** 手牌排序：按种类升序，同种类内赤五在前（稳定——原序保序） */
export function sortHand(codes) {
  return codes
    .map((code, index) => ({ code, index }))
    .sort((a, b) => {
      const ka = tileKindIndex(a.code);
      const kb = tileKindIndex(b.code);
      if (ka !== kb) return ka - kb;
      const ra = isRed(a.code) ? 0 : 1;
      const rb = isRed(b.code) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.index - b.index;
    })
    .map((x) => x.code);
}

/** 牌面字形（Unicode 麻将字符，无图片资源） */
export function tileGlyph(code) {
  const kind = tileKindIndex(code);
  if (kind < 0) return "";
  const suit = code.slice(-1);
  if (suit === "z") return HONOR_GLYPHS[kind - SUIT_OFFSET.z] ?? "";
  const base = SUIT_BASE[suit];
  if (base === undefined) return "";
  const rank = isRed(code) ? 5 : Number(code.slice(0, -1));
  return String.fromCodePoint(base + rank - 1);
}

/** 牌面人读名（aria-label/title）：赤五筒 / 五萬 / 東 */
export function tileLabel(code) {
  const suit = code.slice(-1);
  const red = isRed(code);
  const r = red ? 5 : Number(code.slice(0, -1));
  if (suit === "z") return HONOR_CN[r - 1] ?? code;
  const cn = SUIT_CN[suit];
  if (cn === undefined) return code;
  return `${red ? "赤" : ""}${RANK_CN[r - 1] ?? "?"}${cn}`;
}

/**
 * 座位环（视角变换）：viewer 视角下 bottom=自己，right=下家，left=上家。
 * 引擎口径 src/usecases/mahjong/engine/engine.ts:103 `(caller + 1) % 3 === discardSeat → shimocha`，
 * 即 seat+1 为下家（出牌逆时针，下家在右手边）。观战（viewer=null）按 seat0 为底。
 */
export function seatLayout(viewer) {
  const base = Number.isInteger(viewer) ? viewer : 0;
  return { bottom: base % 3, right: (base + 1) % 3, left: (base + 2) % 3 };
}

/** 数组按 n 分块（牌河 6 列用） */
export function chunks(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** 对手暗牌张数：13 +（轮到该家且已摸牌则 +1）− 副露扣除 */
export function handTileCount(view, seat) {
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return 13;
  let n = 13;
  for (const m of p.melds) n -= MELD_HAND_COST[m.type] ?? 2;
  const dp = view.decision;
  if (dp && dp.kind === "turn" && dp.seat === seat && dp.drawn) n += 1;
  return Math.max(n, 0);
}

/** 场况栏（局数/本场/供托/余牌/宝牌指示牌/座位风） */
export function fieldInfo(view) {
  const dp = view.decision;
  const current = dp ? dp.seat : null;
  return {
    roundLabel: `東${ROUND_CN[view.roundNo - 1] ?? "?"}局`,
    windLabel: "東風戦",
    honba: view.honba,
    honbaLabel: `${view.honba} 本場`,
    sticks: view.sticks,
    sticksLabel: `供托 ${view.sticks}`,
    wallRemaining: view.wallRemaining,
    wallLabel: `余牌 ${view.wallRemaining}`,
    dealer: view.dealer,
    doraIndicators: view.doraIndicators.map((code) => ({ code, glyph: tileGlyph(code), label: tileLabel(code) })),
    winds: view.seatWinds.map((w) => ({ code: w, cn: WIND_CN[w] ?? w, name: WIND_NAME[w] ?? w })),
    current,
    phase: view.phase,
    status: view.status,
  };
}

/**
 * 单个玩家面板的渲染视图模型（自顶向下：副露/拔北/牌河/点数/手牌）。
 * 可见性口径来自引擎视图：viewer===seat 或观战（hand 非 null）才拿得到牌面。
 */
export function playerPanel(view, seat, viewer) {
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return null;
  const dp = view.decision;
  const visible = Array.isArray(p.hand);
  const tiles = visible ? sortHand(p.hand) : [];
  const riichiIndex = p.riichi ? p.riichiTurn - 1 : -1;
  const wind = view.seatWinds[seat];
  return {
    seat,
    name: p.name,
    kind: p.kind,
    points: p.points,
    pointsLabel: String(p.points),
    wind: WIND_CN[wind] ?? wind,
    windName: WIND_NAME[wind] ?? wind,
    isDealer: seat === view.dealer,
    isMe: Number.isInteger(viewer) && viewer === seat,
    isSpectator: !Number.isInteger(viewer),
    isCurrent: dp !== null && dp.seat === seat,
    riichi: p.riichi,
    riichiTurn: p.riichiTurn,
    ippatsu: p.ippatsu,
    hand: {
      visible,
      tiles: tiles.map((code) => tileModel(code)),
      backCount: visible ? tiles.length : handTileCount(view, seat),
    },
    melds: p.melds.map((m) => ({
      type: m.type,
      cn: MELD_CN[m.type] ?? m.type,
      from: m.from ?? null,
      fromCn: m.from ? FROM_CN[m.from] ?? m.from : null,
      tiles: m.tiles.map((code) => ({ code, glyph: tileGlyph(code), label: tileLabel(code), red: isRed(code) })),
    })),
    kita: p.kita.map((code) => ({ code, glyph: tileGlyph(code), label: tileLabel(code), red: isRed(code) })),
    discards: p.discards.map((code, i) => ({
      code,
      glyph: tileGlyph(code),
      label: tileLabel(code),
      red: isRed(code),
      riichi: i === riichiIndex,
      tsumogiri: false,
    })),
  };
}

/** 牌面模型（手牌/公共牌共用） */
export function tileModel(code) {
  return { code, glyph: tileGlyph(code), label: tileLabel(code), red: isRed(code) };
}

/** 三个座位的面板，按 left/right/bottom 位置取（视角变换的消费面） */
export function panelsByPosition(view, viewer) {
  const layout = seatLayout(viewer);
  const bySeat = (seat) => playerPanel(view, seat, viewer);
  return { left: bySeat(layout.left), right: bySeat(layout.right), bottom: bySeat(layout.bottom) };
}

/**
 * 动作按钮状态机。
 * @param {object} view  RoomView
 * @param {number|null} seat  0|1|2；null = 观战（无按钮）
 * @param {{mode: (null|string)}} ui  当前交互模式：null / "riichi" / "ankan" / "kakan"
 * @returns {{buttons: Array<object>, hint: string, claim: (object|null), turnSeat: (number|null)}}
 */
export function actionBar(view, seat, ui) {
  const mode = ui?.mode ?? null;
  const empty = (hint) => ({ buttons: [], hint, claim: null, turnSeat: view?.decision?.seat ?? null });
  if (!view) return empty("");
  if (!Number.isInteger(seat)) return empty("观战中——可看全场，不能出牌");
  const dp = view.decision;
  if (!dp) return empty(view.status === "finished" ? "本局已结束" : "等待开局");
  if (dp.seat !== seat) return empty(`等待 ${view.players.find((p) => p.seat === dp.seat)?.name ?? dp.seat} 行动`);

  const buttons = [];
  const claim = dp.kind === "claim" && dp.claim ? { ...dp.claim } : null;
  const has = (type) => dp.actions.some((a) => a.type === type);
  const hasRiichi = dp.actions.some((a) => a.type === "discard" && a.riichi === true);

  if (dp.kind === "turn") {
    if (has("tsumo")) buttons.push({ id: "tsumo", label: "自摸", tone: "win", action: { type: "tsumo" } });
    if (hasRiichi)
      buttons.push({ id: "riichi", label: mode === "riichi" ? "取消立直" : "立直", tone: "accent", mode: "riichi", active: mode === "riichi" });
    if (has("kita")) buttons.push({ id: "kita", label: "拔北", tone: "accent", action: { type: "kita" } });
    if (has("ankan")) buttons.push({ id: "ankan", label: "暗杠", tone: "accent", mode: "ankan", active: mode === "ankan" });
    if (has("kakan")) buttons.push({ id: "kakan", label: "加杠", tone: "accent", mode: "kakan", active: mode === "kakan" });
    if (has("ryuukyoku")) buttons.push({ id: "ryuukyoku", label: "九种九牌", tone: "warn", action: { type: "ryuukyoku" } });
    if (mode) buttons.push({ id: "cancel", label: "取消", tone: "muted", mode: null });
    const hint =
      mode === "riichi"
        ? "点手牌立直（只有能听牌的张可点）"
        : mode === "ankan"
          ? "点手牌暗杠"
          : mode === "kakan"
            ? "点手牌加杠"
            : "点手牌打出";
    return { buttons, hint, claim, turnSeat: dp.seat };
  }

  // 副露窗口：和 / 碰 / 杠 / 跳过（引擎 claimActions 生成）
  if (has("ron")) buttons.push({ id: "ron", label: "和", tone: "win", action: { type: "ron" } });
  if (has("pon")) buttons.push({ id: "pon", label: "碰", tone: "accent", action: { type: "pon" } });
  if (has("daiminkan")) buttons.push({ id: "daiminkan", label: "杠", tone: "accent", action: { type: "daiminkan" } });
  if (has("pass")) buttons.push({ id: "pass", label: "跳过", tone: "muted", action: { type: "pass" } });
  return {
    buttons,
    hint: claim
      ? `${view.players.find((p) => p.seat === claim.discardSeat)?.name ?? claim.discardSeat} 打出 ${tileLabel(claim.discardTile)}——要不要`
      : "副露窗口",
    claim,
    turnSeat: dp.seat,
  };
}

/**
 * 手牌点击 → 动作：必须逐字取自 decision.actions（同种类匹配，赤五记谱可为 '0p'）。
 * @returns {object|null} EngineAction 原对象
 */
export function tileAction(view, seat, ui, code) {
  const dp = view?.decision;
  if (!dp || !Number.isInteger(seat) || dp.seat !== seat || dp.kind !== "turn") return null;
  const mode = ui?.mode ?? null;
  const ki = tileKindIndex(code);
  // 打牌/立直/加杠：动作记谱必须与点击的张逐字一致——按种类匹配会把红五换成普通五打出去
  if (mode === "riichi") {
    return dp.actions.find((a) => a.type === "discard" && a.riichi === true && a.tile === code) ?? null;
  }
  if (mode === "ankan") {
    return dp.actions.find((a) => a.type === "ankan" && tileKindIndex(a.kind) === ki) ?? null;
  }
  if (mode === "kakan") {
    return dp.actions.find((a) => a.type === "kakan" && a.tile === code) ?? null;
  }
  return dp.actions.find((a) => a.type === "discard" && a.riichi !== true && a.tile === code) ?? null;
}

/**
 * 单张手牌的可点性（动作按钮状态机的手牌侧）。
 * @returns {{code, glyph, label, red, clickable, reason}}
 */
export function tileState(view, seat, ui, code) {
  const model = tileModel(code);
  const dp = view?.decision;
  const reason = (r) => ({ ...model, clickable: false, reason: r });
  if (!Number.isInteger(seat)) return reason("观战");
  if (!dp) return reason("未到行动时机");
  if (dp.seat !== seat) return reason("未到你的回合");
  if (dp.kind !== "turn") return reason("副露窗口用下方按钮");
  const mode = ui?.mode ?? null;
  if (mode === "ankan" || mode === "kakan" || mode === "riichi") {
    const action = tileAction(view, seat, ui, code);
    if (!action) return reason(mode === "riichi" ? "此张不能立直" : `此张不能${mode === "ankan" ? "暗杠" : "加杠"}`);
    return { ...model, clickable: true, reason: "" };
  }
  const action = tileAction(view, seat, ui, code);
  if (!action) return reason("不可打出（食替/立直后）");
  return { ...model, clickable: true, reason: "" };
}

/** 结算/终局摘要（SSE 推送的 win/drawEnd/abortive/gameOver 事件用） */
export function settlementModel(events) {
  const win = events.find((e) => e.type === "win" || e.type === "drawEnd" || e.type === "abortive");
  const over = events.find((e) => e.type === "gameOver");
  if (over) return { kind: "gameover", ranking: over.ranking ?? [] };
  if (!win || !win.settlement) return null;
  const s = win.settlement;
  const kindCn = { tsumo: "自摸", ron: "荣和", noten: "流局", abortive: "流局" }[s.kind] ?? s.kind;
  return {
    kind: win.type === "abortive" ? "abortive" : "settlement",
    title: kindCn + (s.abortive ? `（${s.abortive}）` : ""),
    deltas: s.deltas ?? [],
    winners: s.winners ?? [],
    payer: s.payer ?? null,
    tenpai: s.tenpai ?? null,
    yakuSummary: s.yakuSummary ?? [],
    players: null,
  };
}
