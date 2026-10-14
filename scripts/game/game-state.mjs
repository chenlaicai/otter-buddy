#!/usr/bin/env node
// game-state.mjs — 状态导出工具（F20261014ghst 原子工具之三）
// 调 window.__gameState()，JSON 文本 stdout——agent 不靠读代码猜运行时状态（B3）。
import { chromium } from "playwright";
import { launchGame, parseCommonArgs, COMMON_HELP } from "./lib/launch.mjs";
import fs from "node:fs";

function parseViewport(s) {
  if (!s) return { width: 480, height: 270 };
  const m = /^(\d+)x(\d+)$/i.exec(s);
  if (!m) throw new Error("--viewport 需形如 480x270");
  return { width: +m[1], height: +m[2] };
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`game-state — 读取游戏运行时状态（window.__gameState），JSON 输出

用法：node scripts/game/game-state.mjs [选项] [game/index.html]

${COMMON_HELP}

输出（stdout 纯文本 JSON）：__gameState() 的完整返回（tick/seed/player/bag/unlocks/done/flags/codex/battle）`);
    return;
  }
  const gamePath = args.game || "game/index.html";
  const viewport = parseViewport(args.viewport);
  const ticks = args.ticks ? parseInt(args.ticks, 10) : 0;
  let state = null;
  if (args.state) state = JSON.parse(fs.readFileSync(args.state, "utf8"));
  const seed = args.seed !== undefined && args.seed !== true ? args.seed : undefined;

  const browser = await chromium.launch();
  try {
    const { state: finalState } = await launchGame(browser, { gamePath, seed, ticks, state, viewport });
    console.log(JSON.stringify(finalState, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error("game-state 失败:", e.message); process.exit(1); });
