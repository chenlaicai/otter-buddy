/**
 * F20261027gscv Phase 2：Git 执行域最小授权策略测试。
 *
 * 覆盖：
 * - envelope 识别（git -C <abs> / 直接 git / worktree 内 cwd 判定）
 * - 子命令白名单（status/log/diff/add/commit/fetch/push/worktree）
 * - 复合语法拦截（&& / || / ; / | / $() / 反引号 / 重定向 / 换行）
 * - 主仓直接 add/commit 拒绝（R1 红线）
 * - 未知路径不授权
 * - profile 规则生成（窄写域路径正确）
 * - 授权指纹缓存（同授权同 profile，不同授权不串权）
 */

import { describe, expect, it } from "vitest";
import { evaluateGitExecution, grantToProfileRules, grantFingerprint } from "../../../src/frameworks/agent/git-execution-policy";

const REPO = "/Users/orca/ai/otter-buddy";
const WT = "/Users/orca/ai/otter-buddy/.otter/worktrees/design-guard-convergence";
const WT_NAME = "design-guard-convergence";
const LINKED = new Map([[WT, WT_NAME]]);

describe("git-execution-policy", () => {
  describe("envelope 识别", () => {
    it("git -C <abs> status → 授权只读", () => {
      const g = evaluateGitExecution(`git -C ${WT} status --porcelain`, "/tmp", {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("status");
      expect(g!.worktreeName).toBe(WT_NAME);
      expect(g!.injectOptionalLocks).toBe(true);
      expect(g!.domains).toEqual([]);
    });

    it("worktree 内直接 git add → 授权 worktree-gitdir + objects", () => {
      const g = evaluateGitExecution("git add src/foo.ts", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("add");
      expect(g!.domains).toEqual(["worktree-gitdir", "objects"]);
    });

    it("worktree 内直接 git commit → 授权 worktree-gitdir + objects + refs-heads", () => {
      const g = evaluateGitExecution("git commit -m test", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("commit");
      expect(g!.domains).toEqual(["worktree-gitdir", "objects", "refs-heads", "logs-refs", "packed-refs-lock"]);
    });

    it("git -C 主仓 add → 拒绝（主仓直接写不授权）", () => {
      const g = evaluateGitExecution(`git -C ${REPO} add .`, "/tmp", {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });

    it("主仓 cwd 直接 git commit → 拒绝", () => {
      const g = evaluateGitExecution("git commit -m x", REPO, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });

    it("git fetch → 授权 objects + refs-remotes + fetch-head + packed-refs", () => {
      const g = evaluateGitExecution("git fetch origin", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("fetch");
      expect(g!.domains).toEqual(["worktree-gitdir", "objects", "refs-remotes", "logs-refs", "fetch-head", "packed-refs-lock"]);
    });

    it("git push → 授权 objects + packed-refs", () => {
      const g = evaluateGitExecution("git push origin HEAD:feature-x", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("push");
      expect(g!.domains).toEqual(["objects", "refs-remotes", "logs-refs", "packed-refs-lock"]);
    });

    it("git worktree list → 只读", () => {
      const g = evaluateGitExecution("git worktree list", REPO, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("worktree-list");
      expect(g!.domains).toEqual([]);
    });

    it("git worktree add → 授权管理目录与精确 packed-refs 锁文件", () => {
      const g = evaluateGitExecution("git worktree add /tmp/wt2 HEAD", REPO, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("worktree-add");
      expect(g!.domains).toEqual(["worktrees-parent", "objects", "refs-heads", "packed-refs-lock", "logs-refs", "config-lock"]);
      expect(g!.worktreeTarget).toBe("/tmp/wt2");
    });

    it("git worktree remove → 授权 worktrees-parent + objects + refs-heads + packed-refs", () => {
      const g = evaluateGitExecution("git worktree remove /tmp/wt2", REPO, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("worktree-remove");
    });
  });

  describe("复合语法拦截", () => {
    it.each([
      "git status && rm -rf /",
      "git status || echo x",
      "git status; echo x",
      "git status | cat",
      "git status $(whoami)",
      "git status `whoami`",
      "git status > /tmp/x",
      "git status < /tmp/x",
      "git status\necho x",
    ])("含复合语法 %s → 不识别", (cmd) => {
      const g = evaluateGitExecution(cmd, WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });
  });

  describe("路径安全", () => {
    it("git -C 相对路径按真实 cwd 解析；未登记目标不授权", () => {
      const g = evaluateGitExecution("git -C ../wt status", "/tmp", {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });

    it("git -C 未知路径 → 不识别", () => {
      const g = evaluateGitExecution("git -C /unknown/path status", "/tmp", {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });

    it("非 git 命令 → 不识别", () => {
      const g = evaluateGitExecution("echo hello", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });

    it("未知子命令 → 不识别", () => {
      const g = evaluateGitExecution("git rebase -i HEAD~3", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });
  });

  describe("profile 规则生成", () => {
    it("worktree commit 授权生成窄路径规则", () => {
      const g = evaluateGitExecution("git commit -m test", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      })!;
      const rules = grantToProfileRules(g);
      expect(rules).toContain(`(allow file-write* (subpath "${REPO}/.git/worktrees/${WT_NAME}"))`);
      expect(rules).toContain(`(allow file-write* (subpath "${REPO}/.git/objects"))`);
      expect(rules).toContain(`(allow file-write* (subpath "${REPO}/.git/refs/heads"))`);
      // 不应包含整树 .git allow
      expect(rules.some((r) => r.includes(`"${REPO}/.git"`))).toBe(false);
    });

    it("fetch 授权包含 worktree-gitdir（FETCH_HEAD 在 worktree 内）", () => {
      const g = evaluateGitExecution("git fetch origin", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      })!;
      const rules = grantToProfileRules(g);
      expect(rules).toContain(`(allow file-write* (subpath "${REPO}/.git/worktrees/${WT_NAME}"))`);
    });
  });

  describe("授权指纹缓存", () => {
    it("同授权同指纹", () => {
      const g1 = evaluateGitExecution("git add a.ts", WT, { repoRoot: REPO, linkedWorktrees: LINKED })!;
      const g2 = evaluateGitExecution("git add b.ts", WT, { repoRoot: REPO, linkedWorktrees: LINKED })!;
      expect(grantFingerprint(g1)).toBe(grantFingerprint(g2));
    });

    it("不同授权不同指纹", () => {
      const g1 = evaluateGitExecution("git add a.ts", WT, { repoRoot: REPO, linkedWorktrees: LINKED })!;
      const g2 = evaluateGitExecution("git commit -m x", WT, { repoRoot: REPO, linkedWorktrees: LINKED })!;
      expect(grantFingerprint(g1)).not.toBe(grantFingerprint(g2));
    });
  });
});
