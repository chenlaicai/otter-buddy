import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { platform, homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSandboxSpawnHook } from "../../../src/frameworks/agent/bash-sandbox";

const isMac = platform() === "darwin";
const fixtureRoot = join(homedir(), `.git-sandbox-it-${process.pid}`);

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe.skipIf(!isMac)("F20261027gscv Git 执行域真实 sandbox", () => {
  let repo: string;
  let wt: string;
  let hook: ReturnType<typeof createSandboxSpawnHook>;

  beforeAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    repo = join(fixtureRoot, "repo");
    wt = join(fixtureRoot, "wt");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "probe@test"]);
    git(repo, ["config", "user.name", "probe"]);
    writeFileSync(join(repo, "a.txt"), "hello");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["worktree", "add", "-q", wt]);
    hook = createSandboxSpawnHook(repo, join(fixtureRoot, "data"));
  });

  afterAll(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });

  function run(command: string, cwd: string): { stdout: string; stderr: string; code: number } {
    const ctx = hook({ command, cwd, env: {} });
    // spawnSync 不抛异常：替换子命令失败但 echo 返回 0 时也能拿到 stderr/状态。
    const result = spawnSync("/bin/bash", ["-c", ctx.command], { cwd: ctx.cwd, encoding: "utf8" });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
  }

  it("默认任意命令不能写 .git，数据文本不被物理层误伤", () => {
    expect(run(`touch ${repo}/.git/HEAD`, repo).code).not.toBe(0);
    expect(run(`touch ${repo}/.git/worktrees/wt/HEAD`, repo).code).not.toBe(0);
    const echo = run("echo 'git commit -m x'", wt);
    expect(echo.code).toBe(0);
    expect(echo.stdout).toContain("git commit");
  });

  it("嵌套替换真正写 .git 时由 OS 拒绝", () => {
    const dollar = run(`echo "$(touch ${repo}/.git/HEAD)"`, wt);
    const tick = run(`echo "\`touch ${repo}/.git/HEAD\`"`, wt);
    // echo 可能吞掉替换子命令的非零状态，必须验证真实目标未被写。
    expect(`${dollar.stderr}${tick.stderr}`).toContain("Operation not permitted");
    expect(run(`git status && touch ${repo}/.git/HEAD`, wt).code).not.toBe(0);
  });

  it("直接 add/commit、只读命令与 cd && git 均可用", () => {
    writeFileSync(join(wt, "b.txt"), "change");
    expect(run("git add b.txt", wt).code).toBe(0);
    expect(run("git -c user.email=p@t -c user.name=p commit -qm test", wt).code).toBe(0);
    expect(run("git status --porcelain", wt).code).toBe(0);
    expect(run("git log --oneline -1", wt).code).toBe(0);
    expect(run("git diff --stat", wt).code).toBe(0);
    expect(run(`cd ${wt} && git status --porcelain`, repo).code).toBe(0);
  });

  it("主仓工作树直接 add/commit 无写 capability", () => {
    writeFileSync(join(repo, "c.txt"), "main");
    expect(run("git add c.txt", repo).code).not.toBe(0);
    expect(run("git -c user.email=p@t -c user.name=p commit -qm main", repo).code).not.toBe(0);
    expect(existsSync(join(repo, ".git", "index"))).toBe(true);
  });

  it("带空格/子目录/attached -C 与新建 worktree 立即可用", () => {
    const spaced = join(fixtureRoot, "work tree spaced");
    expect(run(`git worktree add "${spaced}" HEAD`, repo).code).toBe(0);
    mkdirSync(join(spaced, "nested"), { recursive: true });
    writeFileSync(join(spaced, "nested", "space.txt"), "space");
    expect(run(`git -C "${spaced}/nested" add space.txt`, "/tmp").code).toBe(0);
    expect(run(`git -C${JSON.stringify(join(spaced, "nested"))} -c user.email=p@t -c user.name=p commit -qm spaced`, "/tmp").code).toBe(129); // attached -C 不是 git 合法 CLI；无授权且原样失败
    expect(run(`git -C "${spaced}/nested" -c user.email=p@t -c user.name=p commit -qm spaced`, "/tmp").code).toBe(0);
    expect(run(`git -C "${spaced}" status --porcelain`, "/tmp").code).toBe(0);
  });

  it("worktree remove、fetch、merge 与普通分支删除可用", () => {
    const removable = join(fixtureRoot, "remove-me");
    expect(run(`git worktree add "${removable}" HEAD`, repo).code).toBe(0);
    expect(run(`git worktree remove "${removable}"`, repo).code).toBe(0);
    const bare = join(fixtureRoot, "remote.git");
    mkdirSync(bare, { recursive: true });
    git(bare, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    expect(run("git fetch --all", wt).code).toBe(0);
    expect(run("git fetch --prune", wt).code).toBe(0);
    expect(run("git fetch origin", repo).code).toBe(0);
    expect(run("git fetch origin", join(repo, ".git")).code).toBe(0);
    expect(run("git merge --no-edit main", wt).code).toBe(0);
    git(wt, ["branch", "scratch", "HEAD"]);
    expect(run("git branch -d scratch", wt).code).toBe(0);
  });

  it("push 只授本地所需域，外部 bare remote 可写由远端自身权限决定", () => {
    const bare = join(fixtureRoot, "remote2.git");
    mkdirSync(bare, { recursive: true });
    git(bare, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin2", bare]);
    expect(run("git push origin2 HEAD:feature-test", wt).code).toBe(0);
  });

  it("profile 授权不串权，路径之外仍未登记", () => {
    const missing = run("git -C /unknown/path status", "/tmp");
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("No such file or directory");
    expect(run("touch /unknown/path", "/tmp").code).not.toBe(0);
  });
});
