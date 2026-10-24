/**
 * F20261024dwtg（M-05415afd + M-dd668952）：dynamic-path 洗白通用门 + git 写面 .git 爬升收口。
 *
 * 单 A（M-05415afd）背景：#1619/#1625 收的是具体族（argv-write-uncovered / tar-unzip-rsync /
 * curl-wget-dd），词面 regex 差集动词（find 在 TARGET_ARG_COMMANDS 不在 WRITE_FACE_WORDS）
 * 落 dynamic-path 仍被能力 4 词面证洗成正面 ALLOW（e2e 探针实证：find "$D" -delete 全链放水）。
 * 修法：dynamic-path 整体入 UNPROVABLE_TEETH——「落点不可静态溯源」与「目标槽不可静态钉」
 * 同属词面证盲区，通用机制根治不再逐族收编。
 *
 * 单 B（M-dd668952）背景：evalGitWrite 落点=cwd，cwd 落运行时区（data/workspaces 等）时
 * 被豁免洗白——但 git 真实语义是向上爬升发现 .git（本仓 data/workspaces 非 git 树，爬升
 * 命中主仓 .git → stash drop/pop/apply/clear 实际写主仓元数据）。修法：git 写族段 base 落
 * 运行时区时 fs 爬升锚定 gitdir（发现 .git 且属主仓 → base 锚 .git 所在树判主仓写）。
 * 边界：worktree cwd 真写 worktree 自身（.git 是文件指回主仓 .git/worktrees/<n>——但写的
 * 是 worktree 专属元数据区，不落主仓内容树/refs，语义=写 worktree，维持豁免）。
 */
import { describe, expect, it } from "vitest";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";

const ROOT = "/repo";
const WT = "/repo/.otter/worktrees/wt";

const verdict = (cmd: string, cwd: string = WT): string => evaluateWriteVerdict(cmd, ROOT, cwd).verdict;
const isBlock = (cmd: string, cwd: string = WT): boolean => verdict(cmd, cwd) === "BLOCK";
const isAllow = (cmd: string, cwd: string = WT): boolean => verdict(cmd, cwd) === "ALLOW";

// ── 单 A：dynamic-path 洗白通用门 ────────────────────────────────────────────

describe("A1 差集动词不再被词面证洗白（find 族红链——修前 e2e ALLOW）", () => {
  it("find \"$D\" -delete → BLOCK fail-closed dynamic-path（原 ALLOW 放水）", () => {
    const v = evaluateWriteVerdict("find \"$D\" -delete", ROOT, WT);
    expect(v).toMatchObject({ verdict: "BLOCK", mode: "fail-closed", reason: "dynamic-path" });
  });
  it("find \"$D\" -type f -delete / -exec rm {} \\; 同判", () => {
    expect(isBlock("find \"$D\" -type f -delete")).toBe(true);
    expect(isBlock("find \"$D\" -exec rm {} \\;")).toBe(true);
  });
  it("载荷通道同收（bash -c 载荷内差集动词动态落点不被 subPayloadWashable 洗白）", () => {
    expect(isBlock("bash -c 'find \"$D\" -delete'")).toBe(true);
    expect(isBlock("sh -c 'find \"$D\" -delete'")).toBe(true);
  });
});

describe("A2 词表内动词动态目标维持 fail-closed（原已 BLOCK——证明修前不靠词面 regex 挡）", () => {
  it("cp/mv/tee/touch/mkdir/rm \"$D\" → BLOCK dynamic-path（回归守恒）", () => {
    for (const cmd of ["cp a.txt \"$D\"", "mv a.txt \"$D\"", "tee \"$D\"", "touch \"$D\"", "mkdir \"$D\"", "rm \"$D\""]) {
      expect(isBlock(cmd)).toBe(true);
    }
  });
  it("echo hi > \"$D\"（重定向目标 var）→ BLOCK dynamic-path", () => {
    expect(isBlock("echo hi > \"$D\"")).toBe(true);
  });
});

