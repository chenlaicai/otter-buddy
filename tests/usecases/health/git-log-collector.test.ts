import { describe, it, expect } from "vitest";
import { collectGitLogWithFiles } from "@usecases/health/git-log-collector";

/** 在本仓库（worktree）上做真实只读采集的冒烟验证 */
describe("collectGitLogWithFiles", () => {
  const repoPath = process.cwd();

  it("采集数与 git rev-list 一致", async () => {
    const commits = await collectGitLogWithFiles(repoPath, { maxCount: 20 });
    expect(commits.length).toBeLessThanOrEqual(20);
    expect(commits.length).toBeGreaterThan(0);
  });

  it("commit 记录结构完整：sha/message/filesChanged", async () => {
    const [first] = await collectGitLogWithFiles(repoPath, { maxCount: 1 });
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.message.length).toBeGreaterThan(0);
    expect(Array.isArray(first.filesChanged)).toBe(true);
  });

  it("recent commit 有文件列表（本次开发本身就在改文件）", async () => {
    const commits = await collectGitLogWithFiles(repoPath, { maxCount: 5 });
    expect(commits[0].filesChanged.length).toBeGreaterThan(0);
  });
});
