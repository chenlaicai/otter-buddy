/**
 * F20261016syml（M-ed285d7c）：symlink 逃逸链 realpath 归一化——ln -s 主仓→worktrees 区 +
 * git -C symlink 写族两步全放（与 cwd 形态共享既有边界，#1515 delta 建议 2 立档）。
 * 判定基元（wv pathWithinMain / prod isInsideMainCheckout / classifyDestructiveTarget /
 * git -C 落点累积）路径解析经 symlink 穿透归一：字符串形态「在 worktrees 区」但真实落点
 * 「主仓内容树」的两步链收口。放行侧（链清理/反向链/基线形态）与拦截侧都钉死。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";
import { pathWithinMain } from "@frameworks/agent/write-target-evaluator";

// 真实 fs 拓扑（symlink 判定必须触盘）：<root> 主仓、<root>/src 内容树、
// <root>/.otter/worktrees/wt 工作树、wt/link -> root/src（植入的逃逸链）、
// root/tolink -> worktrees/wt（反向链：写落 worktree 应放行）。
const root = fs.mkdtempSync(path.join(os.tmpdir(), "symreal-"));
const srcDir = path.join(root, "src");
const wtDir = path.join(root, ".otter", "worktrees", "wt");
const link = path.join(wtDir, "link"); // -> root/src
const revLink = path.join(root, "tolink"); // -> worktrees/wt
const sessionCwd = path.join(root, "data", "workspaces", "conv-1");

beforeAll(() => {
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });
  fs.mkdirSync(sessionCwd, { recursive: true });
  fs.mkdirSync(path.join(srcDir, "sub"), { recursive: true });
  fs.symlinkSync(srcDir, link);
  fs.symlinkSync(wtDir, revLink);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const prod = (cmd: string) => checkBashCommandSafety(cmd, 42877, undefined, { projectRoot: root, sessionCwd });
const wv = (cmd: string) => evaluateWriteVerdict(cmd, root, sessionCwd);

describe("F20261016syml symlink 逃逸链收口（拦截侧：穿透写/删必须双链同判）", () => {
  it("git -C 逃逸链：git -C <symlink> 写族落点穿透明判主仓（两步链 step2）", () => {
    expect(prod(`git -C ${link} commit --author="守卫修复獭 <otter-buddy>" -m a`)).toBeTruthy();
    expect(wv(`git -C ${link} commit --author="守卫修复獭 <otter-buddy>" -m a`).verdict).toBe("BLOCK");
  });

  it("cd 逃逸链：cd <symlink> && git commit 形态同拦（与 -C 形态共享边界）", () => {
    expect(prod(`cd ${link} && git commit --author="守卫修复獭 <otter-buddy>" -m a`)).toBeTruthy();
  });

  it("写穿透明拦：echo > <symlink>/新文件（字符串在 worktrees 区、真实落点主仓内容树）", () => {
    expect(prod(`echo x > ${link}/newfile.md`)).toBeTruthy();
  });

  it("删穿透明拦：rm <symlink>/子路径 与 glob 穿透（rm -rf link/* 删进主仓）", () => {
    expect(prod(`rm -rf ${link}/sub`)).toBeTruthy();
    expect(prod(`rm -rf ${link}/*`)).toBeTruthy();
    expect(wv(`rm -rf ${link}/sub`).verdict).toBe("BLOCK");
  });

  it("多级 cd 撒谎链同拦：cd <wt> && cd <link> && git commit（首 cd 早返盲区预扫收口）", () => {
    expect(prod(`cd ${wtDir} && cd ${link} && git commit --author="守卫修复獭 <otter-buddy>" -m a`)).toBeTruthy();
  });
});

describe("F20261016syml 放行侧（链清理/反向链/基线形态不误伤）", () => {
  it("链清理放行：rm 植入的 symlink 本体（unlink 语义不穿链）", () => {
    expect(prod(`rm ${link}`)).toBeNull();
  });

  it("基线形态不受影响：worktree 内 -C 写族照常放行", () => {
    expect(prod(`git -C ${wtDir} commit --author="守卫修复獭 <otter-buddy>" -m a`)).toBeNull();
  });

  it("反向链放行：主仓路径 symlink 指向 worktree——写穿链落 worktree 非主仓", () => {
    expect(prod(`echo x > ${revLink}/f.md`)).toBeNull();
  });

  it("区外虚构路径语义不变（identity 归一）：/tmp 写照常放行", () => {
    expect(prod(`rm -rf /tmp/symreal-nonexistent`)).toBeNull();
  });

  it("显式意图边界不动：诚实 cd 主仓内容树 && git commit 照旧放行（:1154 同语义真路径版）", () => {
    expect(prod(`cd ${srcDir} && git commit --author="守卫修复獭 <otter-buddy>" -m a`)).toBeNull();
  });
});

describe("F20261016syml 基元单测：pathWithinMain 穿透归一", () => {
  it("穿链目标判主仓（真目标 root/src 在内容树）", () => {
    expect(pathWithinMain(path.join(link, "x.md"), root)).toBe(true);
    expect(pathWithinMain(link, root)).toBe(true);
  });

  it("基线判定不变：内容树/运行时区/区外", () => {
    expect(pathWithinMain(path.join(srcDir, "x.md"), root)).toBe(true);
    expect(pathWithinMain(path.join(wtDir, "x.md"), root)).toBe(false);
    expect(pathWithinMain("/tmp/x.md", root)).toBe(false);
  });
});
