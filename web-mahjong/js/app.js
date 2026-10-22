/**
 * 三麻牌局页编排（F20261015mjsg 模块四）。
 *
 * 职责边界：视图模型推导全在 view.js（纯函数、可单测），本文件只做
 * ① URL 解析（/mahjong = 大厅，/mahjong/:roomId = 牌局）② 拉视图与动作注入
 * ③ DOM 组装与事件绑定 ④ 遮罩流程（入座 / 建房 / 房间缺失）。
 *
 * 状态唯一真相源 = 服务端视图（GET view 的 RoomView）；本地只存座位选择与 UI 模式。
 */
import { createApi } from "./api.js";
import {
  actionBar,
  fieldInfo,
  formatChatLine,
  riverTable,
  settlementModel,
  stripsByPosition,
  tileAction,
  tileGlyph,
  tileLabel,
  tileState,
} from "./view.js";

const api = createApi();
const $ = (id) => document.getElementById(id);

/** 文本插值统一走这里——房名/座位名来自 POST /rooms，未转义进 innerHTML 就是 XSS */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const SEAT_CN = ["东", "南", "西"];

const state = {
  screen: "loading", // loading | lobby | room | missing
  roomId: null,
  seat: null, // 0|1|2 | null = 观战
  view: null,
  ui: { mode: null }, // null | riichi | ankan | kakan
  streamSettle: null, // SSE game 事件推导的结算/终局（view.settlement 是瞬时的，轮次推进即消失）
  conn: "idle", // idle | connecting | open | reconnecting | closed | error
  log: [],
  overlay: null, // null | join | lobby | missing | created
  notice: "",
  busy: false,
  seatKey: () => (state.roomId ? `mahjong:${state.roomId}:seat` : null),
};

// ───────────────────────── 片段 ─────────────────────────

function tileHtml(code, size = "tile--md", extraClass = "") {
  return `<span class="tile ${size} ${extraClass}" data-code="${esc(code)}" title="${esc(tileLabel(code))}" aria-label="${esc(
    tileLabel(code),
  )}">${esc(tileGlyph(code))}</span>`;
}

function backsHtml(n) {
  return `<span class="p-hidden">${'<span class="tile tile--back tile--sm"></span>'.repeat(Math.max(0, n))}</span>`;
}

/** 副露组；空数组给空串——桌面上没副露就空着，不摆占位字（v3 自检：三条「副露 —」是泔水） */
function meldsHtml(melds) {
  if (!melds.length) return "";
  return melds
    .map(
      (m) =>
        `<span class="meld"><span class="meld-tag">${esc(m.cn)}${m.fromCn ? `·${esc(m.fromCn)}` : ""}</span>${m.tiles
          .map((t) => tileHtml(t.code, "tile--sm"))
          .join("")}</span>`,
    )
    .join("");
}

/** 拔北：0 张不占位（>0 才显计数+牌面） */
function kitaHtml(kita) {
  if (!kita.length) return "";
  return `<span class="kita-label">拔北 ${kita.length}</span>${kita.map((t) => tileHtml(t.code, "tile--sm")).join("")}`;
}

/** 牌河（v3：围桌心三方的矩形区，牌字符全正朝向；空河留容器占位） */
function riverHtml(river) {
  if (!river || !river.tiles.length) return "";
  return river.tiles.map((t) => tileHtml(t.code, "", t.riichi ? "tile--riichi" : "")).join("");
}

/** 副露 + 拔北（各家自己的场）：空则整段不占位，布局高度由 min-height 兑住 */
function meldZoneHtml(p) {
  return [meldsHtml(p.melds), kitaHtml(p.kita)].filter(Boolean).join(" ");
}

/**
 * 玩家信息条内容（名字/风/徽标/点数）——**不含牌河**：牌河归 riverTable 单点渲染，
 * 同一状态只留一个渲染点（D4）。
 */
function pinfoInnerHtml(p) {
  const badges = [
    p.isDealer ? '<span class="badge badge--dealer">庄</span>' : "",
    p.riichi ? '<span class="badge badge--riichi">立直</span>' : "",
    p.ippatsu ? '<span class="badge badge--ippatsu">一发</span>' : "",
    p.isCurrent ? '<span class="badge">出牌中</span>' : "",
  ].join("");
  return `<span class="p-name">${esc(p.name)}</span>
      <span class="p-wind${p.isDealer ? " is-dealer" : ""}" title="${esc(p.windName)}家">${esc(p.wind)}</span>
      ${badges}
      <span class="p-points">${esc(p.pointsLabel)}</span>`;
}

