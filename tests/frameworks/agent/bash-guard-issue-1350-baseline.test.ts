/**
 * F2026102759c4 / #1350：历史基线洞的当前行为回归锁。
 *
 * 本文件不是修复前失败用例：以下文档可证形态在 main@7f575a81 修前探针
 * 已全部 BLOCK。B4/B5 原始脚本未找回，测试只覆盖 F20261008h304 明确记载
 * 的形态；反引号探针显式标为同族补充，不冒充原脚本。
 */
import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";

const ROOT = "/repo";
const WT = `${ROOT}/.otter/worktrees/allowed`;

function guard(command: string): string | null {
  return checkBashCommandSafety(command, 42877, undefined, {
    projectRoot: ROOT,
    sessionCwd: ROOT,
  });
}

function verdict(command: string) {
  return evaluateWriteVerdict(command, ROOT, ROOT);
}

describe("#1350 历史基线洞：当前契约回归锁（非修复前后对照）", () => {
  it("B2：cd 主仓 && git stash push → positive BLOCK", () => {
    const command = `cd ${ROOT} && git stash push`;
    expect(guard(command)).toContain("写命令落点解析到主仓");
    expect(verdict(command)).toMatchObject({
      verdict: "BLOCK",
      mode: "positive",
      mainHits: [{ path: ROOT, via: "git", segmentIndex: 1 }],
    });
  });

  it.each([
    ["writeFileSync", "require('fs').writeFileSync('b5-target.txt','x')"],
    ["writeFile", "require('fs').writeFile('b5-target.txt','x',()=>{})"],
  ])("B5：cd 主仓 && node -e %s → 主仓相对写落点 BLOCK", (_method, payload) => {
    const command = `cd ${ROOT} && node -e "${payload}"`;
    expect(guard(command)).toContain("/repo/b5-target.txt");
    expect(verdict(command)).toMatchObject({
      verdict: "BLOCK",
      mode: "positive",
      mainHits: [{ path: "/repo/b5-target.txt", via: "cmd-arg", segmentIndex: 1 }],
    });
  });

  it("B4 文档形态：裸 heredoc 的 $(rm -f 主仓路径) → fail-closed BLOCK", () => {
    const command = `cat > /tmp/b4-output.txt <<EOF\n$(rm -f ${ROOT}/b4-target.txt)\nEOF`;
    expect(guard(command)).toContain("写落点求值不出，fail-closed");
    // 只锁当前契约，不把 fail-closed 伪装成已定位主仓写 target 的 positive 证明。
    expect(verdict(command)).toEqual({
      verdict: "BLOCK",
      mode: "fail-closed",
      reason: "script-path-dynamic",
    });
  });

  it("B4 同族补充（非原脚本）：裸 heredoc 的反引号 rm 展开 → fail-closed BLOCK", () => {
    const command = `cat > /tmp/b4-output.txt <<EOF\n\`rm -f ${ROOT}/b4-target.txt\`\nEOF`;
    expect(guard(command)).toContain("写落点求值不出，fail-closed");
    expect(verdict(command)).toEqual({
      verdict: "BLOCK",
      mode: "fail-closed",
      reason: "script-path-dynamic",
    });
  });

  it("负向保留：合法 worktree 内 git stash push → ALLOW", () => {
    expect(guard(`cd ${WT} && git stash push`)).toBeNull();
    expect(verdict(`cd ${WT} && git stash push`)).toMatchObject({
      verdict: "ALLOW",
      mode: "positive",
    });
  });

  it("负向保留：合法 worktree 内 node 相对路径写 → ALLOW", () => {
    const command = `cd ${WT} && node -e "require('fs').writeFileSync('allowed.txt','x')"`;
    expect(guard(command)).toBeNull();
    expect(verdict(command)).toMatchObject({ verdict: "ALLOW", mode: "positive" });
  });

  it("负向保留：主仓 git stash list / status 只读 → ALLOW", () => {
    const command = `cd ${ROOT} && git stash list && git status --short`;
    expect(guard(command)).toBeNull();
    expect(verdict(command)).toMatchObject({ verdict: "ALLOW", mode: "positive" });
  });

  it("负向保留：quoted heredoc 中 git/node/rm 写字样只是纯数据 → ALLOW", () => {
    const command = `cat > /tmp/notes.txt <<'EOF'\ngit stash push\nnode -e "require('fs').writeFileSync('x','y')"\nrm -f ${ROOT}/notes.txt\nEOF`;
    expect(guard(command)).toBeNull();
    expect(verdict(command)).toMatchObject({ verdict: "ALLOW", mode: "positive" });
  });

  it("负向保留：主仓仿名 sibling 不因路径前缀误判 → ALLOW", () => {
    const command = `cd /repo-sibling && git stash push`;
    expect(guard(command)).toBeNull();
    expect(verdict(command)).toMatchObject({ verdict: "ALLOW", mode: "positive" });
  });
});
