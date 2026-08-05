/**
 * F20260805rbrg: BOSS 直聘桥接扩展 - background service worker
 *
 * 职责：
 *   1. chrome.alarms 定时调度（30min ± 5min 抖动）
 *   2. minimized window 自动管理（开/复用/空闲关）
 *   3. webRequest 监听 `/wapi/zpchat/` URL 抓 bossId
 *   4. 转发 content script 的扫描结果到 otter-buddy inbound
 *   5. 桥接状态可观测：scan/forward/history 异常按 severity 上报
 *   6. otter 不可达兜底：badge + chrome.notifications + 本地缓冲补发
 *   7. 反爬检测（about:blank）→ critical + 暂停扫描
 */

const BOSS_CHAT_URL = "https://www.zhipin.com/web/geek/chat";
const STORAGE = chrome.storage.local;
const ALARM_NAME = "boss-bridge-poll";
const CAPTURE_KEY = "boss-bridge-captured-urls";
const STATUS_DEDUP_KEY = "boss-bridge-status-dedup";
const FORWARD_BUFFER_KEY = "boss-bridge-forward-buffer";
const WATERLINE_KEY = "boss-bridge-waterline"; // { [bossId]: lastSeenMsgTime }
const BOSSID_CACHE_KEY = "boss-bridge-bossid-cache"; // { [bossId]: { hrName, company } }
const ERROR_COUNTERS_KEY = "boss-bridge-error-counters"; // { scan-zero-unexpected: N, scan-ok-0: N, forward-failed: N }
const EXT_WINDOW_FLAG = "boss-bridge-managed-window"; // tab tag
const MAX_BUFFERED = 100;
const MAX_CAPTURED = 200;
const SCAN_DWELL_MS = 25_000; // 等 SPA bootstrap
const POST_CLICK_WAIT_MS = 8_000; // 等 historyMsg 响应
const MAX_CLICKS_PER_CYCLE = 5; // 反爬缓解
const CLICK_INTERVAL_MS_MIN = 1000;
const CLICK_INTERVAL_MS_MAX = 3000;
const IDLE_CLOSE_MS = 2 * 60 * 60 * 1000; // 2h 空闲关 tab

// 内存：最近 historyMsg 调用的 bossId + timestamp（5 分钟滚动窗口）
const recentHistoryMsgs = []; // [{ bossId, ts }]
function recordHistoryMsg(bossId) {
  const now = Date.now();
  recentHistoryMsgs.push({ bossId, ts: now });
  while (recentHistoryMsgs.length && now - recentHistoryMsgs[0].ts > 300_000) {
    recentHistoryMsgs.shift();
  }
}
function getRecentBossIds(withinMs) {
  const cutoff = Date.now() - withinMs;
  return recentHistoryMsgs.filter(r => r.ts >= cutoff).map(r => r.bossId);
}

// ─────────────────────────────────────────────────────────────
// webRequest 监听：捕获 BOSS API 调用 + bossId
// ─────────────────────────────────────────────────────────────
chrome.webRequest.onBeforeRequest?.addListener(
  (details) => {
    if (!details.url || !details.url.includes("zhipin.com")) return;
    if (!details.url.includes("/wapi/zpchat/") && !details.url.includes("historyMsg")) return;

    let bossId = null;
    try {
      const u = new URL(details.url);
      bossId = u.searchParams.get("bossId");
    } catch {}

    const captured = { at: new Date().toISOString(), url: details.url, bossId };
    console.log("[boss-bridge][webRequest]", captured);
    appendCapture(captured);

    if (bossId) recordHistoryMsg(bossId);
  },
  { urls: ["https://www.zhipin.com/*", "https://*.zhipin.com/*"] },
);

function appendCapture(entry) {
  STORAGE.get([CAPTURE_KEY], (res) => {
    const list = res[CAPTURE_KEY] ?? [];
    list.push(entry);
    while (list.length > MAX_CAPTURED) list.shift();
    STORAGE.set({ [CAPTURE_KEY]: list });
  });
}

// ─────────────────────────────────────────────────────────────
// alarm 调度：30min ± 5min 抖动
// ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // 用随机 periodInMinutes（30-35 之间），每次 fire 后重新设置
  rescheduleAlarm();
  console.log("[boss-bridge] installed");
});
chrome.runtime.onStartup?.addListener(() => {
  rescheduleAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  runScanCycle().catch(err => {
    console.error("[boss-bridge] scan cycle failed", err);
    reportStatus({ type: "scan-failed", severity: "warning", detail: String(err?.message || err) });
  }).finally(() => rescheduleAlarm());
});