describe("A3 静态落点词面证豁免面守恒（不误伤——词面证对 evaluate 成功的命令不参与）", () => {
  it("git push -u origin x（无 -C 全静态远端）→ 维持 ALLOW（corpus 96a21f3c 面）", () => {
    expect(isAllow("git push -u origin x")).toBe(true);
  });
  it("find /repo/data -delete（静态主仓落点）→ BLOCK positive（落点判不放松）", () => {
    const v = evaluateWriteVerdict("find /repo/data -delete", ROOT, WT);
    expect(v).toMatchObject({ verdict: "BLOCK", mode: "positive" });
  });
  it("find \"$D\" -name x（读形态 find 不入账）→ 维持 ALLOW", () => {
    expect(isAllow("find \"$D\" -name x")).toBe(true);
  });
});

// ── 单 B：git 写面 .git 爬升收口（运行时区 cwd 锚定 gitdir）─────────────────
// 纯判定层测试用假想路径 /repo（仓上无 .git）——爬升不可发现时维持原语义（豁免/字面量判），
// 真爬升面（fs 存在）由临时目录构造用例覆盖（describe B2）。

describe("B1 纯判定层：无 .git 可发现时维持原语义（假想 /repo 路径）", () => {
  it("git stash drop @WT cwd → 维持 ALLOW（worktree 正道，真 .git 爬升面在 B2）", () => {
    expect(isAllow("git stash drop", WT)).toBe(true);
  });
});

describe("B2 真爬升面（临时目录构造 repo：ws 落 repo 树内、wt 是真 worktree）", () => {
  it("cwd=repo 内非 git 子目录（workspaces 形态）git stash drop → BLOCK（爬升锚定主仓 .git）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { execSync } = await import("node:child_process");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dwtg-b2-"));
    try {
      const repo = path.join(base, "repo");
      fs.mkdirSync(path.join(repo, "data", "workspaces", "conv1"), { recursive: true });
      execSync(`git init -q ${repo}`);
      const ws = path.join(repo, "data", "workspaces", "conv1");
      const v = evaluateWriteVerdict("git stash drop", repo, ws);
      expect(v.verdict).toBe("BLOCK");
      const v2 = evaluateWriteVerdict("git stash pop", repo, ws);
      expect(v2.verdict).toBe("BLOCK");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  it("delta1（检视獭1636 严重 1）：--work-tree 覆盖不丢 gitdir 侧入账（双入账）——真爬升面下 stash/commit 双形态均 BLOCK", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { execSync } = await import("node:child_process");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dwtg-b2-"));
    try {
      const repo = path.join(base, "repo");
      fs.mkdirSync(path.join(repo, "data", "workspaces", "conv1"), { recursive: true });
      execSync(`git init -q ${repo}`);
      const ws = path.join(repo, "data", "workspaces", "conv1");
      // 分离值形态：gitdir 侧锄定主仓 + work-tree 侧落 ws（双入账均在账 → 主仓命中 BLOCK）
      const v1 = evaluateWriteVerdict(`git --work-tree ${ws} stash drop`, repo, ws);
      expect(v1.verdict).toBe("BLOCK");
      // attached 形态同判
      const v2 = evaluateWriteVerdict(`git --work-tree=${ws} commit -m x`, repo, ws);
      expect(v2.verdict).toBe("BLOCK");
      // override 落非豁免区（repo 外）也 BLOCK——gitdir 侧（主仓 refs）不再被丢出账
      const v3 = evaluateWriteVerdict(`git --work-tree ${path.join(base, "out")} stash drop`, repo, ws);
      expect(v3.verdict).toBe("BLOCK");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  it("cwd=真 worktree git stash drop → ALLOW（worktree 专属元数据区，语义=写 worktree 维持豁免）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { execSync } = await import("node:child_process");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dwtg-b2-"));
    try {
      const repo = path.join(base, "repo");
      fs.mkdirSync(repo, { recursive: true });
      execSync(`git init -q ${repo}`);
      execSync(`git -C ${repo} commit -q --allow-empty -m x`, {
        env: {
          ...process.env,
          // CI runner 无全局 git identity（check job 红实证 2026-10-24），测试内显式注入
          GIT_AUTHOR_NAME: "probe",
          GIT_AUTHOR_EMAIL: "probe@example.com",
          GIT_COMMITTER_NAME: "probe",
          GIT_COMMITTER_EMAIL: "probe@example.com",
        },
      });
      const wt = path.join(base, "wt");
      execSync(`git -C ${repo} worktree add -q ${wt} -b probe`);
      const v = evaluateWriteVerdict("git stash drop", repo, wt);
      expect(v.verdict).toBe("ALLOW");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
