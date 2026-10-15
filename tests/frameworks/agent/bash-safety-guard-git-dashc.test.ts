/**
 * F20261015glfp（M-bf4049a3 止血）：git -C <worktree> 写族落点豁免——双链语义割裂修复。
 *
 * 病灶（案卷 b9026422 + 探针复现）：V1 生产链的 git 写族豁免只认 cd 形态
 * （cwdInGitWorktree→skipGitWrite），`git -C <worktree> commit` 无 cd 段即被
 * 「写命令落点解析到主仓」误拦——尽管落点是 worktree 自树的 git 操作。
 * v2 求值器（write-target-evaluator evalGitWrite）早有「-C 目标优先」落点跟踪，
 * 同命令两链反判 = #1170→#1360 同款「修复只落一条链」割裂，本修复对齐语义。
 *
 * 放行侧钉死（误拦止血面）：-C 目标落 worktree 区（<root>/.otter/worktrees/<name>[/…]）
 * 拦截侧钉死（负门不放水）：主仓根/worktrees 根自身/../ 逃逸/--git-dir|--work-tree 覆盖/
 * 混合段主仓写/攻击面（eval 注入、主服务脚本 stop/restart、pkill 族）
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const projectRoot = "/repo";
const WT = "/repo/.otter/worktrees/wt";
const sessionCwd = "/repo/data/workspaces/conv-1";
const mainPid = 42877;

const allow = (cmd: string, cwd: string | undefined = sessionCwd) =>
  checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot, sessionCwd: cwd });
const block = allow;

describe("F20261015glfp git -C worktree 落点豁免（放行侧）", () => {
  it("案卷样本：git -C <wt> commit --author=$(cat) -F（eval/路径词面双命中曾误拦）", () => {
    expect(allow(`git -C /repo/.otter/worktrees/guard-eval-v2 commit --author="$(cat /tmp/author.txt)" -F /tmp/msg.txt`)).toBeNull();
  });

  it("git -C <wt> commit（裸形态）", () => {
    expect(allow(`git -C ${WT} commit -m x`)).toBeNull();
  });

  it("引号包裹 worktree 路径", () => {
    expect(allow(`git -C "${WT}" commit -m x`)).toBeNull();
  });

  it("多级 -C 累积落 worktree", () => {
    expect(allow(`git -C ${projectRoot} -C .otter/worktrees/wt commit -m x`)).toBeNull();
  });

  it("worktree 子目录（上溯 worktree 自树 .git）", () => {
    expect(allow(`git -C ${WT}/src commit -m x`)).toBeNull();
  });

  it("相对 -C 从 worktree 内 sessionCwd 解析", () => {
    expect(allow(`git -C ../ commit -m x`, `${WT}/src`)).toBeNull();
  });

  it("git -C <wt> push（corpus 同形态）", () => {
    expect(allow(`git -C ${WT} push -u origin fix/x`)).toBeNull();
  });

  it("X1 同修：wrapper 旗标 + git -C <wt> commit（豁免同宽不误伤）", () => {
    expect(allow(`git --no-pager -C ${WT} commit -m x`)).toBeNull();
  });

  it("git -C <wt> commit | tail（管道右段不影响豁免，#1170 族）", () => {
    expect(allow(`git -C ${WT} commit -m x | tail -2`)).toBeNull();
  });
});

describe("F20261015glfp git -C 落点负门（拦截侧，不许放水）", () => {
  it("X1 同修：wrapper 旗标 + git -C 主仓 commit（写族判定不得因旗标逃逸）→ 拦", () => {
    expect(block(`git --no-pager -C ${projectRoot} commit -m x`)).toContain("写命令落点解析到主仓");
  });

  it("X1 同修：wrapper 旗标 + git -C 主仓 reset --hard（evalGitWrite 同构洞）→ 拦", () => {
    expect(block(`git --no-pager -C ${projectRoot} reset --hard`)).toContain("写命令落点解析到主仓");
  });

  it("git -C 主仓根 commit → 拦", () => {
    expect(block(`git -C ${projectRoot} commit -m x`)).toContain("写命令落点解析到主仓");
  });

  it("git -C worktrees 根自身 commit（上溯主仓 .git）→ 拦", () => {
    expect(block(`git -C ${projectRoot}/.otter/worktrees commit -m x`)).toContain("写命令落点解析到主仓");
  });

  it(".. 逃逸出 worktree 区 → 拦", () => {
    expect(block(`git -C ${WT}/../../.. commit -m x`)).toContain("写命令落点解析到主仓");
  });

  it("--git-dir 覆盖改写落点 → 拦", () => {
    expect(block(`git -C ${WT} --git-dir=${projectRoot}/.git commit -m x`)).toContain("写命令落点解析到主仓");
  });

  it("--work-tree 覆盖改写落点 → 拦", () => {
    expect(block(`git -C ${WT} --work-tree=${projectRoot} commit -m x`)).toContain("写命令落点解析到主仓");
  });

  it("混合段：wt 写豁免不泄漏——同命令第二段主仓 git 写照拦", () => {
    expect(block(`git -C ${WT} commit -m x && git commit -m y`)).toContain("写命令落点解析到主仓");
  });

  it("~ 前缀不展开 → 拦", () => {
    expect(block(`git -C "~/evil" commit -m x`)).toContain("写命令落点解析到主仓");
  });

  it("相对 -C 无绝对 sessionCwd 基准（fail-closed）→ 拦", () => {
    expect(block(`git -C .otter/worktrees/wt commit -m x`, undefined)).toContain("写命令落点解析到主仓");
  });

  it("嵌套 decoy（data/.otter/worktrees）不豁免 → 拦", () => {
    expect(block(`git -C ${projectRoot}/data/.otter/worktrees/wt commit -m x`)).toContain("写命令落点解析到主仓");
  });

  it("攻击面负门：eval 包装数字参数照拦", () => {
    expect(block(`eval "kill 42877"`)).toBeTruthy();
  });

  it("攻击面负门：主服务脚本 restart 照拦", () => {
    expect(block(`./scripts/otter-buddy.sh restart`)).toBeTruthy();
  });

  it("攻击面负门：pkill otter 特征名照拦", () => {
    expect(block(`pkill -f otter-buddy`)).toBeTruthy();
  });
});
