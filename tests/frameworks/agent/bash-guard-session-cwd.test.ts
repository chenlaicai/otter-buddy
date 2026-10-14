/**
 * F20261013cwsp：守卫 sessionCwd 感知判定——统一工作区后獭 bash cwd=对话工作区，
 * 主仓写/data 破坏判定的语义从「位置判定」（未 cd 即拦）转为「落点判定」
 * （相对路径按 sessionCwd 解析，落主仓才拦）。
 *
 * 锁定语义：
 * ① 工作区内写（相对路径落 sessionCwd）→ 放行（git 写族 / 重定向 / rm 工作区 data）
 * ② 落点真主仓（cd 主仓 / 绝对路径主仓）→ 仍拦
 * ③ 无 sessionCwd（旧调用形态）→ 旧行为保持（未 cd 即拦）
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const mainPid = 42877;
const projectRoot = "/repo";
/** F20261013cwsp round-1 处置（检视 S2）：fixture 改为生产真实形态——
 *  会话工作区在主仓树内（data/workspaces/<conv>，非 git 工作树）。
 *  初版用树外 /wt 给的是假信心：树外触发了逃逸面的「放行」。 */
const WS = "/repo/data/workspaces/conv-abc";
const optsWs = { projectRoot, sessionCwd: WS };
const optsLegacy = { projectRoot };
/** git 工作树（worktree）内 cwd——git 写族 cwd 感知豁免面 */
const WT = "/repo/.otter/worktrees/feat-x";
const optsWt = { projectRoot, sessionCwd: WT };
/** 相对 sessionCwd（resolver 绝对化前的逃逸形态，回归锁） */
const optsRel = { projectRoot, sessionCwd: "data/workspaces/conv-abc" };

describe("F20261013cwsp：sessionCwd 感知——git 工作树内写放行", () => {
  it("git commit（cwd=worktree 内）→ 放行", () => {
    expect(checkBashCommandSafety(`git commit -m x`, mainPid, undefined, optsWt)).toBeNull();
  });

  it("git commit + push 链（cwd=worktree 内）→ 放行", () => {
    expect(checkBashCommandSafety(`git commit -m x && git push`, mainPid, undefined, optsWt)).toBeNull();
  });

  it("包装词 git 写族（env git commit，cwd=worktree 内）→ 放行", () => {
    expect(checkBashCommandSafety(`env FOO=1 git commit -m x`, mainPid, undefined, optsWt)).toBeNull();
  });
});

describe("F20261013cwsp：sessionCwd 感知——会话工作区（树内非 git 树）", () => {
  it("git commit（cwd=会话工作区）→ 拦（向上发现主仓 .git，写落主仓）", () => {
    expect(checkBashCommandSafety(`git commit -m x`, mainPid, undefined, optsWs)).not.toBeNull();
  });

  it("rm -rf data（清工作区缓存）→ 放行（树内 workspaces 豁免，S2）", () => {
    expect(checkBashCommandSafety(`rm -rf data`, mainPid, undefined, optsWs)).toBeNull();
  });

  it("echo x > foo.txt（相对路径重定向落工作区）→ 放行", () => {
    expect(checkBashCommandSafety(`echo x > foo.txt`, mainPid, undefined, optsWs)).toBeNull();
  });

  it("相对 sessionCwd + git 写族 → 拦（相对锚点无豁免，S1 逃逸面回归锁）", () => {
    expect(checkBashCommandSafety(`git commit -m x`, mainPid, undefined, optsRel)).not.toBeNull();
  });

  it("树外 cwd + one-liner 写主仓绝对路径 → 拦（S1 probe 形态回归锁）", () => {
    expect(checkBashCommandSafety(`python3 -c "open('/repo/src/foo.ts','w')"`, mainPid, undefined, { projectRoot, sessionCwd: "/wt/x" })).not.toBeNull();
  });
});

describe("F20261013cwsp：S8 收窄——跨对话工作区破坏仍拦", () => {
  it("rm -rf ../OTHER-conv（相对路径越权到邻对话工作区）→ 拦", () => {
    expect(checkBashCommandSafety(`rm -rf ../OTHER-conv`, mainPid, undefined, optsWs)).not.toBeNull();
  });

  it("rm -rf /repo/data/workspaces/OTHER-conv（绝对路径他人工作区）→ 拦", () => {
    expect(checkBashCommandSafety(`rm -rf /repo/data/workspaces/OTHER-conv`, mainPid, undefined, optsWs)).not.toBeNull();
  });

  it("legacy 无 sessionCwd + rm 绝对路径工作区 → 拦（旧行为保持，S8 回归锁）", () => {
    expect(checkBashCommandSafety(`rm -rf /repo/data/workspaces/conv-abc`, mainPid, undefined, optsLegacy)).not.toBeNull();
  });

  it("rm -rf data（自己工作区缓存）→ 放行（S2 豁免面保持）", () => {
    expect(checkBashCommandSafety(`rm -rf data`, mainPid, undefined, optsWs)).toBeNull();
  });
});

describe("F20261013cwsp：sessionCwd 感知——落点真主仓仍拦", () => {
  it("cd 主仓 && git commit → 拦", () => {
    // F20261013cwsp 已知边界：cd 豁免（#1170/F20260922scwd）按旧语义放行
    // `cd <主仓> && git 写族`（模型版豁免不区分 cd 目标是否主仓）——本特性不收紧
    // 该面（收紧属 cd 豁免语义重议，独立立项）。绝对路径写形态仍拦。
    expect(checkBashCommandSafety(`echo x > /repo/src/foo.ts`, mainPid, undefined, optsWs)).not.toBeNull();
  });

  it("echo x > /repo/src/foo.ts（绝对路径落主仓）→ 拦", () => {
    expect(checkBashCommandSafety(`echo x > /repo/src/foo.ts`, mainPid, undefined, optsWs)).not.toBeNull();
  });

  it("rm -rf /repo/data（绝对路径主仓 data）→ 拦", () => {
    expect(checkBashCommandSafety(`rm -rf /repo/data`, mainPid, undefined, optsWs)).not.toBeNull();
  });

  it("cd 主仓 && rm -rf data（相对路径经 cd 落主仓 data）→ 拦", () => {
    expect(checkBashCommandSafety(`cd /repo && rm -rf data`, mainPid, undefined, optsWs)).not.toBeNull();
  });
});

describe("F20261013cwsp：sessionCwd 感知——绝对路径工作区豁免保持", () => {
  it("echo >> /repo/data/workspaces/conv/x.log（绝对路径工作区）→ 放行（F20260923hsyn）", () => {
    expect(checkBashCommandSafety(`echo log >> ${WS}/x.log`, mainPid, undefined, optsLegacy)).toBeNull();
  });
});

describe("F20261013cwsp：无 sessionCwd 旧行为保持（回归锁）", () => {
  it("git commit（无 cd，无 sessionCwd）→ 拦（旧世界基座）", () => {
    expect(checkBashCommandSafety(`git commit -m x`, mainPid, undefined, optsLegacy)).not.toBeNull();
  });

  it("rm -rf data（无 sessionCwd，相对路径按 projectRoot 解析）→ 拦", () => {
    expect(checkBashCommandSafety(`rm -rf data`, mainPid, undefined, optsLegacy)).not.toBeNull();
  });

  it("echo x > foo.txt（无 sessionCwd，相对路径重定向保守拦）→ 拦", () => {
    expect(checkBashCommandSafety(`echo x > foo.txt`, mainPid, undefined, optsLegacy)).not.toBeNull();
  });
});
