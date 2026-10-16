/**
 * F20261016gwr1（M-46f0e74d/#1514）：git 旗标词面判定词级化——引号含空格/attached/反引号
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

describe("F20261016gwr1 负门（修前双层 fail-open 形态，prod 拦 + wv 正判）", () => {
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

describe("F20261016gwr1 放行侧（豁免正道 + 空格一致性不变量）", () => {
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

describe("F20261016gwr1 修复轮（检视獭1519 一审严重 1 + 建议 1/2/3）", () => {
  it("严重 1：附着+动态混合形态 -c\"$P\" commit → 双层拦（红线：同语义不得拼接反判）", () => {
    expect(prod(`git -c"$P" commit`)).toBeTruthy();
    expect(wv(`git -c"$P" commit`).verdict).toBe("BLOCK");
  });

  it("严重 1：附着 -C\"$P\" commit → 双层拦", () => {
    expect(prod(`git -C"$P" commit`)).toBeTruthy();
    expect(wv(`git -C"$P" commit`).verdict).toBe("BLOCK");
  });

  it("严重 1：附着 -C$P commit（无引号拼接）→ 双层拦", () => {
    expect(prod(`git -C$P commit`)).toBeTruthy();
    expect(wv(`git -C$P commit`).verdict).toBe("BLOCK");
  });

  it("红线：git -C\"$P\" status 只读面不误拦（后续无写族子命令）", () => {
    expect(prod(`git -C"$P" status`)).toBeNull();
    expect(wv(`git -C"$P" status`).verdict).toBe("ALLOW");
  });

  it("建议 1：前导 pushd 改全局 reason 不旁落洗白（段自身证据触发）", () => {
    expect(prod(`pushd /tmp && git -C "/repo/work space" commit`)).toBeTruthy();
    expect(wv(`pushd /tmp && git -C "/repo/work space" commit`).verdict).toBe("BLOCK");
  });

  it("建议 2：bare git stash ≡ git stash push（第四对不变量）", () => {
    expect(prod(`git stash`) === null).toBe(prod(`git stash push`) === null);
    expect(prod(`git stash`)).toContain("写命令落点解析到主仓");
  });

  it("建议 3：wv core.worktree 树发现改写 → fail-closed（与 prod 对称）", () => {
    expect(prod(`git -c core.worktree=/repo -C ${WT} commit`)).toBeTruthy();
    const r = wv(`git -c core.worktree=/repo -C ${WT} commit`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("fail-closed");
  });

  it("严重 1 对称面：附着+动态 alias 定义（键+! 可见证）→ opaque 拦", () => {
    expect(prod(`git -c"alias.pwn=!$P" pwn`)).toBeTruthy();
  });
});

describe("F20261016gwr1 修复轮二（检视獭1519 delta 残留 1/2，大獭 16/10 10:27 裁决）", () => {
  it("残留 1 放行侧：越位扫参不误判——参数词 push 不当子命令位，与静态形态同判", () => {
    expect(prod(`git -C /repo log -G push`)).toBeNull();
    expect(prod(`git -C"$P" log -G push`)).toBeNull();
    const r = wv(`git -C"$P" log -G push`);
    expect(r.verdict).toBe("ALLOW");
    expect(r.verdict === "ALLOW" && r.mode).toBe("positive");
  });

  it("残留 1 拦截侧：子命令位写族照拦（前瞻停位不弃权；取值旗标吞值后仍命中写族）", () => {
    expect(prod(`git -C"$P" commit`)).toBeTruthy();
    expect(prod(`git -c"$P" -C /repo push`)).toBeTruthy();
    expect(wv(`git -c"$P" -C /repo push`).verdict).toBe("BLOCK");
  });

  it("残留 1 红线守恒：git -C\"$P\" status 只读面照常放（停位后无写族命中）", () => {
    expect(prod(`git -C"$P" status`)).toBeNull();
    expect(wv(`git -C"$P" status`).verdict).toBe("ALLOW");
  });

  it("残留 2：bare git stash wv ≡ git stash push（main-cwd 形态，wv 半边对称补齐，落点入账）", () => {
    // main-cwd 形态（检视獭1519 delta 探针同款）——工作区 cwd 写面归沙盒区（OTTER_RUNTIME_REGIONS）不判主仓写
    const wvMain = (cmd: string) => evaluateWriteVerdict(cmd, projectRoot, projectRoot);
    const bare = wvMain(`git stash`);
    expect(bare).toMatchObject({ verdict: "BLOCK", mode: "positive" });
    expect(bare.verdict === "BLOCK" && bare.mode === "positive" && bare.mainHits.length > 0).toBe(true);
    expect(wvMain(`git stash`).verdict).toBe(wvMain(`git stash push`).verdict);
    expect(prod(`git stash`) === null).toBe(prod(`git stash push`) === null);
  });

  it("残留 2 旗标形同口径：git stash -m x ≡ git stash push -m x（main-cwd 双层同判）", () => {
    const wvMain = (cmd: string) => evaluateWriteVerdict(cmd, projectRoot, projectRoot);
    expect(wvMain(`git stash -m x`).verdict).toBe(wvMain(`git stash push -m x`).verdict);
    expect(wvMain(`git stash -m x`).verdict).toBe("BLOCK");
    // 落点入账证据（mainHits 非空即入账）：修复前 bare/旗标形 targets=[] 被洗白
    const flagForm = wvMain(`git stash -m x`);
    expect(flagForm.verdict === "BLOCK" && flagForm.mode === "positive" && flagForm.mainHits.length > 0).toBe(true);
  });

  it("残留 2 只读面守恒：git stash list 双层照常放", () => {
    expect(prod(`git stash list`)).toBeNull();
    expect(wv(`git stash list`).verdict).toBe("ALLOW");
  });
});