/** 对手座位块内容：信息条 + 暗牌（观战态为牌面横幅）+ 副露场（牌河由调用方追加） */
function stripBlockHtml(p) {
  if (!p) return "";
  const hand = p.hand.visible
    ? p.hand.tiles.map((t) => tileHtml(t.code, "tile--sm")).join("")
    : backsHtml(p.hand.backCount);
  return `<div class="pinfo">${pinfoInnerHtml(p)}</div>
    <div class="p-hand concealed">${hand}</div>
    <div class="melds melds-zone">${meldZoneHtml(p)}</div>`;
}

// ───────────────────────── 渲染 ─────────────────────────

/** 场况角标（台面左上）：宝牌指示 + 牌型提醒预留槽位 + 连接态 + 停局。
 *  场况主显示已移桌心信息盘（D3：同一状态不双显，角标不再重复局数/本场/供托/余牌） */
function renderField() {
  const f = fieldInfo(state.view);
  const dora = f.doraIndicators.map((d) => tileHtml(d.code, "tile--sm")).join("");
  const connText = { idle: "未连接", connecting: "连接中", open: "实时", reconnecting: "重连中", closed: "已断开", error: "连接异常" }[
    state.conn
  ];
  $("field").innerHTML = `
    <span class="fc-item f-dora">宝牌指示 ${dora}</span>
    <span class="fc-item fc-hint" title="牌型提醒槽位：待接裁判引擎听牌/向听数据（另行立项）">牌型提醒 · 预留</span>
    ${stopBtnHtml()}
    <span class="conn" data-on="${state.conn === "open" ? 1 : 0}">● ${esc(connText)}</span>`;
}

/** #1564-6：停局入口（POST /stop）——终局/进行中均可停，防真人离桌 runaway 烧 token */
function stopBtnHtml() {
  return '<button type="button" class="btn btn--ghost" data-do="stop">停局</button>';
}

function renderPlayers(strips, table) {
  const top = strips.top;
  const right = strips.right;
  $("kamicha").innerHTML = stripBlockHtml(top) + `<div class="discards river" aria-label="上家牌河">${riverHtml(table.top)}</div>`;
  $("shimocha").innerHTML = stripBlockHtml(right) + `<div class="discards river" aria-label="下家牌河">${riverHtml(table.right)}</div>`;
  $("kamicha").classList.toggle("is-current", !!top?.isCurrent);
  $("shimocha").classList.toggle("is-current", !!right?.isCurrent);
  $("kamicha").classList.toggle("is-riichi", !!top?.riichi);
  $("shimocha").classList.toggle("is-riichi", !!right?.riichi);
}

/** 中央信息盘：局数/本场/供托/余牌（D3 场况主显示落桌心，与左上角标分工） */
function renderHub(hub) {
  $("hubSeries").textContent = hub.windLabel;
  $("hubRound").textContent = hub.roundLabel;
  $("hubRow").innerHTML = `
    <span class="ih-item">${esc(hub.honbaLabel)}</span>
    <span class="ih-item" title="供托" aria-label="供托 ${esc(String(hub.sticks))}">${
      hub.sticks > 0 ? `<i class="stick"></i>×${hub.sticks}` : esc(hub.sticksLabel)
    }</span>
    <span class="ih-item"><b>${esc(hub.wallLabel)}</b></span>`;
}

function renderSelf(strips, table) {
  const p = strips.self;
  const info = $("selfInfo");
  info.classList.toggle("is-current", !!p?.isCurrent);
  info.classList.toggle("is-riichi", !!p?.riichi);
  info.innerHTML = p
    ? pinfoInnerHtml(p) + (p.isSpectator ? '<span class="badge badge--kind">观战</span>' : "")
    : "";
  $("selfMelds").innerHTML = p ? meldZoneHtml(p) : "";
  $("riverSelf").innerHTML = table.self ? riverHtml(table.self) : "";
}

