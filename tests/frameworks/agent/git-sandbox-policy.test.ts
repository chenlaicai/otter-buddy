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
 *
 * A3 注：在 otter-buddy 沙箱内跑本文件需 `--pool=threads`——默认 forks 池
 * worker teardown 会向子进程发信号，deny-signal 沙箱下 kill EPERM 导致超时。
 * CI（无沙箱）默认 forks 池正常，无需此参数。
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

    it.each([
      `git -C /Users/orca/ai/others/colink/.otter/worktrees/shared-recall-reedit commit -m feat`,
      `cd /Users/orca/ai/others/colink/.otter/worktrees/shared-recall-reedit && git commit -m feat`,
    ])("#1682 外部仓已登记隔离 worktree commit 获最小授权", command => {
      const externalRoot = "/Users/orca/ai/others/colink";
      const externalWt = `${externalRoot}/.otter/worktrees/shared-recall-reedit`;
      const g = evaluateGitExecution(command, "/tmp", {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
        resolveExternalWorktree: () => ({ repoRoot: externalRoot, worktreeRoot: externalWt, worktreeName: "shared-recall-reedit" }),
      });
      expect(g).toMatchObject({ kind: "commit", repoRoot: externalRoot, worktreeName: "shared-recall-reedit" });
      expect(grantToProfileRules(g!)).toContain(`(allow file-write* (regex #"^${externalRoot}/\\.git/objects(/|$)"))`);
      expect(grantToProfileRules(g!).some(rule => rule.includes(`${REPO}/.git`))).toBe(false);
    });

    it("外部主目录或注册表不能确认的隔离 worktree 不授权", () => {
      const externalRoot = "/Users/orca/ai/others/colink";
      for (const target of [externalRoot, `${externalRoot}/.otter/worktrees/shared-recall-reedit`]) {
        expect(evaluateGitExecution(`git -C ${target} commit -m feat`, "/tmp", {
          repoRoot: REPO,
          linkedWorktrees: LINKED,
          resolveExternalWorktree: () => null,
        })).toBeNull();
      }
    });

    it.each(["git fetch origin", "git push origin HEAD:feature", "git worktree prune", "git branch -d scratch"])("外部管理写 %s 不授权", command => {
      const externalRoot = "/Users/orca/ai/others/colink";
      const externalWt = `${externalRoot}/.otter/worktrees/shared-recall-reedit`;
      expect(evaluateGitExecution(command, externalWt, {
        repoRoot: REPO, linkedWorktrees: LINKED,
        resolveExternalWorktree: () => ({ repoRoot: externalRoot, worktreeRoot: externalWt, worktreeName: "shared-recall-reedit" }),
      })).toBeNull();
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

    it("git worktree add 只授权受控 worktree 根的直接子目录", () => {
      const target = `${REPO}/.otter/worktrees/new-wt`;
      const g = evaluateGitExecution(`git worktree add -B feat "${target}" HEAD`, REPO, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("worktree-add");
      expect(g!.domains).toEqual(["worktrees-parent", "objects", "refs-heads", "packed-refs-lock", "logs-refs", "config-lock"]);
      expect(g!.worktreeTarget).toBe(target);
    });

    it.each([
      `git worktree add /tmp/escape HEAD`,
      `git worktree add ${REPO}/src-evil HEAD`,
      `git worktree add ${REPO}/.otter/worktrees/a/b HEAD`,
      `git worktree add --lock ${REPO}/.otter/worktrees/new-wt HEAD`,
    ])("未受控/未支持的 worktree add %s 不授权", command => {
      expect(evaluateGitExecution(command, REPO, { repoRoot: REPO, linkedWorktrees: LINKED })).toBeNull();
    });

    it("branch -d 不附带对象或 worktree gitdir 写域", () => {
      const g = evaluateGitExecution("git branch -d scratch", WT, { repoRoot: REPO, linkedWorktrees: LINKED });
      expect(g!.domains).toEqual(["refs-heads", "logs-refs", "packed-refs-lock"]);
    });

    it("git worktree remove → 仅授权受控 worktree 目标", () => {
      const g = evaluateGitExecution(`git worktree remove ${REPO}/.otter/worktrees/wt2`, REPO, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("worktree-remove");
    });
  });

  describe("worktree 参数解析（2026-10-28 修复回归）", () => {
    it("worktree remove 相对目标按 -C 目录解析（2026-10-28 生产回归）", () => {
      const g = evaluateGitExecution(`git -C ${REPO} worktree remove .otter/worktrees/wt2`, "/tmp", {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toMatchObject({ kind: "worktree-remove", worktreeTarget: `${REPO}/.otter/worktrees/wt2` });
    });

    it.each([
      `git worktree remove ${REPO}/.otter/worktrees/wt2 --force`,
      `git worktree remove --force ${REPO}/.otter/worktrees/wt2`,
      `git worktree remove -f ${REPO}/.otter/worktrees/wt2`,
    ])("worktree remove 旗标任意位置 %s → 授权", command => {
      const g = evaluateGitExecution(command, REPO, { repoRoot: REPO, linkedWorktrees: LINKED });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("worktree-remove");
    });

    it.each([
      `git worktree remove ${REPO}/.otter/worktrees/wt2 --lock`,
      `git worktree remove ${REPO}/.otter/worktrees/wt2 ${REPO}/.otter/worktrees/wt3`,
    ])("worktree remove 未知旗标/多目标 %s 不授权", command => {
      expect(evaluateGitExecution(command, REPO, { repoRoot: REPO, linkedWorktrees: LINKED })).toBeNull();
    });

    it.each([
      `git worktree add ${REPO}/.otter/worktrees/new-wt -b feat HEAD`,
      `git worktree add ${REPO}/.otter/worktrees/new-wt --detach HEAD`,
    ])("worktree add 旗标混排（目标后）%s → 授权", command => {
      const g = evaluateGitExecution(command, REPO, { repoRoot: REPO, linkedWorktrees: LINKED });
      expect(g).not.toBeNull();
      expect(g!.kind).toBe("worktree-add");
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

    it("S1：worktree 名含反引号 → 不授权（白名单拒绝）", () => {
      const g = evaluateGitExecution("git worktree add .otter/worktrees/x`id`", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });

    it("S1：worktree 名含 $() → 不授权", () => {
      const g = evaluateGitExecution("git worktree add .otter/worktrees/x$(id)", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });

    it("A1：worktree 名含双引号 → 不授权", () => {
      const g = evaluateGitExecution('git worktree add .otter/worktrees/x"y', WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });

    it("S1：worktree 名含空格 → 不授权（白名单拒绝）", () => {
      const g = evaluateGitExecution("git worktree add .otter/worktrees/my dir", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      });
      expect(g).toBeNull();
    });
  });
});

describe("git-execution-policy profile 规则与指纹", () => {
  describe("profile 规则生成", () => {
    it("worktree commit 授权生成窄路径规则（regex 形态，压过 .git deny 的删除面）", () => {
      const g = evaluateGitExecution("git commit -m test", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      })!;
      const rules = grantToProfileRules(g);
      expect(rules).toContain(`(allow file-write* (regex #"^${REPO}/\\.git/worktrees/${WT_NAME}(/|$)"))`);
      expect(rules).toContain(`(allow file-write* (regex #"^${REPO}/\\.git/objects(/|$)"))`);
      expect(rules).toContain(`(allow file-write* (regex #"^${REPO}/\\.git/refs/heads(/|$)"))`);
      // 不应包含整树 .git allow
      expect(rules.some((r) => r.includes(`"${REPO}/.git"`))).toBe(false);
    });

    it("worktree remove 授权含 .git 指针 regex 规则（unlink 面修复）", () => {
      const g = evaluateGitExecution(`git worktree remove ${REPO}/.otter/worktrees/wt2`, REPO, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      })!;
      const rules = grantToProfileRules(g);
      expect(rules.some(r => r.includes(`(allow file-write* (regex #"^${REPO}/\\.otter/worktrees/wt2/\\.git$"))`))).toBe(true);
    });

    it("fetch 授权包含 worktree-gitdir（FETCH_HEAD 在 worktree 内）", () => {
      const g = evaluateGitExecution("git fetch origin", WT, {
        repoRoot: REPO,
        linkedWorktrees: LINKED,
      })!;
      const rules = grantToProfileRules(g);
      expect(rules).toContain(`(allow file-write* (regex #"^${REPO}/\\.git/worktrees/${WT_NAME}(/|$)"))`);
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
