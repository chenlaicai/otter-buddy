import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { platform, homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSandboxSpawnHook } from "../../../src/frameworks/agent/bash-sandbox";
import { evaluateGitExecution, resolveExternalGitWorktree, parseGitWorktreeList } from "../../../src/frameworks/agent/git-execution-policy";

// 每次断言都是真实 sandbox-exec（spawn 沙箱进程 + git 子进程），单用例十余次串联
// 在高负载下可超 vitest 默认 5s——对齐 halt-injection-wiring 惯例显式放宽（仅本文件）。
vi.setConfig({ testTimeout: 20_000 });

const isMac = platform() === "darwin";
const fixtureRoot = join(homedir(), `.git-sandbox-it-${process.pid}`);

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// eslint-disable-next-line max-lines-per-function -- 真沙箱集成面共享单一 fixture（repo/wt/hook）与断言上下文辅助；拆 describe 会复制 fixture 与 #1696（同文件并行改动）冲突面扩大，拆分留待该文件下一次结构整备
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
    const signal = result.signal ? `\n[spawn-signal] ${result.signal}` : "";
    const spawnError = result.error ? `\n[spawn-error] ${result.error.message}` : "";
    return { stdout: result.stdout ?? "", stderr: `${result.stderr ?? ""}${signal}${spawnError}`, code: result.status ?? 1 };
  }

  /** 断言上下文（检视 delta2 建议 4）：真沙箱失败断言只留 exit code 无法定位——断言消息附
   *  命令与 stderr/stdout（含 spawn 信号/异常），CI 日志即可直接复盘根因。 */
  function runCtx(command: string, r: { stdout: string; stderr: string; code: number }): string {
    return `命令: ${command}\nexit=${r.code} stderr=${r.stderr} stdout=${r.stdout}`;
  }

  /** 期望成功（exit 0）；失败时附完整命令输出上下文。 */
  function expectOk(command: string, cwd: string): void {
    const r = run(command, cwd);
    expect(r.code, `期望成功\n${runCtx(command, r)}`).toBe(0);
  }

  /** 期望非零退出（拒绝/不存在等）；意外成功时附完整命令输出上下文。 */
  function expectDenied(command: string, cwd: string): void {
    const r = run(command, cwd);
    expect(r.code, `期望非零\n${runCtx(command, r)}`).not.toBe(0);
  }

  it("默认任意命令不能写 .git，数据文本不被物理层误伤", () => {
    expectDenied(`touch ${repo}/.git/HEAD`, repo);
    expectDenied(`touch ${repo}/.git/worktrees/wt/HEAD`, repo);
    const echo = run("echo 'git commit -m x'", wt);
    expect(echo.code).toBe(0);
    expect(echo.stdout).toContain("git commit");
  });

  it("bash 物理层拒绝改写裸 .git 指针，动态路径也不能穿透", () => {
    const evil = join(fixtureRoot, "evil-pointer");
    writeFileSync(evil, `gitdir: ${join(fixtureRoot, "pwned")}\n`);
    expectDenied(`cp "${evil}" "${join(wt, ".git")}"`, wt);
    expectDenied(`node -e 'require("fs").writeFileSync(process.argv[1], "pwned")' "${join(wt, "." + "git")}"`, wt);
    expect(readFileSync(join(wt, ".git"), "utf8")).toContain("gitdir:");
  });

  it("worktree add 不向主仓、HOME 或任意临时目录注入内容", () => {
    for (const target of [join(fixtureRoot, "escape"), join(repo, "src-evil"), join(fixtureRoot, "home")]) {
      expectDenied(`git worktree add "${target}" HEAD`, repo);
      expect(existsSync(join(target, "a.txt"))).toBe(false);
    }
  });

  it("嵌套替换真正写 .git 时由 OS 拒绝", () => {
    const dollar = run(`echo "$(touch ${repo}/.git/HEAD)"`, wt);
    const tick = run(`echo "\`touch ${repo}/.git/HEAD\`"`, wt);
    // echo 可能吞掉替换子命令的非零状态，必须验证真实目标未被写。
    expect(`${dollar.stderr}${tick.stderr}`).toContain("Operation not permitted");
    expectDenied(`git status && touch ${repo}/.git/HEAD`, wt);
  });

  it("直接 add/commit、只读命令与 cd && git 均可用", () => {
    writeFileSync(join(wt, "b.txt"), "change");
    expectOk("git add b.txt", wt);
    expectOk("git -c user.email=p@t -c user.name=p commit -qm test", wt);
    expectOk("git status --porcelain", wt);
    expectOk("git log --oneline -1", wt);
    expectOk("git diff --stat", wt);
    expectOk(`cd ${wt} && git status --porcelain`, repo);
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
    expect(hook({ command: "git add feature.txt", cwd: externalWt, env: {} }).command)
      // #1688 起窄写域 profile 为 regex 形态（路径点号转义）+ 外层 JSON.stringify 再转义：
      // 断言锚定 external-repo 与 .git/worktrees/feature 间 1-2 反斜杠的转义形态（检视 delta2
      // 失败 A 根因：纯文本比对自 #1688 起永失配），语义不变：外部 grant 必须落到外部仓 worktree gitdir。
      .toMatch(/external-repo\\{1,2}\.git\/worktrees\/feature/);
    expect(firstAdd.stderr).toBe("");
    expect(firstAdd.code, runCtx("git add feature.txt", firstAdd)).toBe(0);
    expectOk("git commit -qm external", externalWt);
    writeFileSync(join(externalWt, "feature-2.txt"), "change-2");
    expectOk("git add feature-2.txt", externalWt);
    expectOk(`git -C ${externalWt} commit -qm external-c-flag`, "/tmp");
    writeFileSync(join(externalWt, "feature-3.txt"), "change-3");
    expectOk("git add feature-3.txt", externalWt);
    expectOk(`cd ${externalWt} && git commit -qm external-cd`, repo);

    writeFileSync(join(externalRepo, "main.txt"), "forbidden");
    expectDenied(`git -C ${externalRepo} add main.txt`, "/tmp");
    expectDenied(`git -C ${externalRepo} commit -qm forbidden`, "/tmp");

    // 外部 grant 不能把宿主仓只读域或 worktree .git 指针保护换掉。
    // 通过 Git 自身 pre-commit 钩子发真实副作用，覆盖“授权 profile 已切到外部仓”的路径。
    const hostProbe = join(repo, "external-hook-escape");
    const pointerPath = join(externalWt, ".git");
    const originalPointer = readFileSync(pointerPath, "utf8");
    const preCommit = join(externalRepo, ".git", "hooks", "pre-commit");
    writeFileSync(preCommit, `#!/bin/sh\nprintf escape > "${hostProbe}"\nprintf escape > "${pointerPath}"\n`, { mode: 0o755 });
    expectDenied("git commit --allow-empty -qm hook-must-not-escape", externalWt);
    expect(existsSync(hostProbe)).toBe(false);
    expect(readFileSync(pointerPath, "utf8")).toBe(originalPointer);
    rmSync(preCommit);

    const unregistered = join(externalRepo, ".otter", "worktrees", "unregistered");
    mkdirSync(unregistered, { recursive: true });
    writeFileSync(join(unregistered, ".git"), readFileSync(pointerPath, "utf8"));
    writeFileSync(join(unregistered, "feature.txt"), "not-registered");
    expect(resolveExternalGitWorktree(unregistered)).toBeNull();
    expectDenied("git add feature.txt", unregistered);
  });

  it("主仓工作树直接 add/commit 无写 capability", () => {
    writeFileSync(join(repo, "c.txt"), "main");
    expectDenied("git add c.txt", repo);
    expectDenied("git -c user.email=p@t -c user.name=p commit -qm main", repo);
    expect(existsSync(join(repo, ".git", "index"))).toBe(true);
  });

  it("带空格/子目录/attached -C 与新建 worktree 立即可用", () => {
    const spaced = join(repo, ".otter", "worktrees", "work tree spaced");
    expectOk(`git worktree add -b spaced-branch "${spaced}" HEAD`, repo);
    mkdirSync(join(spaced, "nested"), { recursive: true });
    writeFileSync(join(spaced, "nested", "space.txt"), "space");
    expectOk(`git -C "${spaced}/nested" add space.txt`, "/tmp");
    const attachedC = run(`git -C${JSON.stringify(join(spaced, "nested"))} -c user.email=p@t -c user.name=p commit -qm spaced`, "/tmp"); // attached -C 不是 git 合法 CLI；无授权且原样失败
    expect(attachedC.code, `期望 129（attached -C 非法 CLI 原样失败）\n${runCtx("git -C\"…\" commit", attachedC)}`).toBe(129);
    expectOk(`git -C "${spaced}/nested" -c user.email=p@t -c user.name=p commit -qm spaced`, "/tmp");
    expectOk(`git -C "${spaced}" status --porcelain`, "/tmp");
  });

  it("worktree remove、fetch、merge 与普通分支删除可用", () => {
    const removable = join(repo, ".otter", "worktrees", "remove-me");
    const removableAdd = run(`git worktree add -b removable-branch "${removable}" HEAD`, repo);
    expect(removableAdd.stderr).not.toContain("Operation not permitted");
    expect(removableAdd.code, runCtx("git worktree add -b removable-branch", removableAdd)).toBe(0);
    const removed = run(`git worktree remove "${removable}"`, repo);
    expect(removed.stderr).not.toContain("Operation not permitted");
    expect(removed.code, runCtx("git worktree remove", removed)).toBe(0);
    const bare = join(fixtureRoot, "remote.git");
    mkdirSync(bare, { recursive: true });
    git(bare, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    expectOk("git fetch --all", wt);
    expectOk("git fetch --prune", wt);
    expectOk("git fetch origin", repo);
    expectOk("git fetch origin", join(repo, ".git"));
    expectOk("git merge --no-edit main", wt);
    git(wt, ["branch", "scratch", "HEAD"]);
    expectOk("git branch -d scratch", wt);
  });

  it("push 只授本地所需域，外部 bare remote 可写由远端自身权限决定", () => {
    const bare = join(fixtureRoot, "remote2.git");
    mkdirSync(bare, { recursive: true });
    git(bare, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin2", bare]);
    expectOk("git push origin2 HEAD:feature-test", wt);
  });

  it("profile 授权不串权，路径之外仍未登记", () => {
    const missing = run("git -C /unknown/path status", "/tmp");
    expect(missing.code, runCtx("git -C /unknown/path status", missing)).not.toBe(0);
    expect(missing.stderr).toContain("No such file or directory");
    expectDenied("touch /unknown/path", "/tmp");
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
    // 检视 delta2 严重 3 诊断锚：授权链路与净 patch-id 判据分层验证——①注入判据证链路可达；
    // ②真实判据（净 patch-id squash 等价）在 fixture 真跑为真；③未合并分支真实判据拒绝。
    // 真删失败时据此区分「判据/链路」与「沙箱执行面」两类根因（expectOk/expectDenied 已附 stderr/stdout）。
    const registry = parseGitWorktreeList(repo);
    expect(evaluateGitExecution("git branch -D feat-squash", wt, {
      repoRoot: repo, linkedWorktrees: registry, branchContentMerged: () => true,
    })?.kind, "注入判据下 -D 链路必须产出 grant").toBe("branch-delete");
    expect(evaluateGitExecution("git branch -D feat-squash", wt, {
      repoRoot: repo, linkedWorktrees: registry,
    })?.kind, "净 patch-id squash 等价判定必须为真并产出 grant").toBe("branch-delete");
    expect(evaluateGitExecution("git branch -D feat-unmerged-case", wt, {
      repoRoot: repo, linkedWorktrees: registry,
    }), "未合并分支真实判据必须拒绝").toBeNull();
    expectDenied("git branch -D feat-unmerged-case", wt);
    expectOk("git branch -D feat-squash", wt);
    expectDenied("git show-ref --verify --quiet refs/heads/feat-squash", wt);
  });

  it("F20261029clnup 残渣 Unicode 归一化变体不豁免（检视 delta2 严重 1）：NFC/NFD 互查均拒，已跟踪文件存活", () => {
    // macOS APFS 归一化不敏感：NFC 名与 NFD 名目录项同一 inode；且 git 默认 core.quotePath
    // 对非 ASCII 名 C 转义——修复前 ls-files 字符串比对两种拼写皆漏（检视 delta2 外部实测）：
    // 误判未跟踪残渣后豁免删除落到已跟踪目录项（回归钉：修复前本用例红）。
    const nfc = "f8-probe-\u00e9.txt"; // é = NFC 单码位
    const nfd = nfc.normalize("NFD"); // e + 组合尖音符
    writeFileSync(join(repo, nfd), "tracked\n"); // 工作树目录项按 NFD 字节落盘（APFS 保字节）
    const blob = execFileSync("git", ["hash-object", "-w", join(repo, nfd)], { cwd: repo, encoding: "utf8" }).trim();
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${nfc}`]); // 索引登记 NFC 名
    for (const [label, spelling] of [["NFD", nfd], ["NFC", nfc]] as const) {
      const r = run(`rm ${join(repo, spelling)}`, repo);
      expect(r.code, `期望拒绝（${label} 拼写）\n${runCtx(`rm <${label}拼写 f8-probe-é.txt>`, r)}`).not.toBe(0);
    }
    expect(existsSync(join(repo, nfd)), "同一目录项（两种拼写同 inode）必须存活").toBe(true);
    // 正向不回归：真未跟踪的 Unicode 残渣仍可自清
    const untrackedNfd = "f7-probe-\u00e92.txt".normalize("NFD");
    writeFileSync(join(repo, untrackedNfd), "debris\n");
    const ok = run(`rm ${join(repo, untrackedNfd)}`, repo);
    expect(ok.code, runCtx("rm <未跟踪 NFD 残渣>", ok)).toBe(0);
    expect(existsSync(join(repo, untrackedNfd))).toBe(false);
  });

  it("F20261029clnup 探针残渣 rm（沙箱真执行）：主仓根残渣删除成功", () => {
    writeFileSync(join(repo, "f3-probe-e2e.txt"), "debris");
    expectOk(`rm ${join(repo, "f3-probe-e2e.txt")}`, repo);
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
    expect(r.code, runCtx("rm f9-probe-tracked-e2e.txt", r)).not.toBe(0);
    expect(existsSync(join(repo, "f9-probe-tracked-e2e.txt"))).toBe(true);
  });

  it("F20261029clnup 残渣大小写变体不豁免（检视一轮严重 1）：全大写变体 rm 被拒，已跟踪文件存活", () => {
    // macOS 大小写不敏感文件系统上 F9-PROBE-TRACKED-E2E.TXT 命中同一目录项——修复前
    // 精确路径查询被大小写变体绕开（core.ignorecase 下 ls-files 变体名返回空），
    // 误判未跟踪残渣后豁免删除落到已跟踪文件（回归钉：修复前本用例红）。
    ensureTrackedProbeFile();
    const r = run("rm F9-PROBE-TRACKED-E2E.TXT", repo);
    expect(r.code, runCtx("rm F9-PROBE-TRACKED-E2E.TXT", r)).not.toBe(0);
    expect(existsSync(join(repo, "f9-probe-tracked-e2e.txt"))).toBe(true);
  });

  it("F20261029clnup 残渣多目标 rm 被拒（检视一轮严重 4）：两残渣文件均存活", () => {
    writeFileSync(join(repo, "f3-probe-e2e-a.txt"), "a");
    writeFileSync(join(repo, "f3-probe-e2e-b.txt"), "b");
    const r = run(`rm ${join(repo, "f3-probe-e2e-a.txt")} ${join(repo, "f3-probe-e2e-b.txt")}`, repo);
    expect(r.code, runCtx("rm 两残渣", r)).not.toBe(0);
    expect(existsSync(join(repo, "f3-probe-e2e-a.txt"))).toBe(true);
    expect(existsSync(join(repo, "f3-probe-e2e-b.txt"))).toBe(true);
  });

  it("F20261029clnup 残渣链式 rm 被拒（形态锚定整命令）：两残渣文件均存活", () => {
    writeFileSync(join(repo, "f3-probe-e2e-c.txt"), "c");
    writeFileSync(join(repo, "f3-probe-e2e-d.txt"), "d");
    const r = run(`rm ${join(repo, "f3-probe-e2e-c.txt")} && rm ${join(repo, "f3-probe-e2e-d.txt")}`, repo);
    expect(r.code, runCtx("链式 rm 两残渣", r)).not.toBe(0);
    expect(existsSync(join(repo, "f3-probe-e2e-c.txt"))).toBe(true);
    expect(existsSync(join(repo, "f3-probe-e2e-d.txt"))).toBe(true);
  });
});
