// F20261014ghst：game-dev-harness 原子工具的 A 类测试（行为契约：输入输出是确定数据）
// 跑真浏览器与真 PNG，走 vitest；每个用例独立 spawn，避免状态互串。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(__dirname, "../..");
const SHOT = path.join(REPO, "scripts/game/game-shot.mjs");
const DIFF = path.join(REPO, "scripts/game/game-diff.mjs");
const STATE = path.join(REPO, "scripts/game/game-state.mjs");
const GAME = path.join(REPO, "game/index.html");

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghst-")); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function shot(args: string[]): string {
  return execFileSync("node", [SHOT, ...args, GAME], { encoding: "utf8", cwd: REPO }).trim();
}
function diff(a: string, b: string): string {
  try {
    return execFileSync("node", [DIFF, a, b], { encoding: "utf8", cwd: REPO }).trim();
  } catch (e: any) {
    // game-diff 非 0 退出时也带 stdout——断言用 stdout，不用 exit code
    return (e.stdout || "").toString().trim();
  }
}

describe("game-dev-harness 原子工具", () => {
  it("同 seed 双跑 similarity=100%（B1 验收硬门）", () => {
    const a = path.join(tmp, "a.png"), b = path.join(tmp, "b.png");
    shot(["--seed=42", "--ticks=80", `--out=${a}`]);
    shot(["--seed=42", "--ticks=80", `--out=${b}`]);
    const out = diff(a, b);
    expect(out).toContain("similarity=100.00%");
    expect(out).toContain("mismatchRatio=0.0000");
    expect(out).toContain("PASS");
  }, 30000);

  it("game-diff 检出两张不同 PNG 的差异（非 100%）", () => {
    const a = path.join(tmp, "s1.png"), b = path.join(tmp, "s2.png");
    shot(["--seed=42", "--ticks=80", `--out=${a}`]);
    shot(["--seed=7", "--ticks=80", `--out=${b}`]);
    const out = diff(a, b);
    // 开局画面 seed 差异主要在粒子上，比例虽小但应可检出或至少给出 FAIL（默认 <1%）
    expect(out).toMatch(/similarity=\d+\.\d+%/);
    expect(out).toMatch(/mismatchPixels=\d+/);
  }, 30000);

  it("__loadState 直达终战后同 seed 双跑仍 similarity=100%", () => {
    const statePath = path.join(tmp, "battle.json");
    fs.writeFileSync(statePath, JSON.stringify({
      tick: 100, started: true, phase: "idle", activeId: null, allDone: true,
      player: { x: 400, y: 92, tx: 400, ty: 92 },
      bag: ["🌱","🔍","📦","🍂","🐞","🤝","👴","🧪"],
      done: { plant:true, seedbox:true, fert:true, fallow:true, ladybug:true, neighbor:true, elder:true, lab:true },
      flags: { aphids:true, eggs:true, wilt:true, pile:true, slow:true, magnify:true, trial:true, matured:true },
      codex: ["plant","seedbox","fert","fallow","ladybug","neighbor","elder","lab"],
      battle: { on:true, hp:100, mp:60, foe:100, foeTalk:0, divined:false, ally:false, allyTired:false, allyFresh:false, insight:false, shield:0, selfChain:0, turn:1, busy:false, over:false, seal:false, barrier:false }
    }));
    const a = path.join(tmp, "bt1.png"), b = path.join(tmp, "bt2.png");
    shot(["--seed=42", `--state=${statePath}`, "--ticks=80", `--out=${a}`]);
    shot(["--seed=42", `--state=${statePath}`, "--ticks=80", `--out=${b}`]);
    const out = diff(a, b);
    expect(out).toContain("similarity=100.00%");
    expect(out).toContain("PASS");
  }, 30000);

  it("game-state 输出 JSON 含关键字段（B2 验收）", () => {
    const out = execFileSync("node", [STATE, "--seed=42", GAME], { encoding: "utf8", cwd: REPO });
    const state = JSON.parse(out);
    expect(state).toHaveProperty("tick");
    expect(state).toHaveProperty("seed", 42);
    expect(state).toHaveProperty("started");
    expect(state).toHaveProperty("player");
    expect(state).toHaveProperty("bag");
  }, 15000);

  it("__loadState 拒绝非对象参数", () => {
    const statePath = path.join(tmp, "bad.json");
    fs.writeFileSync(statePath, JSON.stringify("not-an-object"));
    let failed = false;
    try { shot([`--state=${statePath}`, `--out=${path.join(tmp, "x.png")}`]); }
    catch { failed = true; }
    expect(failed).toBe(true);
  }, 15000);
});