function renderHand(strips) {
  const me = strips.self;
  if (!me || !me.hand.visible) {
    $("hand").innerHTML = '<span class="kita-label">观战——三家牌面可见，不能出牌</span>';
    return;
  }
  const dp = state.view.decision;
  const drawn = dp && dp.kind === "turn" && dp.seat === state.seat ? dp.drawn : null;
  // 刚摸的张按惯例陈列在手牌右端（不能用 code 全匹配——同码张会被一并标成“刚摸的”）
  const list = [...me.hand.tiles];
  const di = drawn ? list.findIndex((t) => t.code === drawn) : -1;
  const drawnTile = di >= 0 ? list.splice(di, 1)[0] : null;
  const html = (t, extra) => {
    const st = tileState(state.view, state.seat, state.ui, t.code);
    const cls = ["tile", "tile--lg", st.clickable ? "is-clickable" : "is-dim", extra, state.ui.mode && st.clickable ? "is-selected" : ""]
      .filter(Boolean)
      .join(" ");
    const tip = st.clickable ? tileLabel(t.code) : st.reason;
    return `<button type="button" class="${cls}" data-code="${esc(t.code)}" ${st.clickable ? "" : "disabled"} title="${esc(
      tip,
    )}" aria-label="${esc(tileLabel(t.code))}">${esc(t.glyph)}</button>`;
  };
  $("hand").innerHTML = list.map((t) => html(t, "")).join("") + (drawnTile ? html(drawnTile, "is-drawn") : "");
}

function renderActions() {
  const bar = actionBar(state.view, state.seat, state.ui);
  const wait = state.view?.awaitingHuman;
  const timer =
    wait && wait.seat === state.seat
      ? `<span class="timer" data-deadline="${esc(wait.deadline)}"></span>`
      : "";
  const buttons = bar.buttons
    .map((b) => {
      const cls = ["btn", b.tone ? `btn--${b.tone}` : "", b.active ? "is-active" : ""].filter(Boolean).join(" ");
      return `<button type="button" class="${cls}" data-btn="${esc(b.id)}">${esc(b.label)}</button>`;
    })
    .join("");
  $("actionbar").innerHTML = `${buttons}<span class="hint">${esc(bar.hint)}</span>${timer}`;
}

/** 桌心三件套：claim 浮层 / 结算停驻（与信息盘互斥）/ 轮到谁 */
function renderCenter() {
  renderClaim();
  renderSettle();
  renderTurnStatus();
}

/** claim 浮层：盖桌心（pointer-events 收在卡片上，动作栏/手牌不被拦） */
function renderClaim() {
  const dp = state.view.decision;
  const claim = $("claim");
  if (dp && dp.kind === "claim" && dp.claim) {
    const from = state.view.players.find((p) => p.seat === dp.claim.discardSeat);
    claim.hidden = false;
    claim.innerHTML = `<div class="claim-card">
      <div class="claim-from">${esc(from?.name ?? dp.claim.discardSeat)} 打出</div>
      <div class="claim-tile">${esc(tileGlyph(dp.claim.discardTile))}</div>
      <div class="claim-from">${esc(tileLabel(dp.claim.discardTile))}</div>
      <div class="claim-tip">要不要——用下方动作栏选择</div>
    </div>`;
  } else {
    claim.hidden = true;
    claim.innerHTML = "";
  }
}

/**
 * 结算停驻：占中央信息盘位（对局=信息盘，结算=结算面板，互斥切换由 felt[data-state] 驱动）。
 * #1564-5 口径不变：局终展示结算 + 「继续」按钮；终局由 gameover 分支接管。
 */
function renderSettle() {
  const el = $("settlePanel");
  const settle = state.streamSettle ?? settlementFromView(state.view);
  let html = "";
  if (settle && settle.kind === "gameover") {
    html = `<h3>终局 · 东风战结束</h3>${settle.ranking
      .map(
        (r, i) =>
          `<div class="settle-row"><span>${i + 1}. ${esc(r.name)}</span><span>${esc(r.points)} 点</span></div>`,
      )
      .join("")}`;
  } else if (settle) {
    // 末局（东风战第 4 局）继续 = 进终局，文案如实（检视建议6）
    const canContinue = state.view?.status === "playing";
    const continueLabel = (state.view?.roundNo ?? 0) >= 4 ? "查看终局 →" : "继续下一局 →";
    html = `<h3>${esc(settle.title)}</h3>${settleHtml(settle)}` +
      (canContinue ? `<div class="settle-more"><button class="btn" data-do="settle-continue">${esc(continueLabel)}</button></div>` : "");
  } else if (state.view.status === "finished") {
    html = "<h3>本局结束</h3>";
  }
  const showing = Boolean(html);
  el.innerHTML = html;
  el.hidden = !showing;
  $("felt").dataset.state = showing ? "settle" : "play";
}

/** 轮到谁（信息盘内；结算停驻时信息盘隐藏，各归其位不互相覆盖） */
function renderTurnStatus() {
  const dp = state.view.decision;
  const status = $("turnStatus");
  if (state.view.status === "finished") {
    status.innerHTML = "<div>本局结束</div>";
    return;
  }
  if (dp) {
    const who = state.view.players.find((p) => p.seat === dp.seat);
    status.innerHTML = dp.seat === state.seat ? "<div><b>轮到你了</b></div>" : `<div>等 <b>${esc(who?.name ?? dp.seat)}</b> …</div>`;
  } else {
    status.innerHTML = "<div>牌局推进中…</div>";
  }
}

