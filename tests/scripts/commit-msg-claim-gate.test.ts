/**
 * commit-msg 认领闸集成测试（真 git 仓库 + linked worktree，真跑脚本与 hook）。
 *
 * 回归锚点（kimi检视獭-1954 对抗检视）：
 *  - BLOCK-2：marker 必须落在 worktree 私有 git-dir（--absolute-git-dir）且绑分支——
 *    共享父目录（.git/worktrees/）或他分支的 marker 不得被静默继承（曾实盘复现：
 *    他线 worktree 因共享 marker 零核验静默 exit 0）；主仓形态 marker 落 .git/ 不落
 *    工作树根（曾 dirname('.git')='.' 写到仓库根）。
 *  - MINOR-2：R 类提交不得绕过认领闸（曾因 F/R 分流提前 exit 0 绕过尾部闸）。
 *
 * 联网面隔离：临时仓无 GitHub remote，gh issue view 必失败 → 认领闸走 fail-open
 * （⚠️ + exit 0）——fail-open 输出正是「未静默跳过、真走了核验路径」的可观测信号。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCommitIssueNumbers } from "../../scripts/check-pr-claim.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = ["scripts/commit-msg-claim-gate.mjs", "scripts/check-pr-claim.mjs", "scripts/check-pr-evidence.mjs"];
const N = 999000001; // 不存在的 issue：fake gh 对它 exit 1 → fail-open 路径
const N2 = 999000002; // fake gh 返回空评论（存在但零认领）→ 拒 commit 路径

let tmp: string;
let wtA: string;
let wtB: string;
let fakeBin: string;

const ENV = (() => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(k)) e[k] = v;
  }
  return e;
})();

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd, env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${r.stderr}`);
  return r.stdout.trim();
}

function markerName(branch: string) {
  return `otter-claim-ok-${N}-${branch.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** 真跑认领闸脚本（cwd 即仓库/worktree 顶层）；issue 号可换（拒 commit 路径用 N2） */
function runGateWith(cwd: string, issueNum: number) {
  const msgFile = join(tmp, `msg-${issueNum}.txt`);
  writeFileSync(msgFile, `[F20261119abcde][ci][New Feature] 测试提交（#${issueNum}）\n`);
  const r = spawnSync("node", ["scripts/commit-msg-claim-gate.mjs", msgFile], { encoding: "utf8", cwd, env: ENV });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function runGate(cwd: string) {
  return runGateWith(cwd, N);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "claim-gate-"));
  git(["init", "-b", "main"], tmp);
  git(["config", "user.email", "test@test"], tmp);
  git(["config", "user.name", "test"], tmp);
  git(["config", "core.hooksPath", ""], tmp);
  for (const s of SCRIPTS) {
    mkdirSync(dirname(join(tmp, s)), { recursive: true });
    writeFileSync(join(tmp, s), readFileSync(join(repoRoot, s)));
  }
  mkdirSync(join(tmp, ".githooks"), { recursive: true });
  writeFileSync(join(tmp, ".githooks", "commit-msg"), readFileSync(join(repoRoot, ".githooks", "commit-msg")));
  // fake gh：#N2 返回空评论（零认领 → 拒）；其余 exit 1（查询失败 → fail-open）
  fakeBin = join(tmp, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "gh"), "#!/bin/sh\nif [ \"$1\" = issue ] && [ \"$2\" = view ] && [ \"$3\" = 999000002 ]; then echo '[]'; exit 0; fi\nexit 1\n");
  chmodSync(join(fakeBin, "gh"), 0o755);
  ENV.PATH = `${fakeBin}:${ENV.PATH ?? ""}`;
  git(["add", "-A"], tmp);
  git(["commit", "--no-verify", "-m", "初始"], tmp);
  wtA = join(tmp, "wt-a");
  wtB = join(tmp, "wt-b");
  git(["worktree", "add", "-b", "fix/branch-a", wtA], tmp);
  git(["worktree", "add", "-b", "fix/branch-b", wtB], tmp);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("commit-msg 认领闸 marker 隔离（BLOCK-2 回归）", () => {
  it("worktree 私有 marker 命中 → 静默放行（零输出）", () => {
    const gitDirA = git(["rev-parse", "--absolute-git-dir"], wtA);
    writeFileSync(join(gitDirA, markerName("fix/branch-a")), String(Date.now()));
    const r = runGate(wtA);
    expect(r.code).toBe(0);
    expect(r.out).toBe(""); // 静默跳过，无 ⚠️/✅ 输出
  });

  it("他 worktree（不同分支）不继承 marker → 真走核验路径（fail-open 可观测）", () => {
    const r = runGate(wtB);
    expect(r.code).toBe(0); // gh 无 remote 必失败 → fail-open
    expect(r.out).toContain("认领闸"); // ⚠️ 输出证明未静默跳过
  });

  it("旧形态共享目录 marker（.git/worktrees/otter-claim-ok-N）不被消费", () => {
    // 修复前 bug 形态：dirname(git-dir) 落共享父目录，他线静默继承——锁死不复发
    writeFileSync(join(tmp, ".git", "worktrees", `otter-claim-ok-${N}`), String(Date.now()));
    const r = runGate(wtB);
    expect(r.code).toBe(0);
    expect(r.out).toContain("认领闸"); // 仍走核验路径，不认旧形态
  });

  it("同 worktree 切换分支后旧 marker 不命中（marker 绑分支，MINOR-1 缓解）", () => {
    // wt-b 当前分支 fix/branch-b；放入 fix/branch-c 的 marker 后切过去跑
    git(["checkout", "-b", "fix/branch-c"], wtB);
    const gitDirB = git(["rev-parse", "--absolute-git-dir"], wtB);
    writeFileSync(join(gitDirB, markerName("fix/branch-b")), String(Date.now()));
    const r = runGate(wtB); // fix/branch-c 无 marker
    expect(r.code).toBe(0);
    expect(r.out).toContain("认领闸"); // 未静默跳过——分支变了缓存失效
  });

  it("主仓形态：marker 落 .git/ 命中静默，工作树根无 marker 文件", () => {
    writeFileSync(join(tmp, ".git", markerName("main")), String(Date.now()));
    const r = runGate(tmp);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(existsSync(join(tmp, markerName("main")))).toBe(false); // 不落仓库根（dirname('.git')='.' 旧 bug）
  });
});

