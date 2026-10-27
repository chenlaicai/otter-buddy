import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

/**
 * #1544 回归测试（F20261027bgkw）——反引号嵌套载荷漏拦。
 *
 * 修前实证（大獭，main 9c1705b5，含 #1636+#1648）：10 例探针中仅 B3（反引号嵌套
 * cd 主仓 && git commit）ALLOW，其余 9 例判定正确。
 *
 * 真根因（修正简报的 collectPayloads 假设）：lexer 把反引号词法化为 cmdsub part
 * （command-lexer.ts :309），collectPayloads 天然递归覆盖，模型层与求值器对
 * backtick/$() 等价处理（trace 实证 parseOnce 产出一致、evaluateWriteVerdict 对
 * backtick 形态判 BLOCK positive）。缺口在沙箱链：sandboxGuarded=true 时求值器
 * 退役（F20261016gsbx G3 枚举表），保留面 SUBSHELL_GIT_WRITE_GATE 壳字符类 [({]
 * 只认 $()/命令组，不认反引号壳 → 兜底落空 ALLOW。
 *
 * 修法：壳字符类扩反引号（[`({]，字符类排除同步补 `），反引号壳内 git 写族字面
 * fail-closed 拦——与 $() 壳同口径（壳内不看 cwd 是既有保守面，$() 修前即如此）。
 */
const MAIN = "/Users/orca/ai/otter-buddy";
const WT = "/Users/orca/ai/otter-buddy/.otter/worktrees/probe";
const PID = 42877;
const SESS = "/Users/orca/ai/otter-buddy/data/workspaces/probe-session";

const go = (cmd: string, sg = true, cwd = SESS) =>
  checkBashCommandSafety(cmd, PID, undefined, { projectRoot: MAIN, sessionCwd: cwd, sandboxGuarded: sg });

describe("#1544 反引号嵌套载荷（修后回归，sg=真实沙箱形态）", () => {
  const cases: Array<[string, string, "ALLOW" | "BLOCK"]> = [
    ["B1 cd MAIN && git commit", `cd ${MAIN} && git commit -m "x"`, "BLOCK"],
    ["B2 cd MAIN; git commit", `cd ${MAIN}; git commit -m "x"`, "BLOCK"],
    ["B3 反引号嵌套 commit（本 PR 修复目标）", 'echo "`cd ' + MAIN + ' && git commit -m x`"', "BLOCK"],
    ["B4 $() 嵌套 commit", 'echo "$(cd ' + MAIN + ' && git commit -m x)"', "BLOCK"],
    ["B5 git -C MAIN commit", `git -C ${MAIN} commit -m "x"`, "BLOCK"],
    ["B6 --git-dir=MAIN/.git commit", `git --git-dir=${MAIN}/.git commit -m "x"`, "BLOCK"],
    ["B7 subshell (cd MAIN && commit)", `(cd ${MAIN} && git commit -m "x")`, "BLOCK"],
    ["B8 if 控制流 cd+commit", `if true; then cd ${MAIN}; git commit -m "x"; fi`, "BLOCK"],
    ["B9 worktree commit（合法对照）", `cd ${WT} && git commit -m "x"`, "ALLOW"],
    ["B10 cd MAIN && git status（只读对照）", `cd ${MAIN} && git status`, "ALLOW"],
  ];
  for (const [name, cmd, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      const r = go(cmd);
      if (expected === "BLOCK") {
        expect(r).not.toBeNull();
        // 主仓写拦截语义（rewriteMainWriteBlockMsg 口径）
        expect(String(r)).toContain("写命令落点解析到主仓");
      } else {
        expect(r).toBeNull();
      }
    });
  }
});

describe("#1544 反引号修复翻判面（不误拦纯数据/只读形态）", () => {
  it("反引号纯数据形态（echo `date`）→ ALLOW", () => {
    expect(go('echo "`date`"')).toBeNull();
  });
  it("反引号只读子命令（echo `git status`）→ ALLOW", () => {
    expect(go('echo "`git status`"')).toBeNull();
  });
  it("$() 只读子命令（echo $(git status)）→ ALLOW", () => {
    expect(go('echo "$(git status)"')).toBeNull();
  });
  it("裸反引壳 git commit（无 cd）→ BLOCK（对齐 $() 既有口径）", () => {
    expect(go('echo "`git commit -m x`"')).not.toBeNull();
  });
  it("裸 $() 壳 git commit（无 cd）→ BLOCK（既有口径不回退）", () => {
    expect(go('echo "$(git commit -m x)"')).not.toBeNull();
  });
  it("非沙箱链（sg=false）反引号嵌套主仓 commit → BLOCK（求值器链既有行为）", () => {
    expect(go('echo "`cd ' + MAIN + ' && git commit -m x`"', false)).not.toBeNull();
  });
});
