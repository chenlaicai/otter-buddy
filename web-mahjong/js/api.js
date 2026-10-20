/**
 * 三麻 HTTP 面客户端——页面侧对 /api/mahjong 七个 JSON 端点的薄封装（SSE 见 sse.js）。
 *
 * 端点签名（真相源：docs/features/2026/10/15/F20261015mjsg-mahjong-sanma.md
 * 「实现记录（Engine 层）·页面獭接口面」）：
 *   POST /rooms · /rooms/:id/join · /rooms/:id/start · /rooms/:id/actions · /rooms/:id/recover
 *   GET  /rooms/:id/view?seat= · /rooms/:id/frames
 *
 * 约定：动作对象（action）必须原样透传，不做字段增删改写——HTTP 面要求
 * 「action 必须逐字来自 decision.actions」。
 */

function encodeRoom(roomId) {
  return encodeURIComponent(roomId);
}

/**
 * @param {{fetchImpl?: typeof fetch, base?: string}} [opts]
 */
export function createApi(opts = {}) {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const base = opts.base ?? "";

  async function call(path, options) {
    const res = await f(base + path, options);
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
    if (!res.ok) {
      const err = new Error((body && (body.error || body.message)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function post(path, payload) {
    return call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  }

  const room = (roomId, suffix) => `/api/mahjong/rooms/${encodeRoom(roomId)}${suffix}`;

  return {
    /** 建房即开局 → {roomId, gameId, seed, status}（201；已存在 409） */
    createRoom: (payload) => call("/api/mahjong/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    /** 入座 → {roomId, seat, view}（私有视图，含手牌） */
    join: (roomId, seat) => post(room(roomId, "/join"), { seat }),
    /** 开局幂等回执（未知房尝试 recover，仍无 → 404） */
    start: (roomId) => post(room(roomId, "/start")),
    /** 真人动作注入 → {accepted:true, view}（400 = 非该座停驻或动作非法） */
    action: (roomId, seat, action) => post(room(roomId, "/actions"), { seat, action }),
    /** 真人回话 → {accepted:true, roomId, seat, view}（#1532：入队广播 chat 帧，回显靠 SSE） */
    chat: (roomId, seat, text) => post(room(roomId, "/chat"), { seat, text }),
    /** #1564-5：结算停驻「继续下一局」 */
    continueRound: (roomId) => post(room(roomId, "/continue")),
    /** #1564-6：停局/删房 */
    stop: (roomId) => post(room(roomId, "/stop")),
    /** 断线恢复（最新帧还原 + 续推） */
    recover: (roomId) => post(room(roomId, "/recover")),
    /** 视图：seat 缺省 = 观战全览（三家手牌可见） */
    view: (roomId, seat) =>
      call(room(roomId, "/view") + (seat === undefined || seat === null ? "" : `?seat=${encodeURIComponent(seat)}`)),
    /** 复盘帧链 */
    frames: (roomId) => call(room(roomId, "/frames")),
  };
}
