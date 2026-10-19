/**
 * S1 回归锁（delta2 复核 2026-10-16，检视獭-guard）：cd 形态落点判定。
 *
 * S1 病灶：checkMainCheckoutWrite 里 cd 豁免门（modelCdExemption→cdExemptionWithVeto）
 * 排在 evaluateWriteVerdict 之前先行 return，`cd X && <写主仓>` 整条放行（绕过面 trivial）。
 * 本组锁住修复契约（两种修法方向均须满足——形态判不得覆盖落点判）：
 *   ① cd 落主仓写 → BLOCK（S1 四形态）
 *   ② cd 落 worktree 写 / worktree 内 git commit → ALLOW（#1170 保持，防修过正）
 *   ③ cd + shell heredoc 内重定向写主仓 → BLOCK（S1 同族，veto 不覆盖 shell 体的漏拦面）
 *   ④ cd + python heredoc 纯读绝对路径探查 → ALLOW（#1240 只读放行面，防可用性过杀）
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const mainPid = 42877;
const projectRoot = "/repo";
const WT = "/repo/.otter/worktrees/feat-x";
const guard = (cmd: string, sessionCwd = projectRoot) =>
  checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });

describe("S1：cd 豁免门不得覆盖求值器（delta2 复核回归锁）", () => {
  it("cd /repo && touch f（cwd=主仓根）→ BLOCK", () => {
    expect(guard("cd /repo && touch f")).not.toBeNull();
  });
  it("cd /repo && echo x > foo → BLOCK", () => {
    expect(guard("cd /repo && echo x > foo")).not.toBeNull();
  });
  it("cd WT && echo x > /repo/foo → BLOCK（绝对路径写主仓）", () => {
    expect(guard(`cd ${WT} && echo x > /repo/foo`)).not.toBeNull();
  });
  it("cd WT && touch /repo/f → BLOCK（绝对路径写主仓）", () => {
    expect(guard(`cd ${WT} && touch /repo/f`)).not.toBeNull();
  });
  it("cd WT && git commit → ALLOW（#1170 保持：worktree 内提交放行）", () => {
    expect(guard(`cd ${WT} && git commit -m x`)).toBeNull();
  });
  it("cd WT && touch f → ALLOW（worktree 内写放行）", () => {
    expect(guard(`cd ${WT} && touch f`)).toBeNull();
  });
  it("cd /tmp && bash <<EOF 内重定向写主仓 → BLOCK（shell heredoc 同族漏拦面）", () => {
    expect(guard("cd /tmp && bash <<EOF\necho y > /repo/foo\nEOF")).not.toBeNull();
  });
  it("cd /tmp && python heredoc 纯读主仓绝对路径 → ALLOW（#1240 只读探查正道）", () => {
    expect(guard("cd /tmp && python3 - <<'PY'\nprint(open('/repo/src/x.py').read())\nPY")).toBeNull();
  });
  // ── B7 定点修回归锁（Case-2 条件解禁 ②，2026-10-19）──
  it("B7：W=/repo; cd $W/.otter/worktrees/x && git add/commit → ALLOW（evalCdTarget var+字面后缀拼接）", () => {
    expect(guard("W=/repo; cd $W/.otter/worktrees/x && git add -A && git commit -F /tmp/xx")).toBeNull();
  });
  it("c-po 负门保持：W=/repo; cd $W/../x && touch f → 拦（后缀含 .. 仍 fail-closed，#1381 不动）", () => {
    expect(guard("W=/repo; cd $W/../x && touch f")).not.toBeNull();
  });
});