describe("hook F/R 分流（MINOR-2 回归）", () => {
  it("R 类提交引用 #N 同样过认领闸（不再被分流提前 exit 绕过）", () => {
    const msgFile = join(tmp, "r-msg.txt");
    writeFileSync(msgFile, `[R20261119abcde][docs] 研究记录（#${N}）\n`);
    const r = spawnSync("sh", [join(wtB, ".githooks", "commit-msg"), msgFile], { encoding: "utf8", cwd: wtB, env: ENV });
    expect(r.status).toBe(0); // 模板/中文/认领 fail-open 均放行
    expect(`${r.stdout}${r.stderr}`).toContain("认领闸"); // 闸被真调用（修复前 R 类静默绕过）
  });
});

describe("拒 commit 与退出码传播（修复轮新坦）", () => {
  it("issue 存在但零认领（fake gh 空评论）→ 闸 exit 1 拒 commit", () => {
    const r = runGateWith(wtB, N2);
    expect(r.code).toBe(1);
    expect(r.out).toContain("无有效认领");
  });

  it("hook 中间位退出码传播：闸 exit 1 → hook 整体 exit 1（sh 无 set -e 坏，曾实证 commit 照常落地）", () => {
    const msgFile = join(tmp, "block-msg.txt");
    writeFileSync(msgFile, `[F20261119abcde][ci][New Feature] 测试提交（#${N2}）\n`);
    const r = spawnSync("sh", [join(wtB, ".githooks", "commit-msg"), msgFile], { encoding: "utf8", cwd: wtB, env: ENV });
    expect(r.status).toBe(1); // 修复前：闸 exit 1 被 hook 后续命令覆盖 → exit 0
    expect(`${r.stdout}${r.stderr}`).toContain("无有效认领");
  });
});

describe("commit 侧提取语义（首行尾注 + closes 族，body 裸 #N 不计）", () => {
  it("首行尾注（#1951）+ body 叙述 #1899 → 只计 1951（本 PR 修复 commit 自身实证）", () => {
    const msg = "[F20261119claim][ci][BugFix] 修复（#1951）\n\nbody 叙述 #1899 被误当工作对象\n";
    expect(extractCommitIssueNumbers(msg)).toEqual([1951]);
  });

  it("body closes 族追加：首行无引用 + body Closes #42 → [42]", () => {
    expect(extractCommitIssueNumbers("[F20261119abcde][ci][New Feature] 标题\n\nCloses #42\n")).toEqual([42]);
  });

  it("首行与 body 均无引用 → 空", () => {
    expect(extractCommitIssueNumbers("[F20261119abcde][ci][New Feature] 标题\n\n普通 body\n")).toEqual([]);
  });
});
