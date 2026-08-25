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
});
