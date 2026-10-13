/**
 * F20261013crit: 测试弱化防线（check-pr-tests）——删断言无声明 FAIL / 带声明+理由 PASS /
 * 放宽无理由 FAIL。集成用例走真实 tmp git 仓库 + 真 CLI。
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error 真实现是 .mjs 脚本（无类型声明），import 纯函数
import { isTestPath, isVerifyApparatusPath, parseNumstat, checkDeclaration } from "../../scripts/check-pr-tests.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PR_TESTS = path.join(REPO_ROOT, "scripts", "check-pr-tests.mjs");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeGitRepo(kind: "test-file" | "src-file" | "apparatus-file"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prtests-"));
  tmpDirs.push(dir);
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: dir });
  const rel =
    kind === "test-file" ? "tests/sample.test.ts" : kind === "apparatus-file" ? "criteria/invariants.json" : "src/sample.ts";
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, ["line one", "expect(result).toBe(1);", "line three"].join("\n"));
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  // 第二个 commit：删掉断言行（测试弱化形态）
  fs.writeFileSync(abs, ["line one", "line three"].join("\n"));
  execSync("git add -A && git commit -q -m weaken", { cwd: dir });
  return dir;
}

function runPrTests(dir: string, body: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (body === undefined) delete env.PR_BODY;
  else env.PR_BODY = body;
  try {
    const stdout = execFileSync("node", [PR_TESTS, "--base", "HEAD~1"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    return { status: 0, output: stdout };
  } catch (e: any) {
    return { status: e.status as number, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

describe("checkDeclaration 纯函数", () => {
  it("无声明段 → 不通过", () => {
    expect(checkDeclaration("随便写的 PR body").ok).toBe(false);
  });
  it("有声明 + 方向收紧 → 通过（收紧不要求理由）", () => {
    expect(checkDeclaration("## 测试改动声明\n方向：收紧").ok).toBe(true);
  });
  it("方向放宽无理由 → 不通过", () => {
    const r = checkDeclaration("## 测试改动声明\n方向：放宽");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("理由");
  });
  it("方向放宽 + 非空理由 → 通过", () => {
    expect(checkDeclaration("## 测试改动声明\n方向：放宽\n理由：删除重复断言，覆盖不变").ok).toBe(true);
  });
  it("方向值不合法 → 不通过", () => {
    expect(checkDeclaration("## 测试改动声明\n方向：随便").ok).toBe(false);
  });
  it("半角冒号也可解析", () => {
    expect(checkDeclaration("## 测试改动声明\n方向: 收紧").ok).toBe(true);
  });
});

describe("isTestPath / parseNumstat", () => {
  it("测试路径判定", () => {
    expect(isTestPath("tests/x/y.test.ts")).toBe(true);
    expect(isTestPath("src/a.spec.ts")).toBe(true);
    expect(isTestPath("src/main.ts")).toBe(false);
  });
  it("验收装置路径判定（闸本体同射程）", () => {
    expect(isVerifyApparatusPath("criteria/lock.json")).toBe(true);
    expect(isVerifyApparatusPath("criteria/invariants.json")).toBe(true);
    expect(isVerifyApparatusPath("scripts/check-criteria.mjs")).toBe(true);
    expect(isVerifyApparatusPath("scripts/lint-evidence-anchors.mjs")).toBe(true);
    expect(isVerifyApparatusPath(".githooks/pre-commit")).toBe(true);
    expect(isVerifyApparatusPath(".github/workflows/ci.yml")).toBe(true);
    expect(isVerifyApparatusPath(".pi/skills/adversarial-review/references/review-dimensions.md")).toBe(true);
    expect(isVerifyApparatusPath("scripts/backup-runtime-data.mjs")).toBe(false);
    expect(isVerifyApparatusPath("src/main.ts")).toBe(false);
  });
  it("numstat 解析含删除行", () => {
    const rows = parseNumstat("1\t2\ttests/a.test.ts\n5\t0\tsrc/b.ts\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: "tests/a.test.ts", added: 1, deleted: 2 });
    expect(rows[1]).toMatchObject({ deleted: 0 });
  });
});

describe("check-pr-tests 集成（真实 git diff + 真 CLI）", () => {
  it("红：测试删断言无声明 → FAIL", () => {
    const dir = makeGitRepo("test-file");
    const r = runPrTests(dir, "");
    expect(r.status).toBe(1);
  });

  it("绿：带声明（方向收紧）→ PASS", () => {
    const dir = makeGitRepo("test-file");
    const r = runPrTests(dir, "## 测试改动声明\n方向：收紧");
    expect(r.status).toBe(0);
  });

  it("红：放宽无理由 → FAIL；补理由 → PASS", () => {
    const dir = makeGitRepo("test-file");
    expect(runPrTests(dir, "## 测试改动声明\n方向：放宽").status).toBe(1);
    expect(
      runPrTests(dir, "## 测试改动声明\n方向：放宽\n理由：删除重复断言，覆盖不变").status,
    ).toBe(0);
  });

  it("红：有删除行但 PR body 缺失（fail-closed）→ FAIL", () => {
    const dir = makeGitRepo("test-file");
    const r = runPrTests(dir, undefined);
    expect(r.status).toBe(1);
    expect(r.output).toContain("PR_BODY");
  });

  it("绿：非测试文件删除 → 无需声明", () => {
    const dir = makeGitRepo("src-file");
    expect(runPrTests(dir, "").status).toBe(0);
  });

  it("红：验收装置文件（criteria/ 件套）删改无声明 → FAIL（闸本体同射程）", () => {
    const dir = makeGitRepo("apparatus-file");
    const r = runPrTests(dir, "");
    expect(r.status).toBe(1);
    expect(r.output).toContain("验收装置");
  });

  it("绿：验收装置删改带声明（方向收紧）→ PASS", () => {
    const dir = makeGitRepo("apparatus-file");
    expect(runPrTests(dir, "## 测试改动声明\n方向：收紧").status).toBe(0);
  });
});
