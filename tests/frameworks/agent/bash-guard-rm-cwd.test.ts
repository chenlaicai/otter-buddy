import { describe, expect, it } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { modelParseOk } from "@frameworks/agent/guard-model-judge";
import { evaluateWriteVerdict } from "@frameworks/agent/write-verdict";
import { evaluateWriteTargets } from "@frameworks/agent/write-target-evaluator";

const ROOT = "/repo";
const WORKSPACE = `${ROOT}/data/workspaces/ws-1645`;
const WORKTREE = `${ROOT}/.otter/worktrees/wt-1645`;
const OPTS = { projectRoot: ROOT, sessionCwd: WORKSPACE };

/** 只调用静态判定；这些用例从不执行命令，也不创建或删除目标文件。 */
function guard(command: string, opts: Parameters<typeof checkBashCommandSafety>[3] = OPTS): string | null {
  expect(modelParseOk(command)).toBe(true);
  return checkBashCommandSafety(command, 999999, undefined, opts);
}

function targets(command: string, startCwd = WORKSPACE): string[] {
  const result = evaluateWriteTargets(command, ROOT, startCwd);
  expect(result.kind).toBe("evaluated");
  return result.kind === "evaluated" ? result.targets.map(t => t.path).sort() : [];
}

describe("#1645 嵌套载荷继承所属段的 cd 后 cwd", () => {
  it("反引号内相对 rm 落在外层 cd 的主仓，guard BLOCK", () => {
    const command = `cd ${ROOT} && echo "\`printf x | rm -f src/x.txt\`"`;
    expect(guard(command)).not.toBeNull();
  });

  it("$() 的求值落点同样属于外层 cd 段，不被其他通道的 BLOCK 掩盖", () => {
    const command = `cd ${ROOT} && echo "$(printf x | rm -f src/x.txt)"`;
    expect(targets(command)).toEqual([`${ROOT}/src/x.txt`]);
    expect(evaluateWriteVerdict(command, ROOT, WORKSPACE).verdict).toBe("BLOCK");
    expect(guard(command)).not.toBeNull();
  });

  it("反引号载荷的树外绝对落点保持 ALLOW", () => {
    expect(guard(`cd ${ROOT} && echo "\`printf x | rm -f /tmp/otter-buddy-1645-nested\`"`)).toBeNull();
  });

  it("载荷自己的 cd 优先于继承 cwd", () => {
    const command = `cd ${ROOT} && echo "\`cd /tmp && rm -f otter-buddy-1645-own-cd\`"`;
    expect(targets(command)).toEqual(["/tmp/otter-buddy-1645-own-cd"]);
  });

  it("外层 cd 到树外时，载荷相对 rm 保持 ALLOW", () => {
    expect(guard(`cd /tmp && echo "\`rm -f otter-buddy-1645-outer-tmp\`"`)).toBeNull();
  });
});

describe("#1645 管道各段 cwd 隔离", () => {
  it("&& 后管道中的 cd 只影响其语句链；右段删 /tmp 不再误拦", () => {
    const command = `cd ${ROOT} && printf x | rm -f /tmp/otter-buddy-1645-probe`;
    expect(targets(command)).toEqual(["/tmp/otter-buddy-1645-probe"]);
    expect(guard(command)).toBeNull();
  });

  it("管道左段 cd 是子进程；session cwd 为主仓时右段相对 rm 保守 BLOCK", () => {
    const command = "cd /tmp | rm -f src/x";
    expect(targets(command, ROOT)).toEqual([`${ROOT}/src/x`]);
    expect(evaluateWriteVerdict(command, ROOT, ROOT).verdict).toBe("BLOCK");
    expect(guard(command, { projectRoot: ROOT, sessionCwd: ROOT })).not.toBeNull();
  });

  it("语句链已进入 worktree 时，合法相对 rm 不误拦", () => {
    expect(guard(`cd ${WORKTREE} && printf x | rm -f src/x`)).toBeNull();
  });
});

describe("#1645 既有危险面与词法边界不变", () => {
  it.each([
    `cd ${ROOT} && rm -f src/x.txt`,
    `cd ${ROOT} && printf 'x\\' | rm -f src/x.txt`,
    `cd ${ROOT} && printf 'y\\\\' | rm -f src/y.txt`,
    `cd ${ROOT} && bash -c "rm -f src/x.txt"`,
  ])("已有 BLOCK 不回退：%s", command => {
    expect(guard(command)).not.toBeNull();
  });

  it("有外层 cd 时，外置脚本缺席仍走既有 fail-closed", () => {
    expect(evaluateWriteVerdict(`cd /dev && bash -c "bash x.sh"`, ROOT).verdict).toBe("BLOCK");
  });
});