/** 聊天/日志流（底部通栏左格；v3 无折叠态，DOM 序=新在前，横排左端永远是最新） */
function renderLog() {
  $("log").innerHTML = state.log
    .slice(0, 40)
    .map((e) => `<li class="${e.cls}">${esc(e.text)}</li>`)
    .join("");
}

function settlementFromView(view) {
  if (!view.settlement) return null;
  const s = view.settlement;
  const kindCn = { tsumo: "自摸", ron: "荣和", noten: "流局", abortive: "流局" }[s.kind] ?? s.kind;
  return {
    kind: "settlement",
    title: kindCn + (s.abortive ? `（${s.abortive}）` : ""),
    deltas: s.deltas ?? [],
    winners: s.winners ?? [],
    yakuSummary: s.yakuSummary ?? [],
    tenpai: s.tenpai ?? null,
    ranking: null,
  };
}

function settleHtml(s) {
  const rows = state.view.players
    .map((p, i) => {
      const d = s.deltas[i] ?? 0;
      const win = s.winners.includes(p.seat) ? " ★" : "";
      const cls = d > 0 ? "up" : d < 0 ? "down" : "";
      return `<div class="settle-row"><span>${esc(p.name)}${esc(win)}</span><span class="${cls}">${d > 0 ? "+" : ""}${d}</span></div>`;
    })
    .join("");
  const yaku = s.yakuSummary.length
    ? `<div class="settle-yaku">${s.yakuSummary
        .map((y) => `${esc(state.view.players[y.seat]?.name ?? y.seat)}：${esc(y.yakus.join("·"))} ${y.han} 番`)
        .join("｜")}</div>`
    : "";
  return `<div>${rows}</div>${yaku}`;
}

function render() {
  document.getElementById("app").dataset.state = state.screen;
  // #1532：聊天条只在牌局页且入座后可见（观战/大厅隐藏——发言必须有合法 seat）
  const chatBar = document.getElementById("chatBar");
  if (chatBar) chatBar.hidden = state.screen !== "room" || state.seat === null;
  if (state.screen === "room" && state.view) {
    // 桌心模型一次推导，四处消费（玩家条/牌河/信息盘）——避免同轮渲染里重复推导出不一致
    const strips = stripsByPosition(state.view, state.seat);
    const table = riverTable(state.view, state.seat);
    renderField();
    renderHub(table.hub);
    renderPlayers(strips, table);
    renderSelf(strips, table);
    renderHand(strips);
    renderActions();
    renderCenter();
    renderLog();
  }
  renderOverlay();
  renderToast();
}

// ───────────────────────── 遮罩 ─────────────────────────