function rescheduleAlarm() {
  const periodMin = 30 + Math.random() * 5; // 30-35 分钟
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: periodMin, periodInMinutes: periodMin });
}

// 扩展图标点击 = 立即扫描一次（不影响下次 alarm 时间）
chrome.action.onClicked.addListener(() => {
  runScanCycle().catch(err => {
    console.error("[boss-bridge] manual scan failed", err);
  });
});

// ─────────────────────────────────────────────────────────────
// 扫描主流程
// ─────────────────────────────────────────────────────────────
async function runScanCycle() {
  console.log("[boss-bridge] scan cycle start");
  await setScanPhase("开始扫描（检查反爬暂停标志）");

  // 反爬暂停标志：上一次 critical 后等用户手动恢复
  const flags = await STORAGE.get(["paused-due-to-antibot"]);
  if (flags["paused-due-to-antibot"]) {
    console.log("[boss-bridge] paused due to anti-bot, skip");
    await setScanPhase("已暂停（反爬）— 跳过");
    return { skipped: "paused" };
  }

  // 1. 拿 / 复用 / 创建 minimized window
  await setScanPhase("准备 BOSS tab");
  const tab = await getOrCreateBossTab();
  if (!tab) {
    await setScanPhase("失败：无法开 BOSS tab");
    return { error: "no-tab" };
  }

  // 2. 等 SPA 加载（首次/复用都需要点时间）
  await setScanPhase(`等 SPA 加载 25s（tab ${tab.id}）`);
  await sleep(SCAN_DWELL_MS);

  // 3. 检查 about:blank（反爬）
  const reloaded = await chrome.tabs.get(tab.id);
  await setScanPhase(`当前 tab URL: ${reloaded.url?.slice(0, 80)}`);
  if (!reloaded.url || reloaded.url === "about:blank" || reloaded.title === "") {
    await setScanPhase("反爬触发，暂停");
    await reportStatus({
      type: "anti-bot-detected",
      severity: "critical",
      detail: "BOSS 页面被重定向到 about:blank（疑似反爬触发）",
    });
    await STORAGE.set({ "paused-due-to-antibot": true });
    showBadge("!", [255, 0, 0]);
    return { error: "anti-bot" };
  }

  // 如果不是聊天页（如跳到登录页），content script 不会注入
  if (!reloaded.url.includes("/web/geek/chat")) {
    await setScanPhase(`非聊天页（URL=${reloaded.url.slice(0, 60)}），可能需要登录`);
    await reportStatus({
      type: "login-expired",
      severity: "critical",
      detail: `BOSS tab 跳到非聊天页（URL=${reloaded.url}），可能未登录或登录失效`,
    });
    return { error: "not-chat-page", url: reloaded.url };
  }

  // 4. 让 content script 扫 DOM，对未读会话主动 click 触发 historyMsg（拿到 bossId）
  await setScanPhase("扫 DOM + 模拟点击未读会话");
  const baseline = getRecentBossIds(60_000); // click 前 1 分钟的 bossId
  let scanResult;
  try {
    scanResult = await chrome.tabs.sendMessage(tab.id, { type: "scan-and-trigger" });
  } catch (err) {
    await setScanPhase(`失败：content script 没响应（${err.message}）。在 BOSS tab 上 Cmd+R 刷新一次`);
    await reportStatus({ type: "scan-failed", severity: "warning", detail: `content script error: ${err.message}` });
    return { error: "cs-error", detail: err.message };
  }

  if (!scanResult?.ok) {
    await setScanPhase(`扫描失败：${scanResult?.error || "unknown"}`);
    await reportStatus({ type: "scan-failed", severity: "warning", detail: scanResult?.error || "unknown" });
    return { error: scanResult?.error || "scan-failed" };
  }

  // 5. 等 click 触发的 historyMsg 响应
  await setScanPhase(`扫到 ${scanResult.conversations.length} 个会话，点击 ${scanResult.clickedCount} 个未读，等 8s`);
  await sleep(POST_CLICK_WAIT_MS);

  // 6. 拿 click 后的新 bossId 列表，对每个 bossId 调 historyMsg 拿全文
  const newBossIds = getRecentBossIds(60_000).filter(id => !baseline.includes(id));
  const allMessages = [];
  const waterline = (await STORAGE.get(WATERLINE_KEY))[WATERLINE_KEY] ?? {};

  for (let i = 0; i < newBossIds.length && i < MAX_CLICKS_PER_CYCLE; i++) {
    const bossId = newBossIds[i];
    const history = await chrome.tabs.sendMessage(tab.id, {
      type: "fetch-history",
      bossId,
    }).catch(err => ({ ok: false, error: err.message }));

    if (history?.ok && history.result?.parsed?.zpData?.messages) {
      const msgs = history.result.parsed.zpData.messages;
      const lastSeen = waterline[bossId] ?? null;
      const freshMsgs = lastSeen === null
        ? [] // 首次扫描该 bossId：只设水位线，不推历史消息
        : msgs.filter(m => m.time > lastSeen);

      if (freshMsgs.length > 0) {
        allMessages.push(...freshMsgs.map(m => ({
          externalId: `boss:${bossId}:${m.mid}`,
          bossId,
          mid: String(m.mid),
          hrName: scanResult.conversations.find(c => c.bossId === bossId)?.hrName || "未知HR",
          hrTitle: scanResult.conversations.find(c => c.bossId === bossId)?.hrTitle,
          company: scanResult.conversations.find(c => c.bossId === bossId)?.company || "未知公司",
          position: scanResult.conversations.find(c => c.bossId === bossId)?.position || "未知职位",
          content: extractMessageText(m),
          time: m.time,
        })));
      }

      // 更新水位线
      if (msgs.length > 0) {
        waterline[bossId] = Math.max(...msgs.map(m => m.time));
      }
    } else if (!history?.ok) {
      await reportStatus({
        type: "history-failed",
        severity: "warning",
        detail: `bossId=${bossId}: ${history?.error || "unknown"}`,
      });
    }

    // 反爬缓解：click 之间 1-3s 随机
    if (i < newBossIds.length - 1) {
      await sleep(CLICK_INTERVAL_MS_MIN + Math.random() * (CLICK_INTERVAL_MS_MAX - CLICK_INTERVAL_MS_MIN));
    }
  }

  await STORAGE.set({ [WATERLINE_KEY]: waterline });

  // 7. 扫描结果统计 + 升级规则
  await updateScanCounters(scanResult, allMessages);

  // 8. 转发到 otter
  if (allMessages.length > 0) {
    await forwardToOtter({ kind: "recruit", payload: { messages: allMessages } });
  } else {
    console.log("[boss-bridge] no new messages this cycle");
  }

  // 9. 更新最后扫描时间 + 空闲关闭检查
  await STORAGE.set({ "last-scan-at": Date.now() });
  await maybeCloseIdleTab();
}

