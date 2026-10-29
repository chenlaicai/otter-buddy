import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { platform, homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSandboxSpawnHook } from "../../../src/frameworks/agent/bash-sandbox";
import { resolveExternalGitWorktree, parseGitWorktreeList } from "../../../src/frameworks/agent/git-execution-policy";

// 每次断言都是真实 sandbox-exec（spawn 沙箱进程 + git 子进程），单用例十余次串联
// 在高负载下可超 vitest 默认 5s——对齐 halt-injection-wiring 惯例显式放宽（仅本文件）。
vi.setConfig({ testTimeout: 20_000 });

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

  it("bash 物理层拒绝改写裸 .git 指针，动态路径也不能穿透", () => {
    const evil = join(fixtureRoot, "evil-pointer");
    writeFileSync(evil, `gitdir: ${join(fixtureRoot, "pwned")}\n`);
    expect(run(`cp "${evil}" "${join(wt, ".git")}"`, wt).code).not.toBe(0);
    expect(run(`node -e 'require("fs").writeFileSync(process.argv[1], "pwned")' "${join(wt, "." + "git")}"`, wt).code).not.toBe(0);
    expect(readFileSync(join(wt, ".git"), "utf8")).toContain("gitdir:");
  });

  it("worktree add 不向主仓、HOME 或任意临时目录注入内容", () => {
    for (const target of [join(fixtureRoot, "escape"), join(repo, "src-evil"), join(fixtureRoot, "home")]) {
      expect(run(`git worktree add "${target}" HEAD`, repo).code).not.toBe(0);
      expect(existsSync(join(target, "a.txt"))).toBe(false);
    }
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

  it("#1682 外部仓隔离 worktree 可提交，主目录仍无写 capability", () => {
    const externalRepo = join(fixtureRoot, "external-repo");
    const externalWt = join(externalRepo, ".otter", "worktrees", "feature");
    mkdirSync(externalRepo, { recursive: true });
    git(externalRepo, ["init", "-q"]);
    git(externalRepo, ["config", "user.email", "probe@test"]);
    git(externalRepo, ["config", "user.name", "probe"]);
    writeFileSync(join(externalRepo, "a.txt"), "external");
    git(externalRepo, ["add", "a.txt"]);
    git(externalRepo, ["commit", "-qm", "init"]);
    git(externalRepo, ["worktree", "add", "-qb", "feature", externalWt]);

    writeFileSync(join(externalWt, "feature.txt"), "change");
    const firstAdd = run("git add feature.txt", externalWt);
    expect(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: externalWt, encoding: "utf8" }).trim()).toBe(externalWt);
    expect(execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: externalRepo, encoding: "utf8" })).toContain(externalWt);
    expect([...parseGitWorktreeList(externalRepo)]).toContainEqual([externalWt, "feature"]);
    expect(resolveExternalGitWorktree(externalWt)).toMatchObject({ repoRoot: externalRepo, worktreeRoot: externalWt });
    expect(hook({ command: "git add feature.txt", cwd: externalWt, env: {} }).command).toContain("external-repo/.git/worktrees/feature");
    expect(firstAdd.stderr).toBe("");
    expect(firstAdd.code).toBe(0);
    expect(run("git commit -qm external", externalWt).code).toBe(0);
    writeFileSync(join(externalWt, "feature-2.txt"), "change-2");
    expect(run("git add feature-2.txt", externalWt).code).toBe(0);
    expect(run(`git -C ${externalWt} commit -qm external-c-flag`, "/tmp").code).toBe(0);
    writeFileSync(join(externalWt, "feature-3.txt"), "change-3");
    expect(run("git add feature-3.txt", externalWt).code).toBe(0);
    expect(run(`cd ${externalWt} && git commit -qm external-cd`, repo).code).toBe(0);

    writeFileSync(join(externalRepo, "main.txt"), "forbidden");
    expect(run(`git -C ${externalRepo} add main.txt`, "/tmp").code).not.toBe(0);
    expect(run(`git -C ${externalRepo} commit -qm forbidden`, "/tmp").code).not.toBe(0);

    // 外部 grant 不能把宿主仓只读域或 worktree .git 指针保护换掉。
    // 通过 Git 自身 pre-commit 钩子发真实副作用，覆盖“授权 profile 已切到外部仓”的路径。
    const hostProbe = join(repo, "external-hook-escape");
    const pointerPath = join(externalWt, ".git");
    const originalPointer = readFileSync(pointerPath, "utf8");
    const preCommit = join(externalRepo, ".git", "hooks", "pre-commit");
    writeFileSync(preCommit, `#!/bin/sh\nprintf escape > "${hostProbe}"\nprintf escape > "${pointerPath}"\n`, { mode: 0o755 });
    expect(run("git commit --allow-empty -qm hook-must-not-escape", externalWt).code).not.toBe(0);
    expect(existsSync(hostProbe)).toBe(false);
    expect(readFileSync(pointerPath, "utf8")).toBe(originalPointer);
    rmSync(preCommit);

    const unregistered = join(externalRepo, ".otter", "worktrees", "unregistered");
    mkdirSync(unregistered, { recursive: true });
    writeFileSync(join(unregistered, ".git"), readFileSync(pointerPath, "utf8"));
    writeFileSync(join(unregistered, "feature.txt"), "not-registered");
    expect(resolveExternalGitWorktree(unregistered)).toBeNull();
    expect(run("git add feature.txt", unregistered).code).not.toBe(0);
  });

  it("主仓工作树直接 add/commit 无写 capability", () => {
    writeFileSync(join(repo, "c.txt"), "main");
    expect(run("git add c.txt", repo).code).not.toBe(0);
    expect(run("git -c user.email=p@t -c user.name=p commit -qm main", repo).code).not.toBe(0);
    expect(existsSync(join(repo, ".git", "index"))).toBe(true);
  });

  it("带空格/子目录/attached -C 与新建 worktree 立即可用", () => {
    const spaced = join(repo, ".otter", "worktrees", "work tree spaced");
    expect(run(`git worktree add -b spaced-branch "${spaced}" HEAD`, repo).code).toBe(0);
    mkdirSync(join(spaced, "nested"), { recursive: true });
    writeFileSync(join(spaced, "nested", "space.txt"), "space");
    expect(run(`git -C "${spaced}/nested" add space.txt`, "/tmp").code).toBe(0);
    expect(run(`git -C${JSON.stringify(join(spaced, "nested"))} -c user.email=p@t -c user.name=p commit -qm spaced`, "/tmp").code).toBe(129); // attached -C 不是 git 合法 CLI；无授权且原样失败
    expect(run(`git -C "${spaced}/nested" -c user.email=p@t -c user.name=p commit -qm spaced`, "/tmp").code).toBe(0);
    expect(run(`git -C "${spaced}" status --porcelain`, "/tmp").code).toBe(0);
  });

  it("worktree remove、fetch、merge 与普通分支删除可用", () => {
    const removable = join(repo, ".otter", "worktrees", "remove-me");
    const removableAdd = run(`git worktree add -b removable-branch "${removable}" HEAD`, repo);
    expect(removableAdd.stderr).not.toContain("Operation not permitted");
    expect(removableAdd.code).toBe(0);
    const removed = run(`git worktree remove "${removable}"`, repo);
    expect(removed.stderr).not.toContain("Operation not permitted");
    expect(removed.code).toBe(0);
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

  it("F20261029clnup branch -D 窄受控（沙箱真执行）：squash 合入分支可强删，未合并分支拒绝", () => {
    try { git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/main"]); } catch { git(repo, ["branch", "main", "HEAD"]); }
    git(repo, ["checkout", "-q", "main"]);
    // squash 合入分支：两提交 → main 单提交落地（净 patch-id 等价）
    git(repo, ["checkout", "-q", "-b", "feat-squash"]);
    writeFileSync(join(repo, "b-case.txt"), "b\n"); git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "B"]);
    writeFileSync(join(repo, "c-case.txt"), "c\n"); git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "C"]);
    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "b-case.txt"), "b\n"); writeFileSync(join(repo, "c-case.txt"), "c\n");
    git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "squash feat-squash"]);
    // 未合并分支（真实工作，必须拒绝）
    git(repo, ["checkout", "-q", "-b", "feat-unmerged-case"]);
    writeFileSync(join(repo, "d-case.txt"), "d\n"); git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "D"]);
    git(repo, ["checkout", "-q", "main"]);
    expect(run("git branch -D feat-unmerged-case", wt).code).not.toBe(0);
    expect(run("git branch -D feat-squash", wt).code).toBe(0);
    expect(run("git show-ref --verify --quiet refs/heads/feat-squash", wt).code).not.toBe(0);
  });

  it("F20261029clnup 探针残渣 rm（沙箱真执行）：主仓根残渣删除成功", () => {
    writeFileSync(join(repo, "f3-probe-e2e.txt"), "debris");
    expect(run(`rm ${join(repo, "f3-probe-e2e.txt")}`, repo).code).toBe(0);
    expect(existsSync(join(repo, "f3-probe-e2e.txt"))).toBe(false);
  });

  // 已跟踪同模式文件 fixture（两负向用例共用，幂等自备——单跑任一用例也成立）
  function ensureTrackedProbeFile(): void {
    const tracked = join(repo, "f9-probe-tracked-e2e.txt");
    if (existsSync(tracked)) return;
    writeFileSync(tracked, "tracked\n");
    git(repo, ["add", "f9-probe-tracked-e2e.txt"]);
    git(repo, ["commit", "-qm", "track probe-pattern file"]);
  }

  it("F20261029clnup 残渣负向（沙箱真执行）：已跟踪同模式文件 rm 被拒，文件存活", () => {
    ensureTrackedProbeFile();
    const r = run("rm f9-probe-tracked-e2e.txt", repo);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(repo, "f9-probe-tracked-e2e.txt"))).toBe(true);
  });

  it("F20261029clnup 残渣大小写变体不豁免（检视一轮严重 1）：全大写变体 rm 被拒，已跟踪文件存活", () => {
    // macOS 大小写不敏感文件系统上 F9-PROBE-TRACKED-E2E.TXT 命中同一目录项——修复前
    // 精确路径查询被大小写变体绕开（core.ignorecase 下 ls-files 变体名返回空），
    // 误判未跟踪残渣后豁免删除落到已跟踪文件（回归钉：修复前本用例红）。
    ensureTrackedProbeFile();
    const r = run("rm F9-PROBE-TRACKED-E2E.TXT", repo);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(repo, "f9-probe-tracked-e2e.txt"))).toBe(true);
  });

  it("F20261029clnup 残渣多目标 rm 被拒（检视一轮严重 4）：两残渣文件均存活", () => {
    writeFileSync(join(repo, "f3-probe-e2e-a.txt"), "a");
    writeFileSync(join(repo, "f3-probe-e2e-b.txt"), "b");
    const r = run(`rm ${join(repo, "f3-probe-e2e-a.txt")} ${join(repo, "f3-probe-e2e-b.txt")}`, repo);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(repo, "f3-probe-e2e-a.txt"))).toBe(true);
    expect(existsSync(join(repo, "f3-probe-e2e-b.txt"))).toBe(true);
  });

  it("F20261029clnup 残渣链式 rm 被拒（形态锚定整命令）：两残渣文件均存活", () => {
    writeFileSync(join(repo, "f3-probe-e2e-c.txt"), "c");
    writeFileSync(join(repo, "f3-probe-e2e-d.txt"), "d");
    const r = run(`rm ${join(repo, "f3-probe-e2e-c.txt")} && rm ${join(repo, "f3-probe-e2e-d.txt")}`, repo);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(repo, "f3-probe-e2e-c.txt"))).toBe(true);
    expect(existsSync(join(repo, "f3-probe-e2e-d.txt"))).toBe(true);
  });
});