function renderOverlay() {
  const box = $("overlayBox");
  if (!state.overlay) {
    $("overlay").hidden = true;
    box.innerHTML = "";
    return;
  }
  $("overlay").hidden = false;
  if (state.overlay === "missing") {
    box.innerHTML = `
      <h2>没有找到这局牌</h2>
      <p>房间 <code>${esc(state.roomId)}</code> 不在内存里，也没在库里。</p>
      <div class="row">
        <button type="button" class="btn btn--primary" data-do="recover">尝试断线恢复</button>
        <button type="button" class="btn btn--ghost" data-do="lobby">回大厅建房</button>
      </div>`;
    return;
  }
  if (state.overlay === "join") {
    const cards = state.view.players
      .map(
        (p) => `
        <button type="button" class="seat-card" data-do="join" data-seat="${p.seat}">
          <span class="s-name">${esc(SEAT_CN[p.seat] ?? p.seat)}家 · ${esc(p.name)}</span>
          <span class="s-pts">${p.points} 点</span>
          <span class="s-taken">${p.kind === "human" ? "等真人入座" : p.kind === "otter" ? "獭（LLM）" : "陪打（规则代理）"}</span>
        </button>`,
      )
      .join("");
    box.innerHTML = `
      <h2>入座 · ${esc(state.roomId)}</h2>
      <p>选一座坐下（座位选择只存在这台浏览器里），或者先进来观战。</p>
      <div class="seat-pick">${cards}</div>
      <div class="row">
        <button type="button" class="btn btn--ghost" data-do="spectate">先观战</button>
        <button type="button" class="btn btn--muted" data-do="copy">复制邀请链接</button>
        <button type="button" class="btn btn--muted" data-do="lobby">回大厅</button>
      </div>`;
    return;
  }
  if (state.overlay === "lobby" || state.screen === "lobby") {
    box.innerHTML = lobbyHtml();
  }
  if (state.overlay === "created") {
    box.innerHTML = `
      <h2>开局成功</h2>
      <p>把链接发给搭档，对方打开就能入座：</p>
      <div class="row"><input readonly value="${esc(location.origin + "/mahjong/" + state.roomId)}" id="inviteLink"></div>
      <div class="row">
        <button type="button" class="btn btn--primary" data-do="enter">进牌桌</button>
        <button type="button" class="btn btn--ghost" data-do="copyLink">复制链接</button>
      </div>`;
    return;
  }
  // F20261022mjls：等待房遮罩——座位就绪况 + 「开始」按钮 + 换獭入口（开始前可自定义陪打獭）
  if (state.overlay === "waiting") {
    const lobby = state.view?.lobby;
    const seatRow = (p, i) => `
      <div class="seat-card">
        <span class="s-name">${SEAT_CN[p.seat] ?? p.seat}家 · ${esc(p.name)}</span>
        <span class="s-otter">${
          p.kind === "human"
            ? "等真人入座（点开始后开打）"
            : p.kind === "proxy"
              ? "陪打（规则代理）"
              : p.otterId
                ? `獭（LLM）· ${esc(p.otterId)}`
                : "獭（LLM）· 开始时用默认陪打獭"
        }</span>
        ${p.kind !== "human" && p.kind !== "proxy" ? `
        <label class="s-pick">换獭 otterId
          <input data-lobby-otter="${i}" value="${esc(p.otterId ?? "")}" placeholder="留空 = 用默认陪打獭">
        </label>` : ""}
      </div>`;
    box.innerHTML = `
      <h2>等待开始 · ${esc(state.roomId)}</h2>
      <p>座位就绪后点「开始」才发牌起跑（1 小时未开始自动清房）。可先把链接发给入座的人。</p>
      <div class="seat-pick">${(lobby?.players ?? []).map(seatRow).join("")}</div>
      <div class="row"><input readonly value="${esc(location.origin + "/mahjong/" + state.roomId)}" id="inviteLink"></div>
      <div class="row">
        <button type="button" class="btn btn--primary" data-do="start-game">开始</button>
        <button type="button" class="btn btn--ghost" data-do="copyLink">复制邀请链接</button>
        <button type="button" class="btn btn--muted" data-do="lobby">回大厅</button>
      </div>`;
    return;
  }
}

function lobbyHtml() {
  const seatRow = (i) => `
    <label>座位 ${SEAT_CN[i]}
      <select data-seat-kind="${i}">
        <option value="human">真人（我）</option>
        <option value="otter">獭（LLM）</option>
        <option value="proxy">陪打（规则代理）</option>
      </select>
    </label>
    <label>名字
      <input data-seat-name="${i}" value="${i === 0 ? "你" : `獭${i}`}">
    </label>
    <label data-otter-field="${i}" ${i === 0 ? "" : "hidden"}>otterId（留空 = 开始时用默认陪打獭）
      <input data-seat-otter="${i}" placeholder="otter id（可留空）">
    </label>`;
  return `
    <h2>开一局三麻</h2>
    <p>东风战 · 35000 点起 · 1 真人 + 2 獭（或陪打）。建房只开等待房，进牌桌点「开始」才发牌（F20261022mjls）。</p>
    <div class="row">${[0, 1, 2].map(seatRow).join("")}</div>
    <div class="row">
      <label>seed（可选，牌谱可复现）
        <input id="seedInput" placeholder="留空则随机">
      </label>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-do="create">建房（开等待房）</button>
      <button type="button" class="btn btn--ghost" data-do="presetProxy">全部陪打（先试跑）</button>
      <button type="button" class="btn btn--muted" data-do="close">取消</button>
    </div>`;
}

function renderToast() {
  const t = $("toast");
  if (!state.notice) {
    t.hidden = true;
    return;
  }
  t.hidden = false;
  t.textContent = state.notice;
}

let toastTimer = null;
function toast(msg) {
  state.notice = msg;
  renderToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.notice = "";
    renderToast();
  }, 4000);
}

function pushLog(text, cls = "") {
  state.log.unshift({ text, cls });
  if (state.log.length > 60) state.log.pop();
}

// ───────────────────────── 数据 ─────────────────────────

async function refreshView() {
  if (state.screen !== "room") return;
  try {
    const view = await api.view(state.roomId, state.seat);
    state.view = view;
    render();
  } catch (e) {
    if (e.status === 404) {
      state.overlay = "missing";
      render();
    }
    throw e;
  }
}

