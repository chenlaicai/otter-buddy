// F20261014ghst：game-dev-harness 原子工具的 A 类测试（行为契约：输入输出是确定数据）
// 跑真浏览器与真 PNG，走 vitest；每个用例独立 spawn，避免状态互串。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(__dirname, "../..");
const SHOT = path.join(REPO, "scripts/game/game-shot.mjs");
const DIFF = path.join(REPO, "scripts/game/game-diff.mjs");
const STATE = path.join(REPO, "scripts/game/game-state.mjs");
const GAME = path.join(REPO, "game/index.html");

// F20261021ttos：真浏览器+真 PNG 结构性重活，全量并发下 P99 贴默认 5s 线——文件级宽窗（判据见 testing-rules「重成本用例超时策略」）
vi.setConfig({ testTimeout: 30_000 });  // 30s：真浏览器+PNG 对比负载波动大（实测 P99 冲 26s+），常态 6s 按 5 倍余量

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
  });

  it("game-diff 检出跨 seed 差异：战斗场景下烟雾粒子累积后两 seed 图像必须不同", () => {
    const a = path.join(tmp, "s1.png"), b = path.join(tmp, "s2.png");
    // 开局画面 seed 差异太小（粒子未累积），改用战斗场景 + 高 tick 让烟雾粒子累积到可检出量
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
    shot(["--seed=42", `--state=${statePath}`, "--ticks=1500", `--out=${a}`]);
    shot(["--seed=7", `--state=${statePath}`, "--ticks=1500", `--out=${b}`]);
    const out = diff(a, b);
    // 跨 seed 差异必须稳健可检出：稳态烟雾约 15 粒子 × 1-2 px ≈ 30-40 不同像素（物理上限）
    // 断言非零 + 下限 ≥10px，防「碰巧相同」或「只抖出 1-2 个噪点」蒙混
    const m = /mismatchRatio=([\d.]+)/.exec(out);
    const p = /mismatchPixels=(\d+)/.exec(out);
    expect(m).toBeTruthy();
    expect(p).toBeTruthy();
    expect(parseFloat(m![1])).toBeGreaterThan(0);
    expect(parseInt(p![1], 10)).toBeGreaterThanOrEqual(10);
  });

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
  });

  it("game-state 输出 JSON 含关键字段（B2 验收）", () => {
    const out = execFileSync("node", [STATE, "--seed=42", GAME], { encoding: "utf8", cwd: REPO });
    const state = JSON.parse(out);
    expect(state).toHaveProperty("tick");
    expect(state).toHaveProperty("seed", 42);
    expect(state).toHaveProperty("started");
    expect(state).toHaveProperty("player");
    expect(state).toHaveProperty("bag");
  });

  it("__loadState 拒绝非对象参数", () => {
    const statePath = path.join(tmp, "bad.json");
    fs.writeFileSync(statePath, JSON.stringify("not-an-object"));
    let failed = false;
    try { shot([`--state=${statePath}`, `--out=${path.join(tmp, "x.png")}`]); }
    catch { failed = true; }
    expect(failed).toBe(true);
  });
});
