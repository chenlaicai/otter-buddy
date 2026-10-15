/**
 * F20261015gwr1（M-46f0e74d/#1514）：git 旗标词面判定词级化——引号含空格/attached/反引号
 * 三形态 fail-open 修复。
 *
 * 病灶（探针修前实证）：旧 GIT_WRITE_SUBCOMMAND 正则 \S+ 词面对
 * `git -C "/x y" commit`（引号含空格）/`git -C/x commit`（attached）/`git -c \`echo /repo\`
 * commit`（反引号）整体失明→写族判定 fail-open；wv 侧 attached 值丢失（落点回落 cwd
 * 被工作区豁免洗白）+ 动态 -c 载荷被词面证洗白（git 写动词不在词面写清单）。
 * 修法：写族判定/落点解析词级化（词法层归一引号/attached/转义），旧正则两侧退役；
 * 洗白面收窄（git 写族 + dynamic-path 不洗白，其余维持能力 4 语义——corpus 棘轮钉死）。
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";

const projectRoot = "/repo";
const WT = "/repo/.otter/worktrees/wt";
const sessionCwd = "/repo/data/workspaces/conv-1";
const prod = (cmd: string) => checkBashCommandSafety(cmd, 42877, undefined, { projectRoot, sessionCwd });
const wv = (cmd: string) => evaluateWriteVerdict(cmd, projectRoot, sessionCwd);

describe("F20261015gwr1 负门（修前双层 fail-open 形态，prod 拦 + wv 正判）", () => {
  it("双引号含空格主仓路径 commit → prod 拦 + wv 正判（落点证据）", () => {
    expect(prod(`git -C "/repo/work space" commit -m x`)).toContain("写命令落点解析到主仓");
    const r = wv(`git -C "/repo/work space" commit -m x`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("positive");
  });

  it("单引号含空格主仓路径 commit → 双层拦", () => {
    expect(prod(`git -C '/repo/work space' commit -m x`)).toContain("写命令落点解析到主仓");
    expect(wv(`git -C '/repo/work space' commit -m x`).verdict).toBe("BLOCK");
  });

  it("attached -C<path> 主仓 commit → 双层拦（wv 值不再回落 cwd 洗白）", () => {
    expect(prod(`git -C/repo commit -m x`)).toContain("写命令落点解析到主仓");
    const r = wv(`git -C/repo commit -m x`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("positive");
  });

  it("双引号含空格主仓路径 reset --hard → 双层拦", () => {
    expect(prod(`git -C "/repo/x y" reset --hard`)).toContain("写命令落点解析到主仓");
    expect(wv(`git -C "/repo/x y" reset --hard`).verdict).toBe("BLOCK");
  });

  it("反引号值 commit（双层全漏案面）→ prod 拦 + wv fail-closed（dynamic-path 不洗白）", () => {
    expect(prod("git -c `echo /repo` commit -m x")).toBeTruthy();
    const r = wv("git -c `echo /repo` commit -m x");
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("fail-closed");
  });

  it("纯 var -c 值 commit → wv fail-closed（同族）", () => {
    const r = wv(`git -c "$P" commit`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("fail-closed");
  });
});

describe("F20261015gwr1 放行侧（豁免正道 + 空格一致性不变量）", () => {
  it("worktree 含空格路径 commit（豁免引号感知）→ prod 放 + wv 正面 ALLOW", () => {
    expect(prod(`git -C "${WT}/a b" commit -m x`)).toBeNull();
    const r = wv(`git -C "${WT}/a b" commit -m x`);
    expect(r.verdict).toBe("ALLOW");
    expect(r.mode).toBe("positive");
  });

  it("attached -C worktree commit（豁免 attached）→ 双层放", () => {
    expect(prod(`git -C${WT} commit -m x`)).toBeNull();
    expect(wv(`git -C${WT} commit -m x`).verdict).toBe("ALLOW");
  });

  it("git push --dry-run → 放（严格语义：不算写，r2-C 基线）", () => {
    expect(prod(`git push --dry-run`)).toBeNull();
    expect(prod(`git push -n`)).toBeNull();
  });

  it("git stash push → 拦（严格语义：stash 限 push 才写）", () => {
    expect(prod(`git stash push`)).toContain("写命令落点解析到主仓");
  });

  it("空格一致性不变量：引号空格形态判词 === 无空格形态判词（#1514 病核=同语义两形态反判）", () => {
    for (const [spaced, plain] of [
      [`git -C "/repo/work space" commit -m x`, `git -C /repo/workx commit -m x`],
      [`git -C "/tmp/dir with space" commit -m x`, `git -C /tmp/dirx commit -m x`],
      [`git -C "/repo/.otter/worktrees/wt/a b" commit`, `git -C /repo/.otter/worktrees/wt/a commit`],
    ]) {
      expect(prod(spaced) === null).toBe(prod(plain) === null);
      expect(wv(spaced).verdict).toBe(wv(plain).verdict);
    }
  });
});
