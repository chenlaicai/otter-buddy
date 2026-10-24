import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

describe("#1418 探针：issue 案发现场在当前守卫下的真实裁决", () => {
  const mainPid = 99999;
  const projectRoot = "/repo";
  const sessionCwd = "/repo/data/workspaces/wsid";
  const mainCwd = "/repo"; // 主仓 cwd——相对路径 data/… 应解析到主仓 data/

  it("case1: rm 绝对路径 workspace 沙箱文件（bcb118fb 原形态）→ ALLOW", () => {
    const cmd = "rm /repo/data/workspaces/wsid/claim-1374.md /repo/data/workspaces/wsid/F20261009qdlq-lexer-quoted-dollar-rawquote.md";
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });
    console.log("case1:", r === null ? "ALLOW" : "BLOCK");
    expect(r).toBeNull();
  });

  it("case2: cd workspace 子目录后 rm 相对文件（ded4a536 原形态）→ ALLOW", () => {
    const cmd = "cd /repo/data/workspaces/wsid/data && rm -f tmp-hn-typesafe.json tmp-hn-typesafe-item.json tmp-tao.html && ls";
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });
    console.log("case2:", r === null ? "ALLOW" : "BLOCK");
    expect(r).toBeNull();
  });

  it("case3: mv workspace 文件到 ~/.Trash（正道形态）→ 修法后应 ALLOW", () => {
    const cmd = "mv /repo/data/workspaces/wsid/tmp.md ~/.Trash/";
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });
    console.log("case3:", r === null ? "ALLOW" : "BLOCK");
    expect(r).toBeNull();
  });

  it("case4: cd workspace 后 mv 相对文件到 ~/.Trash → 修法后应 ALLOW", () => {
    const cmd = "cd /repo/data/workspaces/wsid && mv tmp.md ~/.Trash/";
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });
    console.log("case4:", r === null ? "ALLOW" : "BLOCK");
    expect(r).toBeNull();
  });

  it("case5: 主仓 data 真删除 rm -rf data/metrics（对照组，必须 BLOCK）", () => {
    // 探针修正：需要 cwd=projectRoot 才能让相对路径 data/metrics 解析到主仓
    const r = checkBashCommandSafety("rm -rf data/metrics", mainPid, undefined, { projectRoot, sessionCwd: projectRoot });
    console.log("case5:", r === null ? "ALLOW" : "BLOCK");
    expect(r).not.toBeNull();
  });

  it("case6: mv 主仓 data 绝对路径源端到 ~/.Trash（边界组——修法后必须仍 BLOCK）", () => {
    // 修正：源端用绝对路径——sessionCwd 恒为会话工作区，相对 data/metrics 会解析进工作区子树（合法豁免）
    const cmd = "mv /repo/data/metrics ~/.Trash/stolen-metrics";
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });
    console.log("case6:", r === null ? "ALLOW" : "BLOCK");
    expect(r).not.toBeNull(); // 源端在主仓 data/ 下，必须拦——Trash 白名单只豁免目的端
  });

  it("case7: 无 sessionCwd 时 rm 绝对路径 workspace（守旧行为对照，必须 BLOCK）", () => {
    const cmd = "rm /repo/data/workspaces/wsid/claim.md";
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot });
    console.log("case7:", r === null ? "ALLOW" : "BLOCK");
    expect(r).not.toBeNull();
  });

  it("case8: mv workspace 文件到 ~/.Trash 带文件名（目的端非裸目录）→ 修法后应 ALLOW", () => {
    const cmd = "mv /repo/data/workspaces/wsid/tmp.md ~/.Trash/tmp-old.md";
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });
    console.log("case8:", r === null ? "ALLOW" : "BLOCK");
    expect(r).toBeNull(); // 目的端 ~/.Trash/ 前缀白名单生效
  });

  it("case9: cd 主仓后 mv 相对 data 到 ~/.Trash（cd 跟踪组——必须 BLOCK）", () => {
    const cmd = "cd /repo && mv data/metrics ~/.Trash/x";
    const r = checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd });
    console.log("case9:", r === null ? "ALLOW" : "BLOCK");
    expect(r).not.toBeNull(); // cd /repo 后相对 data/metrics 解析到主仓 data——源端命中
  });
});
