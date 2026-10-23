/**
 * F20261019f714（M-f7148deb 第 3 条）：进程名诊断回显收窄 + 守卫双向回归断言。
 *
 * 案发现场：healing f3d5ebe5（03:10，worktree 内 git reset + mv $VAR 复合命令被
 * main_write_resolve 拦）与 f34409ce（07:46，high，node -e 载荷被拦）——两案命中
 * 详情都挂着「进程名模式：…otter-buddy…" 的路径片段标签，把归因两次带偏（次发现
 * 报告归因「进程名模式误拦」；F20260924gfpn 更早实测证伪过同名「第五缺陷」误判——
 * 该模式在 locateTriggerContext 只做诊断回显、不参与拦截判定）。
 *
 * 本文件锁定三件事（改窄不改宽）：
 *  ① 诊断面收窄：路径型 token（/…/otter-buddy/…、…/dist/src/main.js）不参与进程名
 *    判定——worktree/主仓路径 + sleep 的拦截文案不再挂「进程名模式」误标签；
 *  ② 保护零削弱：真实 kill/pkill 违规形态仍被拦，且真实进程名（非路径形态）回显保持；
 *  ③ 设计语义不放宽：f34409ce 的 node -e 载荷含 execFileSync 调用形态，命中 exec 类
 *    负门（拍板的不可证 fail-closed）——持续拦截，不是本 PR 的误拦修复对象。
 *
 * 「修复前失败」证据链：① 的 not.toContain 断言在收窄前必红（路径命中仍回显
 * 「进程名模式」）；③ 在基线同样拦截（保护不因收窄而变化，双向对照）。
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const mainPid = 42877;
const projectRoot = "/Users/orca/ai/otter-buddy";
const sessionCwd = "/Users/orca/ai/otter-buddy/data/workspaces/3241317b-99d6-4d78-9248-ff208a7461bc";
const ctx = { projectRoot, sessionCwd };
const WT = "/Users/orca/ai/otter-buddy/.otter/worktrees/f7148deb-three-fixes";

describe("进程名诊断回显收窄（F20261019f714，M-f7148deb 第 3 条）", () => {
  it("①(b) worktree 路径 + sleep：仍拦（sleep 规则），但不再回显「进程名模式」误标签", () => {
    const r = checkBashCommandSafety(`cd ${WT} && sleep 10`, mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).toContain("sleep");
    expect(r!).not.toContain("进程名模式");
  });

  it("①(b) 主仓路径 + sleep：路径型 otter-buddy 不参与进程名判定", () => {
    const r = checkBashCommandSafety("cd /Users/orca/ai/otter-buddy && sleep 10", mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).not.toContain("进程名模式");
  });

  it("①(b) git reset（worktree 内，f3d5ebe5 同形态）：不拦且无命中详情", () => {
    const r = checkBashCommandSafety(`cd ${WT} && git reset HEAD`, mainPid, undefined, ctx);
    expect(r).toBeNull();
  });

  it("①(c) 相对路径形态 dist/src/main.js（J3，F20261022j2j3）：仍拦（sleep），但不再回显「进程名模式」误标签", () => {
    // J3 案发现场：相对路径形态只被旧正則的 (?<!\/) 挡住绝对路径邻接，`dist/src/main`
    // 的 `d` 前是空格仍命中「进程名模式」。收窄为「token 含 / 一律不标」后，路径片段
    // 不再挂进程名标签；拦截本身由 sleep 规则承担（保护零削弱）。
    const r = checkBashCommandSafety("cd /tmp/proj && dist/src/main.js --port 3100 && sleep 5", mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).toContain("sleep");
    expect(r!).not.toContain("进程名模式");
  });

  it("②(a) pkill -f 真实进程名：仍拦 + 「进程名模式」真命中回显保持", () => {
    const r = checkBashCommandSafety("pkill -f otter-buddy", mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).toContain("pkill");
    expect(r!).toContain("进程名模式");
  });

  it("②(a) kill 字面量指向主 PID：仍拦（保护零削弱）", () => {
    const r = checkBashCommandSafety(`kill ${mainPid}`, mainPid, undefined, ctx);
    expect(r).not.toBeNull();
  });

  it("②(a+b) pkill 目标是路径形态：仍拦（kill 族命中），路径不挂进程名标签", () => {
    const r = checkBashCommandSafety("pkill -f /Users/orca/ai/otter-buddy/dist/src/main.js", mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).toContain("pkill");
    expect(r!).not.toContain("进程名模式");
  });

  it("③ f34409ce 同形态 node -e 载荷（execFileSync 调用面）：exec 负门持续拦截（不放宽）", () => {
    const cmd = `cd ${WT} && node -e '
const { execFileSync } = require("node:child_process");
const full = execFileSync("git", ["diff","--cached","-U0","-M"], {encoding:"utf8"});
console.log(full.slice(0, 400));
' 2>&1 | head -20`;
    const r = checkBashCommandSafety(cmd, mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).toContain("写命令落点解析到主仓");
  });

  it("③ 对照：无 exec 面的 node -e 载荷（含路径字面量）不因路径被拦", () => {
    const cmd = `cd ${WT} && node -e 'console.log("/Users/orca/ai/otter-buddy/.otter/worktrees/x/docs/a.md")'`;
    const r = checkBashCommandSafety(cmd, mainPid, undefined, ctx);
    expect(r).toBeNull();
  });
});
