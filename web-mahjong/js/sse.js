/**
 * 房间粒度 SSE 订阅（F20261015mjsg 模块四·实时联动）。
 *
 * 端点：GET /api/mahjong/rooms/:roomId/events
 *   · 首帧 data {"type":"hello",roomId,gameId}
 *   · 其后 data 推送 RoomEvent：game / human-wait / error
 *   · 15s 注释心跳 `: ping`——EventSource 不把注释帧上抛给页面，所以这里另设
 *     看门狗：超过 idleTimeoutMs 没有任何 data 帧就主动断开重连（静默断链兜底）。
 *
 * 重连策略（手动重连，不依赖 EventSource 自带的固定重试）：
 *   指数退避；从第 2 次起先 POST /recover（最新帧还原 + 续推，进程重启后房间不在内存时的入口），
 *   成功再重开事件流。close() 后一切计时器与连接回收干净，不漏回调。
 *
 * EventSourceImpl / fetchImpl 可注入——单测用假 EventSource 驱动，不开真网络。
 */

const DEFAULT_BACKOFF = (attempt) => Math.min(500 * 2 ** attempt, 10_000);

/**
 * @param {{
 *   roomId: string,
 *   onEvent?: (ev: object) => void,
 *   onStatus?: (s: "connecting"|"open"|"reconnecting"|"error"|"closed") => void,
 *   EventSourceImpl?: typeof EventSource,
 *   fetchImpl?: typeof fetch,
 *   backoffMs?: (attempt: number) => number,
 *   idleTimeoutMs?: number,
 *   now?: () => number,
 *   urlBase?: string,
 * }} opts
 * @returns {{close: () => void, status: () => string, attempts: () => number}}
 */
export function connect(opts) {
  const {
    roomId,
    onEvent = () => {},
    onStatus = () => {},
    EventSourceImpl = globalThis.EventSource,
    fetchImpl = globalThis.fetch,
    backoffMs = DEFAULT_BACKOFF,
    idleTimeoutMs = 35_000,
    now = Date.now,
    urlBase = "",
  } = opts;

  const url = `${urlBase}/api/mahjong/rooms/${encodeURIComponent(roomId)}/events`;
  const recoverUrl = `${urlBase}/api/mahjong/rooms/${encodeURIComponent(roomId)}/recover`;

  let socket = null;
  let status = "connecting";
  let attempts = 0;
  let lastFrameAt = 0;
  let closed = false;
  let retryTimer = null;
  let watchdog = null;

  function setStatus(next) {
    if (closed && next !== "closed") return;
    if (status === next) return;
    status = next;
    onStatus(next);
  }

  function handleFrame(raw) {
    lastFrameAt = now();
    attempts = 0; // 收到帧 = 连接确实恢复，退避归零
    setStatus("open");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 心跳/坏帧不该打断牌局渲染
    }
    onEvent(parsed);
  }

  /** 断线后：进程重启场景房间不在内存，先走 recover 端点（最新帧还原 + 续推） */
  async function recover() {
    try {
      const res = await fetchImpl(recoverUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        setStatus("error");
        return false;
      }
      lastFrameAt = now();
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }

  function scheduleRetry() {
    if (closed) return;
    attempts += 1;
    setStatus("reconnecting");
    const delay = backoffMs(attempts);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      void open();
    }, delay);
  }

  async function open() {
    if (closed || !EventSourceImpl) return;
    setStatus(attempts === 0 ? "connecting" : "reconnecting");
    if (attempts >= 1) {
      const ok = await recover();
      if (!ok && closed) return;
    }
    if (closed) return;
    try {
      socket = new EventSourceImpl(url);
    } catch {
      scheduleRetry();
      return;
    }
    socket.onopen = () => {
      if (closed) return;
      lastFrameAt = now();
      setStatus("open");
    };
    socket.onmessage = (ev) => {
      if (!closed) handleFrame(ev.data);
    };
    socket.onerror = () => {
      if (closed) return;
      try {
        socket.close();
      } catch {
        /* 已断开 */
      }
      scheduleRetry();
    };
  }

  // 看门狗：服务端 15s 心跳是注释帧，EventSource 不上抛——静默断链只能自己量
  watchdog = setInterval(() => {
    if (closed || !lastFrameAt) return;
    if (now() - lastFrameAt > idleTimeoutMs) {
      try {
        socket?.close();
      } catch {
        /* 已断开 */
      }
      scheduleRetry();
    }
  }, Math.min(idleTimeoutMs, 10_000));

  void open();

  return {
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      try {
        socket?.close();
      } catch {
        /* 已断开 */
      }
      socket = null;
      setStatus("closed");
    },
    status: () => status,
    attempts: () => attempts,
  };
}