async function dispatch(action) {
  if (state.busy || !state.view) return;
  state.busy = true;
  try {
    const res = await api.action(state.roomId, state.seat, action);
    state.view = res.view;
    state.ui = { mode: null };
    state.streamSettle = null;
    pushLog(`你：${describeAction(action)}`);
    render();
    await safeRefresh();
  } catch (e) {
    toast(e.message || "动作没被接受");
    await safeRefresh();
  } finally {
    state.busy = false;
    render();
  }
}

/** 拉视图的吞错版：失败已由 refreshView 的 404 遮罩/本层 toast 负责，不让它冒泡打断交互 */
async function safeRefresh() {
  try {
    await refreshView();
  } catch {
    /* 已处置 */
  }
}

function describeAction(a) {
  switch (a.type) {
    case "discard":
      return `打 ${tileLabel(a.tile)}${a.riichi ? "（立直）" : ""}`;
    case "tsumo":
      return "自摸";
    case "ron":
      return "荣和";
    case "pon":
      return "碰";
    case "daiminkan":
      return "明杠";
    case "ankan":
      return `暗杠 ${tileLabel(a.kind)}`;
    case "kakan":
      return `加杠 ${tileLabel(a.tile)}`;
    case "kita":
      return "拔北";
    case "ryuukyoku":
      return "九种九牌流局";
    case "pass":
      return "跳过";
    default:
      return a.type;
  }
}

async function createRoom(cfg) {
  const res = await api.createRoom(cfg);
  state.roomId = res.roomId;
  history.pushState({}, "", `/mahjong/${encodeURIComponent(res.roomId)}`);
  pushLog(`房间 ${res.roomId} 已创建（seed ${res.seed}）——等待点「开始」开局`, "is-wake");
  // 建房者坐在配置为真人的那一座；全是獭/陪打则观战
  const mySeat = cfg.players.findIndex((p) => p.kind === "human");
  await enterRoom(mySeat >= 0 ? mySeat : null, { created: true });
}

/**
 * 进牌桌：seat=null 表示观战（手牌全览）。
 * opts.join  = 首次到访、本浏览器没选过座 → 拉视图后停在入座遮罩
 * opts.created = 刚建完房 → 停在“开局成功 + 邀请链接”遮罩
 */
async function enterRoom(seat, opts = {}) {
  state.seat = seat ?? null;
  if (state.seat === null) sessionStorage.removeItem(state.seatKey());
  else sessionStorage.setItem(state.seatKey(), String(state.seat));
  try {
    // 方案模块四流程：join 入座（拿该座私有视图）→ start 幂等开局确认
    const entered = state.seat === null ? await api.view(state.roomId, null) : await api.join(state.roomId, state.seat);
    state.view = entered.view ?? entered;
    // F20261022mjls：不再自动 start——建房只开等待房，搭档点「开始」才开局（api.start 调用移至等待遮罩按钮）
    state.screen = "room";
    state.streamSettle = null;
    // F20261022mjls：waiting 房停在等待遮罩（开始按钮）；playing 直进牌桌；created 旧遮罩废弃
    const status = state.view?.status ?? "playing";
    // waiting 房：优先等待遮罩（开始按钮）——入座选择退后（start 前 seat 概念尚不生效）
    state.overlay = status === "waiting" ? "waiting" : opts.join ? "join" : null;
    pushLog(state.seat === null ? "进入观战" : `你坐上${SEAT_CN[state.seat]}家`);
    render();
    startStream();
  } catch (e) {
    if (e.status === 404) {
      state.overlay = "missing";
      state.screen = "missing";
      render();
      return;
    }
    toast(e.message || "载入失败");
  }
}

// ───────────────────────── 事件 ─────────────────────────

function onHandClick(code) {
  const action = tileAction(state.view, state.seat, state.ui, code);
  if (!action) {
    toast("这张现在不能出");
    return;
  }
  dispatch(action);
}

