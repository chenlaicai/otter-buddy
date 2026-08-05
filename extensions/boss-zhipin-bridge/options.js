/**
 * F20260804rbrg: BOSS 直聘桥接 - options 页脚本
 */

const $ = (id) => document.getElementById(id);

async function loadConfig() {
  const cfg = await chrome.storage.local.get(["otterUrl", "otterKey"]);
  $("otterUrl").value = cfg.otterUrl || "http://localhost:3010/api/inbound/events";
  $("otterKey").value = cfg.otterKey || "";
}

async function renderStatus() {
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

function setStatus(msg) {
  // 短暂提示
  const old = $("status-area").innerHTML;
  $("status-area").innerHTML = `<div class="status-line">${msg}</div>`;
  setTimeout(renderStatus, 1500);
}

// 事件绑定
$("save").addEventListener("click", saveConfig);

$("test").addEventListener("click", async () => {
  setStatus("测试连接中...");
  const resp = await chrome.runtime.sendMessage({ type: "test-connection" });
  if (resp?.ok) {
    setStatus(`<span class="badge badge-ok">连接成功</span> otter 返回 ${resp.status}`);
  } else {
    setStatus(`<span class="badge badge-crit">失败</span> ${resp?.error ?? `status=${resp?.status}`}`);
  }
});

$("scan-now").addEventListener("click", async () => {
  setStatus("立即扫描中（~30-40s）...");
  // 通过模拟 alarm 触发：直接发消息给 background 触发扫描
  // background 的 runScanCycle 是内部函数，这里用 action.onClicked 不行（扩展图标才能触发）
  // 简化：直接调 chrome.runtime.sendMessage 触发一个特殊 type
  // 但 background 的 alarm handler 是私有的，让 background 暴露这个能力
  chrome.runtime.sendMessage({ type: "trigger-scan-now" }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus(`<span class="badge badge-crit">扫描失败</span> ${chrome.runtime.lastError.message}`);
    } else {
      setStatus(`<span class="badge badge-ok">扫描完成</span> ${JSON.stringify(resp ?? {})}`);
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
