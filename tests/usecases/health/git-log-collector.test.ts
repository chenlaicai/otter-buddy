import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectGitLogWithFiles } from "@usecases/health/git-log-collector";

/**
 * 自包含 fixture：临时 git 仓库（不依赖宿主仓库的克隆深度/merge 状态，
 * CI 浅克隆环境下同样可跑）。验证采集→解析→文件列表聚合的完整链路。
 */
describe("collectGitLogWithFiles（临时仓库 fixture）", () => {
  let repoDir: string;

  function git(args: string[]): void {
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  }

  async function commitFile(file: string, content: string, message: string): Promise<void> {
    const fullPath = path.join(repoDir, file);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    git(["add", file]);
    git(["commit", "-m", message]);
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "rhi-git-test-"));
    git(["init"]);
    // 显式 main：ref 默认值依赖 main 存在；老版 git 不支持 init -b，用 symbolic-ref 兼容
    git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "RHI Test"]);
    await commitFile("a.txt", "hello", "[F20260824tst1][health][New Feature] 第一个特性");
    await commitFile("src/b.ts", "export {}", "[F20260824tst2][agent][BugFix] 修复解析歧义 (#42)");
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("采集全部 commit 且顺序为新→旧", async () => {
    const commits = await collectGitLogWithFiles(repoDir);
    expect(commits).toHaveLength(2);
    expect(commits[0].message).toContain("tst2");
    expect(commits[1].message).toContain("tst1");
  });

  it("commit 记录结构完整：40 位 sha / ISO 日期 / message / filesChanged", async () => {
    const [first] = await collectGitLogWithFiles(repoDir);
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(first.message).toContain("tst2");
    expect(Array.isArray(first.filesChanged)).toBe(true);
  });

  it("文件列表与 commit 内容对齐", async () => {
    const commits = await collectGitLogWithFiles(repoDir);
    expect(commits[0].filesChanged).toEqual(["src/b.ts"]);
    expect(commits[1].filesChanged).toEqual(["a.txt"]);
  });

  it("message 含 | 和多行时不破坏解析（分隔符方案的核心价值）", async () => {
    // 追加一个 message 带 | 的 commit，验证不与分隔符混淆
    await commitFile("pipe.txt", "x", "[F20260824tst3][health][Feature Update] 带|竖线|的标题");
    const commits = await collectGitLogWithFiles(repoDir);
    expect(commits).toHaveLength(3);
    expect(commits[0].message).toBe("[F20260824tst3][health][Feature Update] 带|竖线|的标题");
    expect(commits[0].filesChanged).toEqual(["pipe.txt"]);
  });

  it("maxCount 截断", async () => {
    const commits = await collectGitLogWithFiles(repoDir, { maxCount: 1 });
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toContain("tst3");
  });

  it("ref 参数：默认统计 main，在非 main 分支上运行时不受当前分支影响", async () => {
    // 切到 side 分支追加 commit，验证默认仍采 main
    git(["checkout", "-b", "side"]);
    await commitFile("side-only.txt", "s", "side 分支的 commit");

    const defaultRef = await collectGitLogWithFiles(repoDir);
    expect(defaultRef.some(c => c.message.includes("side"))).toBe(false);

    const onMain = await collectGitLogWithFiles(repoDir, { ref: "main" });
    expect(onMain).toEqual(defaultRef);

    const onSide = await collectGitLogWithFiles(repoDir, { ref: "side" });
    expect(onSide[0].message).toContain("side");

    git(["checkout", "main"]);
  });

  // ── #426 边界场景补齐：rename / binary / 空 commit / merge / 多行 message ──
  // 基于各形态真实输出实测（2026-09-21，git 2.x --name-only）后写断言，
  // 不是按想象中的行为写。

  it("#426 rename commit：--name-only 只输出新路径，不双计 old/new（实测锁定）", async () => {
    git(["mv", "a.txt", "renamed-a.txt"]);
    git(["add", "-A"]);
    git(["commit", "-m", "[F20260921tst4][health][Refactor] 重命名文件"]);
    const commits = await collectGitLogWithFiles(repoDir);
    const renameCommit = commits.find(c => c.message.includes("tst4"));
    expect(renameCommit).toBeDefined();
    // 实测：git log --name-only 对 rename 只输出新路径（与 diff-tree -r 的 old+new 两行不同）。
    // 文件热点不会把 rename 算作两次修改——issue #426 的双计担忧在此采集路径不成立。
    // 锁定该行为：若未来 git 版本/参数变更导致双计，本断言会红。
    expect(renameCommit?.filesChanged).toEqual(["renamed-a.txt"]);
  });

  it("#426 二进制文件：计入 filesChanged（无特殊处理，热点计数与文本文件同权）", async () => {
    const binPath = path.join(repoDir, "asset.bin");
    // 写入含 NUL 字节的真二进制内容（git 会识别为 binary）
    await writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0xff]), null);
    git(["add", "asset.bin"]);
    git(["commit", "-m", "[F20260921tst5][health][New Feature] 加二进制资产"]);
    const commits = await collectGitLogWithFiles(repoDir);
    const binCommit = commits.find(c => c.message.includes("tst5"));
    expect(binCommit?.filesChanged).toContain("asset.bin");
  });

  it("#426 空 commit：filesChanged 为空数组，解析不炸", async () => {
    git(["commit", "--allow-empty", "-m", "[F20260921tst6][health][Chore] 空提交"]);
    const commits = await collectGitLogWithFiles(repoDir);
    const emptyCommit = commits.find(c => c.message.includes("tst6"));
    expect(emptyCommit).toBeDefined();
    expect(emptyCommit?.filesChanged).toEqual([]);
  });

  it("#426 merge commit：默认策略不带 -m，文件列表为空，不计数", async () => {
    // 制造真 merge：side 分支有独立 commit，回 main 合入。
    // --no-ff 必需：否则 main 无分叉时 fast-forward 不产生 merge commit（实测踩过）
    git(["checkout", "-b", "feature-merge"]);
    await commitFile("merge-side.txt", "m", "[F20260921tst7][health][New Feature] 待合分支");
    git(["checkout", "main"]);
    git(["merge", "--no-ff", "feature-merge", "-m", "[F20260921tst8][health][Feature Update] 合入 feature-merge"]);
    const commits = await collectGitLogWithFiles(repoDir);
    const mergeCommit = commits.find(c => c.message.includes("tst8"));
    expect(mergeCommit).toBeDefined();
    // 实测：git log --name-only 对 merge commit（不带 -m first-parent 展开）输出空文件列表
    // ——metrics-calculator 侧 "merge commit 空文件列表不计数" 已有断言，此处锁定采集层行为
    expect(mergeCommit?.filesChanged).toEqual([]);
  });

  it("#426 多行 message：%s 只取首行，后续行不渗入 filesChanged（实测锁定）", async () => {
    git(["commit", "--allow-empty", "-m", "[F20260921tst9][health][Chore] 标题行\n\n正文第二行\n第三行"]);
    const commits = await collectGitLogWithFiles(repoDir);
    const multiCommit = commits.find(c => c.message.includes("tst9"));
    expect(multiCommit).toBeDefined();
    // %s 只输出首行——message 是纯标题，正文行不会污染解析（也不会被误当文件名）
    expect(multiCommit?.message).toBe("[F20260921tst9][health][Chore] 标题行");
    expect(multiCommit?.filesChanged).toEqual([]);
  });
});