function bindEvents() {
  $("hand").addEventListener("click", (e) => {
    const el = e.target.closest("[data-code]");
    if (el) onHandClick(el.dataset.code);
  });

  // 结算停驻的「继续」按钮已随结算面板迁至桌心（#settlePanel 在 #felt 内，故绑在台面上）
  $("felt").addEventListener("click", async (e) => {
    const el = e.target.closest('[data-do="settle-continue"]');
    if (!el) return;
    try {
      await api.continueRound(state.roomId);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });

  // #1564-6：停局按钮（场况栏）——confirm 后 POST /stop，成功回大厅
  $("field").addEventListener("click", async (e) => {
    const el = e.target.closest('[data-do="stop"]');
    if (!el) return;
    if (!window.confirm("确定停局？本局将立即终止（进行中/终局均可停）")) return;
    try {
      await api.stop(state.roomId);
      toast("已停局");
      goLobby();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });

  $("actionbar").addEventListener("click", (e) => {
    const el = e.target.closest("[data-btn]");
    if (!el) return;
    const bar = actionBar(state.view, state.seat, state.ui);
    const b = bar.buttons.find((x) => x.id === el.dataset.btn);
    if (!b) return;
    if (b.mode !== undefined) {
      state.ui = { mode: state.ui.mode === b.mode ? null : b.mode };
      render();
      return;
    }
    if (b.action) dispatch(b.action);
  });

  $("overlayBox").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-do]");
    if (!el) return;
    const what = el.dataset.do;
    if (what === "join") {
      await enterRoom(Number(el.dataset.seat));
    } else if (what === "spectate") {
      await enterRoom(null);
    } else if (what === "copy") {
      await copyText(location.href);
    } else if (what === "copyLink") {
      await copyText(location.origin + "/mahjong/" + state.roomId);
    } else if (what === "enter") {
      state.overlay = null;
      render();
    } else if (what === "lobby") {
      goLobby();
    } else if (what === "close") {
      state.overlay = null;
      render();
    } else if (what === "recover") {
      try {
        await api.recover(state.roomId);
        // recover 回执是 seats=null 全览视图——恢复后按自己座位重取私有视图（手牌可见性不降级）
        state.view = await api.view(state.roomId, state.seat);
        state.screen = "room";
        state.overlay = null;
        pushLog("已从最新帧恢复", "is-wake");
        render();
        startStream();
      } catch (err) {
        toast(err.message || "恢复失败：这局不在库里");
      }
    } else if (what === "create") {
      await onCreate();
    } else if (what === "start-game") {
      await onStartGame();
    } else if (what === "presetProxy") {
      document.querySelectorAll("[data-seat-kind]").forEach((s) => {
        if (s.dataset.seatKind !== "0") s.value = "proxy";
      });
      toast("已把 1/2 号位设为陪打（规则代理，不开 LLM）");
    }
  });

  $("overlayBox").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-seat-kind]");
    if (!sel) return;
    const field = document.querySelector(`[data-otter-field="${sel.dataset.seatKind}"]`);
    if (field) field.hidden = sel.value !== "otter";
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.ui.mode) {
      state.ui = { mode: null };
      render();
    }
  });

  // #1532：聊天发送（回显靠 SSE chat 帧，不本地假回显——断线时不会自己骗自己）
  // 在途防抖（检视发现5）：首请求未返回前再触发直接丢弃——双击 Enter/按钮不会发重复消息
  let chatSending = false;
  const sendChat = async () => {
    if (chatSending) return;
    const input = $("chatInput");
    const text = input.value.trim();
    if (!text || state.seat === null) return;
    chatSending = true;
    try {
      await api.chat(state.roomId, state.seat, text);
      input.value = "";
    } catch (err) {
      toast(err.message || "发送失败");
    } finally {
      chatSending = false;
    }
  };
  $("chatSend").addEventListener("click", sendChat);
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendChat();
    }
  });
}

async function onCreate() {
  const pick = (i) => {
    const kind = document.querySelector(`[data-seat-kind="${i}"]`)?.value ?? "proxy";
    const name = document.querySelector(`[data-seat-name="${i}"]`)?.value?.trim() || `座位${i}`;
    const otterId = document.querySelector(`[data-seat-otter="${i}"]`)?.value?.trim();
    return { kind, name, ...(kind === "otter" && otterId ? { otterId } : {}) };
  };
  const players = [pick(0), pick(1), pick(2)];
  const seed = document.getElementById("seedInput")?.value?.trim();
  try {
    await createRoom({ ...(seed ? { seed } : {}), players });
  } catch (e) {
    toast(e.message || "建房失败（房间号重复会 409）——开始时可换獭重试");
  }
}

