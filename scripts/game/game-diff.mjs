#!/usr/bin/env node
// game-diff.mjs — 图像 diff 工具（F20261014ghst 原子工具之二）
// 文本报告：similarity / mismatchRatio / 通过判定（默认 mismatchRatio<1% 通过，threshold 是单像素色差容忍度）。
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") { args.help = true; continue; }
    if (!a.startsWith("--")) { (args.imgs ||= []).push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
    else args[a.slice(2)] = argv[++i];
  }
  return args;
}

function loadPng(p) {
  return PNG.sync.read(fs.readFileSync(p));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`game-diff — 两张 PNG 图像 diff，输出差异图 + 文本报告

用法：node scripts/game/game-diff.mjs <a.png> <b.png> [--out=diff.png] [--threshold=0.1] [--max-ratio=0.01]

  --threshold=N   单像素色差容忍度（0..1，默认 0.1；吸收亚像素/字体渲染噪声）
  --max-ratio=N   mismatchRatio 通过上限（默认 0.01 = 1%）
  --out=<path>    差异图输出路径（默认 <a>.diff.png；传 - 不存）

输出（stdout 纯文本）：
  similarity=85.2% mismatchRatio=0.023 mismatchPixels=1234 totalPixels=... PASS/FAIL`);
    return;
  }
  const [aPath, bPath] = args.imgs || [];
  if (!aPath || !bPath) { console.error("game-diff 需要两张 PNG 路径"); process.exit(2); }
  const threshold = args.threshold !== undefined ? parseFloat(args.threshold) : 0.1;
  const maxRatio = args["max-ratio"] !== undefined ? parseFloat(args["max-ratio"]) : 0.01;

  const a = loadPng(aPath), b = loadPng(bPath);
  if (a.width !== b.width || a.height !== b.height) {
    console.error(`尺寸不一致：${a.width}x${a.height} vs ${b.width}x${b.height}，无法 diff`);
    process.exit(2);
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const mismatch = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
  const total = a.width * a.height;
  const ratio = mismatch / total;
  const similarity = (1 - ratio) * 100;
  const pass = ratio < maxRatio;

  let outPath = null;
  const outArg = args.out;
  if (outArg !== "-") {
    outPath = path.resolve(outArg || aPath.replace(/\.png$/i, "") + ".diff.png");
    fs.writeFileSync(outPath, PNG.sync.write(diff));
  }
  console.log(`similarity=${similarity.toFixed(2)}% mismatchRatio=${ratio.toFixed(4)} mismatchPixels=${mismatch} totalPixels=${total}` +
    (outPath ? ` diff=${outPath}` : "") + ` ${pass ? "PASS" : "FAIL"} (maxRatio=${maxRatio}, threshold=${threshold})`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("game-diff 失败:", e.message); process.exit(1); });
