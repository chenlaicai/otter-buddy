/**
 * F20261013crit: 验收判据闸——checker 红→绿 fixture 测试。
 *
 * 红→绿用例 = 2026-10-12「出清删纪律语义」真实事故的重演：那个删掉 4 处纪律语义的
 * diff 今天一路绿灯（无闸），在本闸下必须 FAIL；完整文件必须 PASS。
 * 另覆盖：lock 篡改 → exit 2、--update-lock 修复、waiver 有效/过期/不可豁免/畸形。
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKER = path.join(REPO_ROOT, "scripts", "check-criteria.mjs");

/** fixture 拷贝对象：registry 目标文件 + criteria 件套 + checker 自身（lock 覆盖面含 checker） */
const FIXSTER_FILES = [
  "prompts/scheduled/daily-health-check.md",
  ".pi/SYSTEM.md",
  "docs/README.md",
  ".pi/skills/adversarial-review/references/review-dimensions.md",
  ".pi/skills/code-implementation/SKILL.md",
  "criteria/invariants.json",
  "criteria/waivers.json",
  "scripts/check-criteria.mjs",
];

const tmpDirs: string[] = [];

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "criteria-fixture-"));
  tmpDirs.push(root);
  for (const rel of FIXSTER_FILES) {
    const src = path.join(REPO_ROOT, rel);
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // 用真 checker 对 fixture 基线生成 lock（顺带验证 --update-lock 通路）
  const r = runChecker(root, ["--update-lock"]);
  expect(r.status).toBe(0);
  return root;
}

function runChecker(root: string, extraArgs: string[] = []) {
  try {
    const stdout = execFileSync("node", [CHECKER, "--root", root, ...extraArgs, "--json"], {
      encoding: "utf8",
    });
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      /* 非 JSON 输出（如 --update-lock 横幅）不算失败 */
    }
    return { status: 0, stdout, json };
  } catch (e: any) {
    const stdout = String(e.stdout ?? "");
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      /* --update-lock 等非 JSON 输出 */
    }
    return { status: e.status as number, stdout, stderr: String(e.stderr ?? ""), json };
  }
}

function editFile(root: string, rel: string, from: string, to: string) {
  const abs = path.join(root, rel);
  const txt = fs.readFileSync(abs, "utf8");
  expect(txt).toContain(from); // fixture 前提守卫：删不到目标语义说明上游文件变了，测试要跟着 registry 走
  fs.writeFileSync(abs, txt.replace(from, to));
}

function writeWaivers(root: string, waivers: unknown[]) {
  fs.writeFileSync(
    path.join(root, "criteria", "waivers.json"),
    JSON.stringify({ version: 1, waivers }, null, 2) + "\n",
  );
}

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("check-criteria 红→绿（出清删纪律语义事故重演）", () => {
  it("绿：完整文件 → PASS（exit 0）", () => {
    const root = makeFixture();
    const r = runChecker(root);
    expect(r.status).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.failures).toHaveLength(0);
    expect(r.json.lock.ok).toBe(true);
  });

  it("红：删「禁止只列数字」→ FAIL（exit 1）——今天这个 diff 一路绿灯", () => {
    const root = makeFixture();
    editFile(root, "prompts/scheduled/daily-health-check.md", "禁止只列数字", "");
    const r = runChecker(root);
    expect(r.status).toBe(1);
    expect(r.json.ok).toBe(false);
    const ids = r.json.failures.map((f: any) => f.id);
    expect(ids).toContain("dhc-no-bare-numbers");
  });

  it("红：出清删 4 处纪律语义重演 → FAIL 且 4 条全部点名", () => {
    const root = makeFixture();
    const rel = "prompts/scheduled/daily-health-check.md";
    editFile(root, rel, "禁止只列数字", ""); // 事故删点 ①
    editFile(root, rel, "失败附断言原文+实际内容", ""); // 事故删点 ②
    editFile(root, rel, "每个 issue body 含「验证断言」段", "issue body"); // 事故删点 ③
    editFile(root, rel, "每个 issue body 含「关闭标准」段", "issue body"); // 事故删点 ④
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const ids = r.json.failures.map((f: any) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "dhc-no-bare-numbers",
        "dhc-assertion-evidence",
        "dhc-issue-verification-assertion",
        "dhc-issue-close-criteria",
      ]),
    );
    expect(r.json.failures).toHaveLength(4);
  });

  it("红：删 Magic Words 停下行 → FAIL（指令保鲜）", () => {
    const root = makeFixture();
    editFile(root, ".pi/SYSTEM.md", "| 「停下」 |", "| （停） |");
    const r = runChecker(root);
    expect(r.status).toBe(1);
    expect(r.json.failures.map((f: any) => f.id)).toContain("system-magic-stop");
  });

  it("红：目标文件整删 → FAIL（语义不存在同口径）", () => {
    const root = makeFixture();
    fs.rmSync(path.join(root, "docs", "README.md"));
    const r = runChecker(root);
    expect(r.status).toBe(1);
    const hit = r.json.failures.find((f: any) => f.id === "docs-delivery-dual-number");
    expect(hit.detail).toContain("目标文件不存在");
  });
});

