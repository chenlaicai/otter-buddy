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

describe("进程名诊断回显 kill 语境门（F20261026gobs，M-2edf95d5）", () => {
  // M-2edf95d5 案发现场：命令行含 otter-buddy 字样（--author="… <otter-buddy>"、含仓库路径
  // 脚本）在非 kill 语境下被「进程名模式」误标，回显误导根因归因（author 格式被误判进程名）。
  // 修法：「进程名模式」只在 kill 语境（有 kill 族动词）下回显——无 kill 动词时字面量是
  // 数据/命令名，不标。保护零削弱：真实 pkill/killall 目标语义的回显不变。

  it("① git commit --author=<otter-buddy>（author email）：拦（main-write）但不挂「进程名模式」", () => {
    const r = checkBashCommandSafety(`git commit --author="修复獭-守卫可观测 <otter-buddy>" -m "feat: x"`, mainPid, undefined, ctx);
    expect(r).not.toBeNull(); // 仍拦（写落点主仓）——保护零削弱
    expect(r!).toContain("写命令落点解析到主仓");
    expect(r!).not.toContain("进程名模式"); // author email 不是 kill 目标，不标
  });

  it("② node 解释器 + 主仓落点脚本（含 otter-buddy 路径）：若拦则不挂「进程名模式」", () => {
    // node 是解释器命令名不是 kill 目标；无 kill 族动词时「进程名模式」不回显。
    const r = checkBashCommandSafety(`node /Users/orca/ai/otter-buddy/scripts/check-pr-tests.mjs --base nosuchref`, mainPid, undefined, ctx);
    if (r !== null) {
      expect(r!).not.toContain("进程名模式");
    }
    // 该形态实测为 ALLOW（只读 node 探针），锁定不误拦：
    expect(r).toBeNull();
  });

  it("③ 无 kill 动词的 otter-buddy 字面量（echo）：不挂「进程名模式」", () => {
    const r = checkBashCommandSafety(`echo otter-buddy`, mainPid, undefined, ctx);
    expect(r).toBeNull(); // ALLOW（只读 echo）
  });

  it("④ 保护零削弱：真实 pkill -f otter-buddy 仍挂「进程名模式」（kill 语境）", () => {
    const r = checkBashCommandSafety(`pkill -f otter-buddy`, mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).toContain("进程名模式"); // kill 语境下目标语义回显不变
  });

  it("⑤ 保护零削弱：killall node 仍挂「进程名模式」（kill 目标是 node）", () => {
    const r = checkBashCommandSafety(`killall node`, mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).toContain("进程名模式");
  });

  it("⑥ A1 引号数据位的 kill 字样不算 kill 语境（-m \"kill the bug\" 不挂「进程名模式」）", () => {
    // 引号内 kill 是 commit message 文本（数据位）——不构成 kill 语境，otter-buddy 字样不标
    const r = checkBashCommandSafety(`git commit -m "kill the bug" --author="修复獭-守卫可观测 <otter-buddy>"`, mainPid, undefined, ctx);
    expect(r).not.toBeNull(); // 仍拦（写落点主仓）——保护零削弱
    expect(r!).not.toContain("进程名模式");
  });

  it("⑦ A1 对照：shell 载荷内 kill 动词仍是 kill 语境（bash -c 'pkill …' 照标）", () => {
    // stripQuotedTextSpans 不剥离 shell 载荷引号（是执行体不是数据）——kill 语境照算
    const r = checkBashCommandSafety(`bash -c 'pkill -f otter-buddy'`, mainPid, undefined, ctx);
    expect(r).not.toBeNull();
    expect(r!).toContain("进程名模式");
  });
});
