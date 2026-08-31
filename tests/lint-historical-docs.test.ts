/**
 * F20260831dgim: 历史特性文档不可变——lint 脚本行为锁定。
 *
 * 在临时 git 仓库中模拟场景（每个用例先 reset 干净 staged 区，避免跨用例污染）：
 * 1. 历史文档（基准分支已合入）被修改 → 违规
 * 2. 本分支新建的文档被修改 → 通过（迭代载体）
 * 3. 非 docs/features|research 路径的修改 → 不在管辖范围
 * 4. BYPASS 环境变量 → 放行并警告
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/lint-historical-docs.mjs", import.meta.url));

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** 运行 lint 脚本，失败不抛错，返回 {status, stdout, stderr}（spawnSync 两流都可拿） */
function runLint(cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

/** 清空 staged 区再 stage 目标文件，保证用例间隔离 */
function stageOnly(cwd: string, file: string) {
  git(cwd, ["reset", "-q", "--", "."]);
  git(cwd, ["add", "--", file]);
}

let repo: string;
const OLD_DOC = "docs/features/2026/01/01/F20260101old-old-feature.md";
const NEW_DOC = "docs/features/2026/08/31/F20260831new-new-feature.md";

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-hist-doc-"));
  // 基准：main 分支上合入一个历史特性文档
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@test"]);
  git(repo, ["config", "user.name", "test"]);
  fs.mkdirSync(path.join(repo, "docs/features/2026/01/01"), { recursive: true });
  fs.writeFileSync(path.join(repo, OLD_DOC), "# old\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "main: historical doc"]);

  // 伪造 origin/main 引用指向当前 commit（脚本以 origin/main..HEAD 判定本分支独有提交）
  const head = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", head]);

  // 本分支新建一个文档（作为迭代载体，可修改）
  git(repo, ["checkout", "-b", "feature/x"]);
  fs.mkdirSync(path.join(repo, "docs/features/2026/08/31"), { recursive: true });
  fs.writeFileSync(path.join(repo, NEW_DOC), "# new v1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: new doc (draft)"]);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("lint-historical-docs: 历史文档不可变", () => {
  it("修改已合入的历史特性文档 → 违规（exit 1）", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), "# old (edited)\n");
    stageOnly(repo, OLD_DOC);
    const r = runLint(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/历史特性\/研究文档/);
    expect(r.stderr).toContain(OLD_DOC);
  });

  it("修改本分支新建的文档 → 通过（迭代载体，含已 commit 后再修改）", () => {
    fs.writeFileSync(path.join(repo, NEW_DOC), "# new v2\n");
    stageOnly(repo, NEW_DOC);
    expect(runLint(repo).status).toBe(0);
    // 新建并 commit 后再修改——曾误判场景，锁定
    git(repo, ["commit", "-m", "new doc committed"]);
    fs.writeFileSync(path.join(repo, NEW_DOC), "# new v3\n");
    stageOnly(repo, NEW_DOC);
    const r = runLint(repo);
    expect(r.status).toBe(0);
  });

  it("修改非 docs/features|research 路径 → 不拦截", () => {
    fs.writeFileSync(path.join(repo, "README.md"), "# repo (edited)\n");
    stageOnly(repo, "README.md");
    const r = runLint(repo);
    expect(r.status).toBe(0);
  });

  it("BYPASS_HISTORICAL_DOC_LINT=1 → 放行并警告", () => {
    fs.writeFileSync(path.join(repo, OLD_DOC), "# old (edited again)\n");
    stageOnly(repo, OLD_DOC);
    const r = runLint(repo, { BYPASS_HISTORICAL_DOC_LINT: "1" });
    expect(r.status).toBe(0);
    // 警告在 stderr（console.warn），stdout 为空是正常行为
    expect(r.stderr).toMatch(/BYPASS/);
  });
});
