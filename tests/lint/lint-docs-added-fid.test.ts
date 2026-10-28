import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error 真实现为 .mjs，无类型声明
import { collectAddedDocPaths } from "../../scripts/lint-docs.mjs";
import { validateFeatureFrontmatter } from "../../src/entities/document/frontmatter-validator";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
const doc = (id: string) => `docs/features/2026/10/27/${id}-sample.md`;
const frontmatter = (id: string) => ({
  id, title: "增量门测试", summary: "历史兼容与新增严格校验", change_type: "feature",
  created_in_conversation: "test",
});

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fid-lint-gate-"));
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("remote", "add", "origin", repo);
  execFileSync("mkdir", ["-p", join(repo, "docs/features/2026/10/27")]);
  execFileSync("touch", [join(repo, ".gitkeep")]);
  git("add", ".gitkeep");
  git("commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-b", "feature");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("lint-docs 增量门接线（F20261027fidrx）", () => {
  it("历史 ID 默认 read 可读，新文档 strict 固定 5 字母", () => {
    expect(validateFeatureFrontmatter(frontmatter("F20261027fidr"), doc("F20261027fidr")).errors).toEqual([]);
    expect(validateFeatureFrontmatter(frontmatter("F20261027fidr"), doc("F20261027fidr"), { strictNewId: true }).errors.some(e => e.includes("Invalid feature ID"))).toBe(true);
    expect(validateFeatureFrontmatter(frontmatter("F20261027abcde"), doc("F20261027abcde"), { strictNewId: true }).errors).toEqual([]);
  });

  it("pre-commit 暂存新增被纳入，已提交新增在 CI 同样纳入", () => {
    const rel = doc("F20261027fidr");
    execFileSync("cp", ["/dev/null", join(repo, rel)]);
    git("add", rel);
    expect([...collectAddedDocPaths(repo)]).toContain(rel);
    git("commit", "-m", "new doc");
    expect([...collectAddedDocPaths(repo)]).toContain(rel);
  });
});
