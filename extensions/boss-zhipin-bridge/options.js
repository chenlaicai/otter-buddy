/**
 * F20260805rbrg: BOSS 直聘桥接 - options 页脚本
 */

const $ = (id) => document.getElementById(id);

async function loadConfig() {
  const cfg = await chrome.storage.local.get(["otterUrl", "otterKey"]);
  $("otterUrl").value = cfg.otterUrl || "http://localhost:3010/api/inbound/events";
  $("otterKey").value = cfg.otterKey || "";
}

async function renderStatus() {
  // 扫描进行中：渲染扫描进度，不被覆盖
  if (scanInProgress) {
    const phase = await chrome.storage.local.get(["boss-bridge-scan-phase"]);
    const phaseText = phase["boss-bridge-scan-phase"] || "(未知)";
    $("status-area").innerHTML = `<div class="status-line"><span class="badge badge-warn">扫描中</span> ${phaseText}</div>`;
    return;
  }

  const data = await chrome.storage.local.get([
    "last-scan-at",
    "paused-due-to-antibot",
    "boss-bridge-error-counters",
    "boss-bridge-forward-buffer",
    "boss-bridge-status-dedup",
  ]);
  const counters = data["boss-bridge-error-counters"] ?? {};
  const buffer = data["boss-bridge-forward-buffer"] ?? [];
  const lastScan = data["last-scan-at"];

  const lines = [];
  if (data["paused-due-to-antibot"]) {
    lines.push(`<div class="status-line"><span class="badge badge-paused">PAUSED</span> 因反爬暂停，需手动到 BOSS 页面恢复</div>`);
  }
  if (lastScan) {
    lines.push(`<div class="status-line">最后扫描：${new Date(lastScan).toLocaleString("zh-CN")}（${Math.round((Date.now() - lastScan) / 60000)} 分钟前）</div>`);
  }
  lines.push(`<div class="status-line">错误计数器：scan-zero=${counters["scan-zero-unexpected"] ?? 0} / scan-ok-0=${counters["scan-ok-0"] ?? 0} / forward-failed=${counters["forward-failed"] ?? 0}</div>`);
  if (buffer.length > 0) {
    lines.push(`<div class="status-line"><span class="badge badge-warn">BUFFER</span> ${buffer.length} 条消息待补发（otter 暂时不可达）</div>`);
  }
  if (lines.length === 0) {
    lines.push(`<div class="status-line"><span class="badge badge-ok">正常</span> 等待下次 alarm 触发</div>`);
  }
  $("status-area").innerHTML = lines.join("");

  // 渲染调试区
  const captured = await chrome.runtime.sendMessage({ type: "get-captured" });
  $("captured").textContent = JSON.stringify(captured?.list?.slice(-15) ?? [], null, 2);
  const wl = await chrome.storage.local.get(["boss-bridge-waterline"]);
  $("waterline").textContent = JSON.stringify(wl["boss-bridge-waterline"] ?? {}, null, 2);
  $("counters").textContent = JSON.stringify(counters, null, 2);
}

async function saveConfig() {
  const otterUrl = $("otterUrl").value.trim();
  const otterKey = $("otterKey").value.trim();
  if (!otterUrl || !otterKey) {
    alert("URL 和 Key 都要填");
    return;
  }
  await chrome.storage.local.set({ otterUrl, otterKey });
  setStatus("配置已保存 ✓");
}

let scanInProgress = false;

function setStatus(msg, persistent = false) {
  // persistent=true 时不被周期 renderStatus 覆盖（扫描/测试连接等长操作用）
  $("status-area").innerHTML = `<div class="status-line">${msg}</div>`;
  if (!persistent) {
    setTimeout(renderStatus, 1500);
  }
}

// 事件绑定
$("save").addEventListener("click", saveConfig);

$("test").addEventListener("click", async () => {
  // 直接从输入框读当前值（不依赖 storage），避免"改了未保存"的陷阱
  const otterUrl = $("otterUrl").value.trim();
  const otterKey = $("otterKey").value.trim();
  if (!otterUrl || !otterKey) {
    setStatus(`<span class="badge badge-crit">失败</span> URL 和 Key 都要填`);
    return;
  }
  setStatus("测试连接中...");
  const resp = await chrome.runtime.sendMessage({ type: "test-connection", otterUrl, otterKey });
  if (resp?.ok) {
    setStatus(`<span class="badge badge-ok">连接成功</span> otter 返回 ${resp.status}`);
  } else {
    setStatus(`<span class="badge badge-crit">失败</span> ${resp?.error ?? `status=${resp?.status}`}`);
  }
});

$("scan-now").addEventListener("click", async () => {
  scanInProgress = true;
  await chrome.storage.local.set({ "boss-bridge-scan-phase": "触发中..." });
  setStatus("立即扫描中（~30-40s）...", true);

  chrome.runtime.sendMessage({ type: "trigger-scan-now" }, (resp) => {
    scanInProgress = false;
    chrome.storage.local.remove(["boss-bridge-scan-phase"]);
    if (chrome.runtime.lastError) {
      setStatus(`<span class="badge badge-crit">扫描失败</span> ${chrome.runtime.lastError.message}`);
    } else if (resp?.ok) {
      setStatus(`<span class="badge badge-ok">扫描完成</span> ${JSON.stringify(resp)}`);
    } else {
      setStatus(`<span class="badge badge-crit">扫描出错</span> ${resp?.error ?? "未知"}`);
    }
  });
});

$("clear-paused").addEventListener("click", async () => {
  await chrome.storage.local.set({ "paused-due-to-antibot": false });
  setStatus("已清除反爬暂停状态");
});

$("clear-all").addEventListener("click", async () => {
  if (!confirm("清空所有本地数据（水位线、计数器、缓冲、captured），但不影响配置。确定？")) return;
  await chrome.storage.local.remove([
    "boss-bridge-waterline",
    "boss-bridge-error-counters",
    "boss-bridge-forward-buffer",
    "boss-bridge-captured-urls",
    "boss-bridge-status-dedup",
    "paused-due-to-antibot",
    "last-scan-at",
  ]);
  setStatus("已清空本地数据");
});

// 启动加载 + 周期刷新
loadConfig().then(renderStatus);
setInterval(renderStatus, 30_000); // 每 30 秒刷新状态