// ─────────────────────────────────────────────────────────────
// minimized window 管理
// ─────────────────────────────────────────────────────────────
async function getOrCreateBossTab() {
  // 找已有的 BOSS chat tab
  const tabs = await chrome.tabs.query({ url: "https://www.zhipin.com/*" });
  const bossTabs = tabs.filter(t => t.url?.includes("/web/geek/chat"));

  if (bossTabs.length > 0) {
    // 复用第一个
    return bossTabs[0];
  }

  // 不存在 → 开 minimized window
  try {
    const win = await chrome.windows.create({
      url: BOSS_CHAT_URL,
      state: "minimized",
      focused: false,
    });
    const tab = win.tabs?.[0];
    if (!tab) {
      await reportStatus({ type: "tab-create-failed", severity: "warning", detail: "no tab in new window" });
      return null;
    }
    return tab;
  } catch (err) {
    await reportStatus({ type: "tab-create-failed", severity: "warning", detail: err.message });
    return null;
  }
}

async function maybeCloseIdleTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.zhipin.com/*" });
  const flags = await STORAGE.get(["last-scan-at", "paused-due-to-antibot"]);
  const lastScan = flags["last-scan-at"] ?? Date.now();
  if (Date.now() - lastScan > IDLE_CLOSE_MS && !flags["paused-due-to-antibot"]) {
    // 关闭自己开的 minimized window 里的 tab（避免关用户主动 pin 的）
    for (const t of tabs) {
      // 这里简化：只关明显是 minimized 的 window（不可见）
      try {
        const w = await chrome.windows.get(t.windowId);
        if (w.state === "minimized") {
          await chrome.tabs.remove(t.id);
        }
      } catch {}
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 转发到 otter-buddy
// ─────────────────────────────────────────────────────────────
async function forwardToOtter(payload) {
  const cfg = await STORAGE.get(["otterUrl", "otterKey", "source"]);
  const url = cfg.otterUrl;
  const key = cfg.otterKey;
  if (!url || !key) {
    console.warn("[boss-bridge] forward: otterUrl/otterKey not configured");
    return;
  }
  const source = cfg.source || "boss-zhipin-bridge";

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Inbound-Key": key },
      body: JSON.stringify({ source, kind: payload.kind, payload: payload.payload }),
    });

    if (resp.ok) {
      clearBadgeIfNoErrors();
      const counters = await STORAGE.get([ERROR_COUNTERS_KEY]);
      const c = counters[ERROR_COUNTERS_KEY] ?? {};
      c["forward-failed"] = 0;
      await STORAGE.set({ [ERROR_COUNTERS_KEY]: c });
      return;
    }

    // 503 = otter 还没就绪 → 缓冲，更长退避
    if (resp.status === 503) {
      console.warn("[boss-bridge] otter returned 503, buffering");
      await bufferForRetry(payload);
    } else {
      await incrementError("forward-failed");
    }
  } catch (err) {
    // 网络错误（otter 不可达）
    console.error("[boss-bridge] forward network error", err);
    await incrementError("forward-failed", payload);
  }
}

async function bufferForRetry(payload) {
  const data = await STORAGE.get([FORWARD_BUFFER_KEY]);
  const buf = data[FORWARD_BUFFER_KEY] ?? [];
  buf.push({ at: Date.now(), payload });
  while (buf.length > MAX_BUFFERED) buf.shift();
  await STORAGE.set({ [FORWARD_BUFFER_KEY]: buf });
}

async function incrementError(counterKey, payloadToBuffer = null) {
  const data = await STORAGE.get([ERROR_COUNTERS_KEY]);
  const c = data[ERROR_COUNTERS_KEY] ?? {};
  c[counterKey] = (c[counterKey] ?? 0) + 1;
  await STORAGE.set({ [ERROR_COUNTERS_KEY]: c });

  // 升级到 critical 的阈值
  if (counterKey === "forward-failed" && c[counterKey] >= 3) {
    if (payloadToBuffer) await bufferForRetry(payloadToBuffer);
    await reportStatus({
      type: "otter-unreachable",
      severity: "critical",
      detail: `连续 ${c[counterKey]} 次推送失败（otter 服务可能挂了）`,
    });
    showBadge("!", [255, 0, 0]);
    // 同时弹 Chrome 通知（otter 不可达时 otter 自己通知不了）
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: "BOSS 桥接: otter 不可达",
      message: `连续 ${c[counterKey]} 次推送 otter 失败。请检查 otter-buddy 是否在运行。`,
      priority: 2,
    });
  }
}

// 扫描结果统计 + 异常升级
async function updateScanCounters(scanResult, allMessages) {
  const data = await STORAGE.get([ERROR_COUNTERS_KEY]);
  const c = data[ERROR_COUNTERS_KEY] ?? {};

  if (scanResult.conversations.length === 0) {
    // DOM 选择器扫到 0 条 → 可能 BOSS 改版
    c["scan-zero-unexpected"] = (c["scan-zero-unexpected"] ?? 0) + 1;
    if (c["scan-zero-unexpected"] >= 3) {
      await reportStatus({
        type: "scan-zero-unexpected",
        severity: "critical",
        detail: "连续 3 次扫描 DOM 返回 0 条会话（约 90 分钟），可能 BOSS 改版了 .friend-content 选择器",
      });
    } else {
      await reportStatus({
        type: "scan-zero-unexpected",
        severity: "warning",
        detail: `扫描到 0 条会话（第 ${c["scan-zero-unexpected"]} 次）`,
      });
    }
  } else if (allMessages.length === 0) {
    c["scan-ok-0"] = (c["scan-ok-0"] ?? 0) + 1;
    c["scan-zero-unexpected"] = 0;
    if (c["scan-ok-0"] >= 48) {
      // 连续 48 次（约 24 小时）扫描 0 新消息 → 可能 BOSS 消息系统挂了或网络断了
      await reportStatus({
        type: "scan-ok-stale",
        severity: "warning",
        detail: `连续 48 次扫描零新消息（约 24 小时），可能 BOSS 消息系统异常或网络断了`,
      });
      c["scan-ok-0"] = 0; // 重置避免反复上报
    }
  } else {
    // 正常有消息
    c["scan-ok-0"] = 0;
    c["scan-zero-unexpected"] = 0;
  }
  await STORAGE.set({ [ERROR_COUNTERS_KEY]: c });
}

// ─────────────────────────────────────────────────────────────
// 状态事件上报（30 分钟去重 + 扩展端去重）
// ─────────────────────────────────────────────────────────────
async function reportStatus(event) {
  // info 不推到 otter
  if (event.severity === "info") {
    // 仅本地存（在 options 页可见）
    return;
  }

  // 30 分钟去重（key = type）
  const dedupKey = event.type;
  const data = await STORAGE.get([STATUS_DEDUP_KEY]);
  const dedup = data[STATUS_DEDUP_KEY] ?? {};
  const lastTs = dedup[dedupKey];
  if (lastTs && Date.now() - lastTs < 30 * 60 * 1000 && event.severity !== "critical") {
    return; // 跳过
  }
  dedup[dedupKey] = Date.now();
  await STORAGE.set({ [STATUS_DEDUP_KEY]: dedup });

  // 推到 otter
  await forwardToOtter({
    kind: "status",
    payload: { events: [{ ...event, at: new Date().toISOString() }] },
  });
}

// ─────────────────────────────────────────────────────────────
// badge 管理
// ─────────────────────────────────────────────────────────────
function showBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
function clearBadgeIfNoErrors() {
  STORAGE.get([ERROR_COUNTERS_KEY, FORWARD_BUFFER_KEY], (res) => {
    const c = res[ERROR_COUNTERS_KEY] ?? {};
    const buf = res[FORWARD_BUFFER_KEY] ?? [];
    const hasError = (c["forward-failed"] ?? 0) > 0 || buf.length > 0;
    if (!hasError) {
      chrome.action.setBadgeText({ text: "" });
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 把扫描阶段写到 storage，options 页能看到进度 */
async function setScanPhase(phase) {
  console.log("[boss-bridge] phase:", phase);
  await STORAGE.set({ "boss-bridge-scan-phase": phase });
}

