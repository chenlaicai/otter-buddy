// scripts/game/lib/launch.mjs — 共享启动序列：加载 → seed →（可选 __loadState）→ tick 推进 → 定格
// F20261014ghst：game-shot / game-state 共用；__loadState 注入逻辑收在这里（不拆独立工具，delta 发现 8）。
import { pathToFileURL } from "node:url";
import path from "node:path";

export function resolveGameUrl(gamePath, seed) {
  const abs = path.resolve(gamePath);
  let url = pathToFileURL(abs).href;
  if (seed !== undefined && seed !== null) url += (url.includes("?") ? "&" : "?") + "seed=" + encodeURIComponent(seed);
  return url;
}

// 启动并推进到确定性状态；返回 { page, browser, state }
// opts: { gamePath, seed, ticks, state(json obj 或 null), viewport:{width,height} }
export async function launchGame(browser, opts) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 480, height: 270 } });
  const page = await context.newPage();
  const url = resolveGameUrl(opts.gamePath, opts.seed);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__gameState && window.__tick, { timeout: 5000 }); // eslint-disable-line no-undef
  /* eslint-disable no-undef */ // page.evaluate 内 code 跑在浏览器上下文，window 由运行时提供

  if (opts.state) {
    await page.evaluate((s) => window.__loadState(s), opts.state);
  }
  if (opts.ticks && opts.ticks > 0) {
    await page.evaluate((n) => window.__tick(n), opts.ticks);
  }
  const state = await page.evaluate(() => window.__gameState());
  return { page, context, state, url };
}

export function parseCommonArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") { args.help = true; continue; }
    if (!a.startsWith("--")) { if (!args.game) args.game = a; continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; } else args[key] = true;
  }
  return args;
}

export const COMMON_HELP = `公共参数：
  <game>              游戏 HTML 路径（默认 game/index.html）
  --seed=N            种子化随机（B1：seed 模式全局确定）
  --ticks=N           加载后 __tick(N) 确定性推进 N 帧
  --state=<json文件>  __loadState 注入状态（__gameState 形状的 JSON 文件）
  --viewport=WxH      视口（默认 480x270）
  --help              显示帮助`;
