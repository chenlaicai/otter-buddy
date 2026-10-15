/**
 * F20261015gali（M-edd889c2）：git alias shell 展开（! 前缀）载荷求值（v2 求值器侧）。
 *
 * 双层之一：wv 侧对 alias 载荷的写面走 judgeScriptPayload 同口径递归（via:"alias-shell"），
 * 正判落点（非回落恰好放行）；动态/不可提取 → fail-closed（script-payload-dynamic）。
 * 域分工（F20261015smrj 口径）：载荷非写面（kill 等）由文本路径规则承担，本层只判写面
 * ——kill 载荷 wv 放行是域分工不是反判，prod 侧有钉（bash-safety-guard-git-alias.test.ts）。
 */
import { describe, it, expect } from "vitest";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";
import type { WriteVerdictResult } from "@frameworks/agent/write-verdict";

const ROOT = "/repo";
const WT = "/repo/.otter/worktrees/wt";
const CWD = "/repo/data/workspaces/conv-1";
const wv = (cmd: string) => evaluateWriteVerdict(cmd, ROOT, CWD);

/** positive 变体才携带 targets（fail-closed 无落点证据）——收窄后取 */
function targetsOf(r: WriteVerdictResult): Array<{ path: string; via: string; access: string }> {
  return r.mode === "positive" ? r.targets : [];
}

describe("F20261015gali 求值器侧：alias 载荷写面正判", () => {
  it("审视样本：-c alias! 载荷 reset --hard 主仓 → BLOCK 正判（via:alias-shell）", () => {
    const r = wv(`git -C ${WT} -c alias.pwn='!git -C /repo reset --hard' pwn`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("positive");
    const t = targetsOf(r).find(t => t.path === "/repo");
    expect(t?.via).toBe("alias-shell");
    expect(t?.access).toBe("write");
  });

  it("持久注入 config alias '!载荷' → BLOCK 正判", () => {
    const r = wv(`git config alias.pwn '!git -C /repo reset --hard'`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("positive");
    expect(targetsOf(r).some(t => t.via === "alias-shell" && t.path === "/repo")).toBe(true);
  });

  it("--global 注入 rm -rf 主仓 data → BLOCK 正判（写词面载荷）", () => {
    const r = wv(`git config --global alias.pwn '!rm -rf /repo/data'`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("positive");
    expect(targetsOf(r).some(t => t.via === "alias-shell" && t.path === "/repo/data")).toBe(true);
  });

  it("嵌套 sh -c 载荷（S6 语义丢失修法钉死）→ BLOCK 正判", () => {
    const r = wv(`git -c alias.pwn='!sh -c "rm -rf /repo"' pwn`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("positive");
    expect(targetsOf(r).some(t => t.via === "alias-shell" && t.path === "/repo")).toBe(true);
  });

  it("动态载荷 → fail-closed（不可证不豁免）", () => {
    const r = wv(`git -c alias.pwn='!$P' pwn`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("fail-closed");
  });

  it("双引号动态载荷（键+! 可见证）→ fail-closed", () => {
    const r = wv(`git -c alias.pwn="!$P" pwn`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("fail-closed");
  });
});

describe("F20261015gali 求值器侧：放行侧（carve-out）", () => {
  it("无害载荷 !git status → 正面 ALLOW（零写面）", () => {
    const r = wv(`git -c alias.s='!git status' s`);
    expect(r.verdict).toBe("ALLOW");
    expect(r.mode).toBe("positive");
  });

  it("纯子命令别名（非 !）→ 正面 ALLOW", () => {
    const r = wv(`git -c alias.co=checkout co main`);
    expect(r.verdict).toBe("ALLOW");
    expect(r.mode).toBe("positive");
  });

  it("载荷 worktree 自树写（#1515 语义随载荷继承）→ 正面 ALLOW", () => {
    const r = wv(`git -c alias.pwn='!git -C ${WT} commit' pwn`);
    expect(r.verdict).toBe("ALLOW");
    expect(r.mode).toBe("positive");
  });
});

describe("F20261015gali X1 wrapper 旗标洞回归（evalGitWrite 同修）", () => {
  it("wrapper 旗标 + -c alias 注入 → BLOCK 正判（旧版走查折断双层全放）", () => {
    const r = wv(`git --no-pager -c alias.pwn='!git -C /repo reset --hard' pwn`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("positive");
    expect(targetsOf(r).some(t => t.via === "alias-shell" && t.path === "/repo")).toBe(true);
  });

  it("wrapper 旗标 + git -C 主仓 reset --hard（写族判定不因旗标逃逸）→ BLOCK 正判", () => {
    const r = wv(`git --no-pager -C /repo reset --hard`);
    expect(r.verdict).toBe("BLOCK");
    expect(r.mode).toBe("positive");
    expect(targetsOf(r).some(t => t.path === "/repo" && t.access === "write")).toBe(true);
  });

  it("wrapper 旗标 + git -C worktree commit（豁免同宽）→ 正面 ALLOW", () => {
    const r = wv(`git --no-pager -C ${WT} commit`);
    expect(r.verdict).toBe("ALLOW");
    expect(r.mode).toBe("positive");
  });
});
