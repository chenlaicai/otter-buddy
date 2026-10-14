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
/** 工作区在主仓树外——cwd 感知放行面（生产会话工作区形态） */
const WS = "/wt/workspace-abc";
const optsWs = { projectRoot, sessionCwd: WS };
const optsLegacy = { projectRoot };

describe("F20261013cwsp：sessionCwd 感知——工作区内写放行", () => {
  it("git commit（无 cd，cwd=工作区）→ 放行", () => {
    expect(checkBashCommandSafety(`git commit -m x`, mainPid, undefined, optsWs)).toBeNull();
  });

  it("git commit + push 链（cwd=工作区）→ 放行", () => {
    expect(checkBashCommandSafety(`git commit -m x && git push`, mainPid, undefined, optsWs)).toBeNull();
  });

  it("echo x > foo.txt（相对路径重定向落工作区）→ 放行", () => {
    expect(checkBashCommandSafety(`echo x > foo.txt`, mainPid, undefined, optsWs)).toBeNull();
  });

  it("rm -rf data（清工作区缓存，非主仓 data）→ 放行", () => {
    expect(checkBashCommandSafety(`rm -rf data`, mainPid, undefined, optsWs)).toBeNull();
  });

  it("包装词 git 写族（env git commit，cwd=工作区）→ 放行", () => {
    expect(checkBashCommandSafety(`env FOO=1 git commit -m x`, mainPid, undefined, optsWs)).toBeNull();
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