function extractMessageText(msg) {
  if (!msg.body) return "(empty)";
  const t = msg.body.type;
  if (t === 1 && msg.body.text) return msg.body.text;
  if (t === 8 && msg.body.jobDesc) {
    const d = msg.body.jobDesc;
    return `[职位卡片] ${d.title || "?"} @ ${d.company || "?"} / 薪资 ${d.salary || "?"} / ${d.city || "?"}`;
  }
  if (t === 16) return `[系统通知] ${(msg.body.text || "") || "(无内容)"}`;
  return `[type=${t}] ${JSON.stringify(msg.body).slice(0, 100)}`;
}

// 用户在 BOSS 页面手动恢复后，content script 检测到页面正常 → 通知 background 恢复
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "manual-recovery-detected") {
    STORAGE.set({ "paused-due-to-antibot": false });
    clearBadgeIfNoErrors();
    reportStatus({ type: "scan-recovered", severity: "info", detail: "用户手动恢复，扫描继续" });
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "trigger-scan-now") {
    runScanCycle()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === "get-captured") {
    STORAGE.get([CAPTURE_KEY], (res) => sendResponse({ ok: true, list: res[CAPTURE_KEY] ?? [] }));
    return true;
  }
  if (msg?.type === "test-connection") {
    (async () => {
      try {
        // 优先用 options 页传来的当前输入框值；没有才回落到 storage
        let otterUrl = msg.otterUrl;
        let otterKey = msg.otterKey;
        if (!otterUrl || !otterKey) {
          const cfg = await STORAGE.get(["otterUrl", "otterKey"]);
          otterUrl = otterUrl || cfg.otterUrl;
          otterKey = otterKey || cfg.otterKey;
        }
        if (!otterUrl || !otterKey) {
          sendResponse({ ok: false, error: "otterUrl/otterKey 未配置" });
          return;
        }
        const resp = await fetch(otterUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Inbound-Key": otterKey },
          body: JSON.stringify({
            source: "boss-zhipin-bridge",
            kind: "status",
            payload: { events: [{ type: "extension-installed", severity: "warning", at: new Date().toISOString(), detail: "test-connection ping" }] },
          }),
        });
        sendResponse({ ok: resp.ok, status: resp.status, body: (await resp.text()).slice(0, 200) });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  return false;
});
