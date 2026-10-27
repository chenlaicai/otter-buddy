import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

/**
 * F20261027bgkw 历史词面回归在 F20261027gscv 的迁移：
 * sg=true 的嵌套 Git 壳不再由 SUBSHELL_GIT_WRITE_GATE 逐字符判定，真实
 * `.git` 写入由 git-sandbox-integration.test.ts 的默认 deny 证明；
 * sg=false 保留有限 Best Effort 词面，不借物理能力宣称同等安全。
 */
const MAIN = "/Users/orca/ai/otter-buddy";
const WT = "/Users/orca/ai/otter-buddy/.otter/worktrees/design-guard-convergence";
const PID = 42877;
const SESS = "/Users/orca/ai/otter-buddy/data/workspaces/probe-session";
const go = (cmd: string, sg = true, cwd = SESS) =>
  checkBashCommandSafety(cmd, PID, undefined, { projectRoot: MAIN, sessionCwd: cwd, sandboxGuarded: sg });

describe("F20261027gscv：嵌套 Git 职责迁移", () => {
  it("sg=true 不再用壳内写动词误拦合法 worktree 嵌套文本", () => {
    expect(go(`echo "\`cd ${WT} && git commit -m x\`"`)).toBeNull();
    expect(go(`echo "\`cd ${MAIN} && git commit -m x\`"`)).toBeNull();
    expect(go('echo "$(touch /tmp/x)"')).toBeNull();
  });

  it("sg=false 仍保留反引号与 $() 嵌套 Git 写词面", () => {
    expect(go(`echo "\`cd ${MAIN} && git commit -m x\`"`, false)).not.toBeNull();
    expect(go(`echo "$(cd ${MAIN} && git commit -m x)"`, false)).not.toBeNull();
  });

  it("sg=true 的生产 cwd=工作区形态：cd worktree && git add/commit 正道放行", () => {
    expect(go(`cd ${WT} && git add -A`)).toBeNull();
    expect(go(`cd ${WT} && git commit -m x`)).toBeNull();
    expect(go(`cd ${MAIN} && git commit -m x`)).not.toBeNull();
  });

  it("sg=true 的 push 按 refspec 目标判定，不按分支名包含 main 误拦", () => {
    expect(go(`git -C ${WT} push origin HEAD:refs/heads/main`)).not.toBeNull();
    expect(go(`git -C ${WT} push origin feature/main-fix`)).toBeNull();
    expect(go(`cd ${WT} && git push origin HEAD:refs/heads/develop`)).not.toBeNull();
  });

  it("sg=true 的纯数据/未闭合反引号不误伤", () => {
    expect(go('echo "`date`"')).toBeNull();
    expect(go('echo "`unclosed')).toBeNull();
    expect(go("echo 'git commit -m x'")).toBeNull();
  });
});