describe("check-criteria 防静默篡改（lock）", () => {
  it("篡改 registry 不同步 lock → exit 2", () => {
    const root = makeFixture();
    fs.appendFileSync(path.join(root, "criteria", "invariants.json"), "\n");
    const r = runChecker(root);
    expect(r.status).toBe(2);
  });

  it("篡改 checker 自身 → exit 2（验证脚本也在防静默篡改面内）", () => {
    const root = makeFixture();
    fs.appendFileSync(path.join(root, "scripts", "check-criteria.mjs"), "\n// tampered\n");
    const r = runChecker(root);
    expect(r.status).toBe(2);
  });

  it("lock.json 缺失 → exit 2", () => {
    const root = makeFixture();
    fs.rmSync(path.join(root, "criteria", "lock.json"));
    const r = runChecker(root);
    expect(r.status).toBe(2);
    // --json 模式错误信息在 stdout 的 errors 字段（CI 消费口径）
    expect(r.json.errors.join("\n")).toContain("lock.json 缺失");
  });

  it("--update-lock 显式更新后恢复 PASS", () => {
    const root = makeFixture();
    fs.appendFileSync(path.join(root, "criteria", "invariants.json"), "\n");
    expect(runChecker(root).status).toBe(2);
    expect(runChecker(root, ["--update-lock"]).status).toBe(0);
    expect(runChecker(root).status).toBe(0);
  });
});

describe("check-criteria waiver 机制", () => {
  it("合法 waiver（未过期）→ PASS(WARN) exit 0", () => {
    const root = makeFixture();
    writeWaivers(root, [
      {
        invariant_id: "dhc-no-bare-numbers",
        reason: "daily-health-check 正在重写，暂放宽 3 天",
        approved_by: "搭档",
        expires: day(3),
      },
    ]);
    runChecker(root, ["--update-lock"]);
    editFile(root, "prompts/scheduled/daily-health-check.md", "禁止只列数字", "");
    const r = runChecker(root);
    expect(r.status).toBe(0);
    expect(r.json.waived.map((w: any) => w.id)).toContain("dhc-no-bare-numbers");
  });

  it("改 waivers 不同步 lock → exit 2（waiver 本身也在防静默篡改面内）", () => {
    const root = makeFixture();
    writeWaivers(root, [
      {
        invariant_id: "dhc-no-bare-numbers",
        reason: "未更新 lock 的 waiver",
        approved_by: "搭档",
        expires: day(3),
      },
    ]);
    const r = runChecker(root);
    expect(r.status).toBe(2);
  });

  it("过期 waiver → FAIL（过期即无效）", () => {
    const root = makeFixture();
    writeWaivers(root, [
      {
        invariant_id: "dhc-no-bare-numbers",
        reason: "早已过期的放宽",
        approved_by: "搭档",
        expires: day(-1),
      },
    ]);
    runChecker(root, ["--update-lock"]);
    editFile(root, "prompts/scheduled/daily-health-check.md", "禁止只列数字", "");
    const r = runChecker(root);
    expect(r.status).toBe(1);
    expect(r.json.failures[0].detail).toContain("waiver 已过期");
  });

  it("waiver 到期日=今天 → 仍有效（expires 是最后有效日）", () => {
    const root = makeFixture();
    writeWaivers(root, [
      {
        invariant_id: "dhc-no-bare-numbers",
        reason: "最后一天",
        approved_by: "搭档",
        expires: day(0),
      },
    ]);
    runChecker(root, ["--update-lock"]);
    editFile(root, "prompts/scheduled/daily-health-check.md", "禁止只列数字", "");
    expect(runChecker(root).status).toBe(0);
  });

  it("waiver_eligible=false 的条目不可豁免：waiver 配置非法 + 缺失仍 FAIL", () => {
    const root = makeFixture();
    writeWaivers(root, [
      {
        invariant_id: "system-magic-stop",
        reason: "试图放宽急停行",
        approved_by: "搭档",
        expires: day(3),
      },
    ]);
    runChecker(root, ["--update-lock"]);
    editFile(root, ".pi/SYSTEM.md", "| 「停下」 |", "| （停） |");
    const r = runChecker(root);
    expect(r.status).toBe(1);
    expect(r.json.errors.join("\n")).toContain("不可豁免");
    expect(r.json.failures.map((f: any) => f.id)).toContain("system-magic-stop");
  });

  it("畸形 waiver（缺 approved_by）→ fail-closed exit 1", () => {
    const root = makeFixture();
    writeWaivers(root, [
      {
        invariant_id: "dhc-no-bare-numbers",
        reason: "谁批的没写",
        expires: day(3),
      } as any,
    ]);
    runChecker(root, ["--update-lock"]);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    expect(r.json.errors.join("\n")).toContain("approved_by");
  });

  it("waiver 指向未知条目 → fail-closed exit 1", () => {
    const root = makeFixture();
    writeWaivers(root, [
      {
        invariant_id: "not-exist-id",
        reason: "指向幽灵条目",
        approved_by: "搭档",
        expires: day(3),
      },
    ]);
    runChecker(root, ["--update-lock"]);
    const r = runChecker(root);
    expect(r.status).toBe(1);
    expect(r.json.errors.join("\n")).toContain("未知条目");
  });
});
