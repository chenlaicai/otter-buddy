/**
 * F20261010gshw 零干预对照测试：接线前后守卫判定行为逐条一致（影子是旁听不是陪审）。
 *
 * 方法：同一命令集（拦截侧 + 放行侧 + 负门族）直接调 checkBashCommandSafety
 * （生产判定链——影子挂在判定链外层的 abortOnUnsafeBash，判定函数本身零改动），
 * 断言与 main 基线预期一致；再用 attachCircuitBreaker 挂影子回调重跑，断言
 * abort 行为不因影子的存在/异常而变化。
 */
import { describe, it, expect, vi } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";
import { attachCircuitBreaker } from "@frameworks/agent/circuit-breaker-helpers";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@frameworks/agent/tool-call-circuit-breaker";

const ROOT = "/repo";
const WT = "/repo/.otter/worktrees/wt";
/** 与既有基线测试同形态（bash-safety-guard.test.ts:61）：假 mainPid 42877 ——
 *  走 V2 主链（cd 豁免/负门全挂载），避开 mainPid=null 降级链（未挂 cd 豁免） */
const MAIN_PID = 42877;

/** 命令集：[描述, 命令, 预期拦截(=判定非 null)]——覆盖拦截侧/放行侧/#1381 负门族 */
const CASES: Array<[string, string, boolean]> = [
  ["主仓写（git commit 无 cd）→ 拦", "git commit -m x", true],
  ["主仓重定向 → 拦", "git log > /repo/hacked.txt", true],
  ["cd worktree 后相对写 → 放（cd 豁免）", `cd ${WT} && git commit -m x`, false],
  ["cd worktree 后 || 备用链 → 放（#1360 修复面）", `cd ${WT} && node -e "console.log(1)" || echo fallback`, false],
  ["cd worktree 后 git commit 真管道（V2 段级）→ 放（#1170：管道右段不影响首段 cd 链）", `cd ${WT} && git commit -m x | tail -1`, false],
  ["cd worktree 后 node -e 写 worktree | tail（parseOk=false 落 V1，真管道杀豁免）→ 拦", `cd ${WT} && node -e "require('fs').writeFileSync('/repo/.otter/worktrees/wt/data/x','1')" | tail -1`, true],
  ["只读命令 → 放", "ls -la", false],
  ["$W/.. 爬升（#1381 负门）→ 旧链放（cd 豁免灰区 #1363，求值器回落）——现状基线", `W=${WT}; cd $W/../../../main && touch foo`, false],
  ["heredoc 体写主仓（#1240 负门）→ 拦", `cd /tmp && python3 - <<'PY'\nopen("${ROOT}/data/x","w")\nPY`, true],
  ["kill 主 PID（42877）→ 拦（kill 族防线，影子不碰）", "kill 42877", true],
];

describe("零干预对照：影子挂载前后守卫判定逐条一致", () => {
  it("判定链本体（checkBashCommandSafety）与基线预期一致", () => {
    for (const [desc, cmd, expectBlock] of CASES) {
      const r = checkBashCommandSafety(cmd, MAIN_PID, undefined, { projectRoot: ROOT });
      // mainPid=null 走降级链（checkWhenMainPidMissing）：主仓写/重定向/heredoc 体判定
      // 均在 pidFree 规则族内照常生效；kill 字面量非主 PID 放行（降级链 kill 保守放行）
      expect(r !== null, `${desc}：expected ${expectBlock ? "BLOCK" : "PASS"}, got ${r === null ? "PASS" : "BLOCK"}`).toBe(expectBlock || desc.includes("kill"));
    }
  });

  it("attachCircuitBreaker 挂影子（正常回调）与不挂影子，abort 行为逐条一致", () => {
    const runWith = (onShadowEval?: (input: { command: string; oldBlock: string | null }) => void) => {
      const handlers: Array<(event: unknown) => void> = [];
      const session = {
        steer: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        subscribe(fn: (event: unknown) => void) {
          handlers.push(fn);
          return () => undefined;
        },
      };
      attachCircuitBreaker(session, "otter-x", DEFAULT_CIRCUIT_BREAKER_CONFIG, {
        info: () => undefined, warn: () => undefined, error: () => undefined,
      } as never, { projectRoot: ROOT, onShadowEval });
      for (const [, cmd] of CASES) {
        for (const fn of handlers) fn({ type: "tool_execution_start", toolCallId: `t-${cmd.slice(0, 12)}`, toolName: "bash", args: { command: cmd } });
      }
      return session.abort.mock.calls.length;
    };
    const baseline = runWith(undefined);
    const withShadow = runWith((input) => {
      if (!input.command) throw new Error("bad input");
    });
    expect(withShadow).toBe(baseline);
    expect(baseline).toBeGreaterThan(0); // 对照集内确有拦截（防全放行的平凡绿）
  });
});
