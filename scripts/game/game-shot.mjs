#!/usr/bin/env node
// game-shot.mjs — Playwright 截图工具（F20261014ghst 原子工具之一）
// 纯文本 stdout：输出截图路径与尺寸；图像只写盘不进 stdout。
import { chromium } from "playwright";
import { launchGame, parseCommonArgs, COMMON_HELP } from "./lib/launch.mjs";
import fs from "node:fs";
import path from "node:path";

function parseViewport(s) {
  if (!s) return { width: 480, height: 270 };
  const m = /^(\d+)x(\d+)$/i.exec(s);
  if (!m) throw new Error("--viewport 需形如 480x270");
  return { width: +m[1], height: +m[2] };
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`game-shot — 对游戏页面做确定性截图（seed/tick/state 可控）

用法：node scripts/game/game-shot.mjs [选项] [game/index.html] [--out=path.png]

${COMMON_HELP}
  --out=<path.png>    输出路径（默认 stdout 打印建议路径；传 - 表示只打印元信息不存盘）
  --full-page         整页截图（默认只截 viewport 尺寸的游戏画布区）

输出（stdout 纯文本）：
  path=<绝对路径> size=<宽x高> bytes=<字节数> tick=<定格帧> seed=<种子>`);
    return;
  }
  const gamePath = args.game || "game/index.html";
  const outArg = args.out;
  const viewport = parseViewport(args.viewport);
  const ticks = args.ticks ? parseInt(args.ticks, 10) : 0;
  let state = null;
  if (args.state) state = JSON.parse(fs.readFileSync(args.state, "utf8"));
  const seed = args.seed !== undefined && args.seed !== true ? args.seed : undefined;

  const browser = await chromium.launch();
  try {
    const { page, context, state: finalState } = await launchGame(browser, { gamePath, seed, ticks, state, viewport });
    const suggested = path.resolve(gamePath).replace(/\.html$/i, "") + `.shot${seed !== undefined ? ".s" + seed : ""}.png`;
    const outPath = outArg && outArg !== "-" ? path.resolve(outArg) : suggested;
    if (outArg !== "-") {
      await page.screenshot({ path: outPath, fullPage: !!args["full-page"] });
      const st = fs.statSync(outPath);
      console.log(`path=${outPath} size=${viewport.width}x${viewport.height} bytes=${st.size} tick=${finalState.tick} seed=${finalState.seed}`);
    } else {
      console.log(`size=${viewport.width}x${viewport.height} tick=${finalState.tick} seed=${finalState.seed} (未存盘)`);
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error("game-shot 失败:", e.message); process.exit(1); });
