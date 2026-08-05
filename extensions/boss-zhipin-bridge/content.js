/**
 * F20260805rbrg: BOSS 直聘桥接 - content script
 *
 * 跑在 https://www.zhipin.com/web/geek/chat 真实页面上下文里，共享页面 cookie/origin。
 * 职责：
 *   1. 扫 DOM 抽会话列表（HR 名、公司、职位、未读数）
 *   2. 对未读会话主动 click 触发 BOSS 自己调 historyMsg（让 background 的 webRequest 抓 bossId）
 *   3. 调 historyMsg REST 拿消息全文（页面上下文同源带 cookie）
 *   4. 检测 about:blank（反爬重定向）→ 通知 background 暂停
 *
 * 与 background 通信：通过 chrome.runtime.sendMessage
 */

(() => {
  "use strict";

  const LOG = "[boss-bridge-cs]";

  // 反爬跳 about:blank 检测
  if (location.href === "about:blank" || document.title === "") {
    console.warn(LOG, "anti-bot blank redirect detected");
    chrome.runtime.sendMessage({ type: "anti-bot-blank-detected" }).catch(() => {});
    return;
  }

  console.log(LOG, "loaded at", location.href);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "scan-and-trigger") {
      console.log(LOG, "scan-and-trigger");
      const result = scanAndTriggerClicks();
      sendResponse(result);
    } else if (msg?.type === "fetch-history") {
      console.log(LOG, "fetch-history bossId=", msg.bossId);
      fetchHistory(msg.bossId)
        .then(result => sendResponse({ ok: true, result }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    return true;
  });

  // ─────────────────────────────────────────────────────────────
  // 1. 扫 DOM + 模拟 click 触发未读会话
  // ─────────────────────────────────────────────────────────────
  function scanAndTriggerClicks() {
    // 反爬再检测
    if (location.href === "about:blank") {
      return { ok: false, error: "anti-bot-blank" };
    }

    let friends = document.querySelectorAll(".friend-content");
    if (friends.length === 0) {
      // fallback selectors（防 BOSS 改 class 名）
      const fallback = [".chat-friend-item", ".friend-item", "[class*='friend']", "[class*='conversation-item']"];
      for (const sel of fallback) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          console.log(LOG, "fallback selector hit:", sel, found.length);
          friends = found;
          break;
        }
      }
    }

    const conversations = [];
    for (let i = 0; i < friends.length; i++) {
      conversations.push(extractConversation(friends[i], i));
    }

    // 找未读 + 非 active 的会话主动 click（让 BOSS 调 historyMsg）
    const toClick = conversations
      .filter(c => c.unreadCount > 0 && !c.hasActive)
      .slice(0, 5); // 反爬缓解，最多 5 个

    console.log(LOG, `scan: ${conversations.length} convs, clicking ${toClick.length} unread`);
    toClick.forEach((conv, idx) => {
      setTimeout(() => {
        const el = friends[conv.index];
        if (el) {
          // 真实姿态：mousemove + mouseover + mousedown + mouseup + click
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const opts = {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy, button: 0, buttons: 1, detail: 1,
          };
          try {
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: cx, clientY: cy }));
            el.dispatchEvent(new MouseEvent("mouseover", opts));
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            el.dispatchEvent(new MouseEvent("click", opts));
            el.click();
          } catch (err) {
            console.warn(LOG, "click failed", conv, err);
          }
        }
      }, idx * 1500); // 1.5s 间隔
    });

    return { ok: true, conversations, clickedCount: toClick.length };
  }

  function extractConversation(el, idx) {
    const text = (sel) => el.querySelector(sel)?.textContent?.trim() ?? null;
    const hasClass = (regex) => regex.test(el.className || "");
    return {
      index: idx,
      // 文档基线字段
      hrName: text(".name") || text("[class*='name']"),
      company: text(".company") || text("[class*='company']"),
      position: text(".position") || text("[class*='position']") || text("[class*='title']"),
      hrTitle: text(".hr-title") || null,
      lastMessagePreview: text(".msg") || text(".last-msg") || text("[class*='last']") || text("[class*='preview']"),
      unreadCount: readUnread(el),
      // DOM/选择器标记
      hasActive: hasClass(/active|selected|current/i),
      rawClass: el.className || "",
      // bossId 来自 webRequest 监听（background 维护），content script 不直接拿
      bossId: null,
    };
  }

  function readUnread(el) {
    const badge = el.querySelector(".badge, [class*='badge'], i.badge");
    if (!badge) return 0;
    const n = parseInt(badge.textContent?.trim() ?? "0", 10);
    return Number.isFinite(n) ? n : 0;
  }

  // ─────────────────────────────────────────────────────────────
  // 2. 调 historyMsg REST（同源带 cookie）
  // ─────────────────────────────────────────────────────────────
  async function fetchHistory(bossId, { maxMsgId = 0, count = 20, src = 0 } = {}) {
    const url = new URL("/wapi/zpchat/geek/historyMsg", location.origin);
    url.searchParams.set("bossId", bossId);
    url.searchParams.set("maxMsgId", String(maxMsgId));
    url.searchParams.set("c", String(count));
    url.searchParams.set("page", "1");
    url.searchParams.set("src", String(src));

    const startedAt = Date.now();
    console.log(LOG, "fetching historyMsg:", url.toString());
    let resp;
    try {
      resp = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json, text/plain, */*" },
      });
    } catch (err) {
      return { ok: false, bossId, phase: "network-error", error: String(err?.message || err), durationMs: Date.now() - startedAt };
    }

    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    const result = {
      ok: resp.ok,
      status: resp.status,
      bossId,
      durationMs: Date.now() - startedAt,
      contentType: resp.headers.get("content-type"),
      bodyPreview: text.slice(0, 500),
      parsed,
      extracted: parsed
        ? {
            code: parsed.code,
            messagesCount: parsed.zpData?.messages?.length ?? 0,
            firstMessage: parsed.zpData?.messages?.[0]
              ? { mid: parsed.zpData.messages[0].mid, bodyType: parsed.zpData.messages[0].body?.type }
              : null,
          }
        : null,
    };
    console.log(LOG, "fetchHistory result", result.extracted);
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // 3. 用户手动恢复检测（BOSS 页面正常后通知 background）
  // ─────────────────────────────────────────────────────────────
  // 反爬暂停后，content script 在页面正常时定期检查并通知恢复
  let recoveryCheckInterval = null;
  function startRecoveryWatcher() {
    if (recoveryCheckInterval) return;
    recoveryCheckInterval = setInterval(() => {
      if (location.href !== "about:blank" && document.title !== "" && document.querySelector(".friend-content")) {
        chrome.runtime.sendMessage({ type: "manual-recovery-detected" }).then(() => {
          // 恢复后停 watcher，避免反复上报
          clearInterval(recoveryCheckInterval);
          recoveryCheckInterval = null;
        }).catch(() => {});
      }
    }, 60_000); // 每分钟检查一次
  }
  startRecoveryWatcher();
})();