/** F20261022mjls：等待房「开始」——收集换獭输入，POST /start（带 players 覆盖）后进牌桌 */
async function onStartGame() {
  const lobbyPlayers = state.view?.lobby?.players ?? [];
  const pick = (i) => {
    const cur = lobbyPlayers[i];
    if (!cur) return null;
    if (cur.kind === "human" || cur.kind === "proxy") return { kind: cur.kind, name: cur.name };
    const override = document.querySelector(`[data-lobby-otter="${i}"]`)?.value?.trim();
    const otterId = override || cur.otterId;
    return otterId ? { kind: "otter", name: cur.name, otterId } : { kind: "otter", name: cur.name };
  };
  const players = [pick(0), pick(1), pick(2)].filter(Boolean);
  const needOverride = players.some((p, i) => {
    const cur = lobbyPlayers[i];
    return JSON.stringify(p) !== JSON.stringify(cur ? { kind: cur.kind, name: cur.name, ...(cur.otterId ? { otterId: cur.otterId } : {}) } : p);
  });
  try {
    const res = await api.start(state.roomId, needOverride ? { players } : undefined);
    const view = res.view;
    if (view) state.view = state.seat === null ? view : await api.view(state.roomId, state.seat);
    state.overlay = null;
    pushLog("牌局开始", "is-wake");
    render();
    startStream();
  } catch (e) {
    toast(e.message || "开始失败（獭不可用或房间已清理）");
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制：" + text);
  } catch {
    toast("复制失败，请手动选中：" + text);
  }
}

function goLobby() {
  stopStream();
  state.screen = "lobby";
  state.roomId = null;
  state.seat = null;
  state.view = null;
  state.overlay = "lobby";
  history.pushState({}, "", "/mahjong");
  document.title = "獭桌三麻";
  render();
}

function onPopState() {
  route();
}

// ───────────────────────── 启动 ─────────────────────────

function route() {
  const m = location.pathname.match(/^\/mahjong(?:\/([^/]+))?\/?$/);
  const roomId = m && m[1] ? decodeURIComponent(m[1]) : null;
  if (!roomId) {
    state.screen = "lobby";
    state.roomId = null;
    state.seat = null;
    state.overlay = "lobby";
    render();
    return;
  }
  state.roomId = roomId;
  document.title = `獭桌三麻 · ${roomId}`;
  const stored = sessionStorage.getItem(state.seatKey());
  // 没选过座 → 先以观战拉视图（座位卡要渲染玩家表），停在入座遮罩；显式选过观战（"null"）不重复弹
  let seat = null;
  if (stored !== null && stored !== "null") seat = Number(stored);
  const seatOk = Number.isInteger(seat);
  enterRoom(seatOk ? seat : null, { join: stored === null });
}

let streamHandle = null;
async function startStream() {
  if (streamHandle) return;
  state.conn = "connecting";
  renderField();
  const { connect } = await import("./sse.js");
  streamHandle = connect({
    roomId: state.roomId,
    onStatus: (s) => {
      state.conn = s;
      renderField();
      // 断线重连（含 recover 后）回到 open → 立刻补拉一次视图，避免断线期间的画面停在旧帧
      if (s === "open") safeRefresh();
    },
    onEvent: handleStreamEvent,
  });
}

function stopStream() {
  if (streamHandle) streamHandle.close();
  streamHandle = null;
  state.conn = "closed";
}

function handleStreamEvent(ev) {
  if (!ev) return;
  if (ev.type === "game") {
    const engineEvents = ev.events ?? [];
    const settle = settlementModel(engineEvents);
    if (settle) state.streamSettle = settle;
    else if (engineEvents.some((e) => e.type === "deal")) state.streamSettle = null;
    if (ev.wake?.speech) pushLog(`${ev.wake.via}：${ev.wake.speech}`, "is-wake");
    // #1564-1：内部降级细节（fallbackReason）不进对局日志——只给中性「代打」标签
    else if (ev.wake && (ev.wake.via === "fallback" || ev.wake.via === "timeout-fallback")) pushLog("（代打）");
    safeRefresh();
    return;
  }
  if (ev.type === "chat") {
    // #1532：chat 帧回显（自己/他者/獭回应同流）——聊天不改视图，直接重渲染日志
    pushLog(formatChatLine(ev, state.seat), "is-chat");
    render();
    return;
  }
  if (ev.type === "human-wait") {
    pushLog(`等你出牌（${new Date(ev.deadline).toLocaleTimeString()} 前）`);
    safeRefresh();
    return;
  }
  if (ev.type === "error") {
    pushLog(`服务端：${ev.message}`, "is-err");
    toast(ev.message);
  }
}

function tickTimer() {
  const el = document.querySelector("[data-deadline]");
  if (!el) return;
  const left = Math.max(0, Math.ceil((new Date(el.dataset.deadline).getTime() - Date.now()) / 1000));
  el.textContent = `倒计时 ${left}s`;
  if (left <= 0) el.style.color = "var(--danger)";
}

function boot() {
  bindEvents();
  window.addEventListener("popstate", onPopState);
  setInterval(tickTimer, 300);
  route();
  if (state.screen === "room") render();
}

boot();
