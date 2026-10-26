/**
 * F20261026gobs（M-2bf6e98c）：bash 守卫门（tool_call 层显式落痕）。
 *
 * 案发现场：#1616 主仓落点 node 探针「静默 exit 0、零输出」（--base nosuchref 必报错路径
 * 也静默），对照实验证明命令未执行到脚本——守卫拦截在 tool_execution_start 走 abort，
 * 信号异步生效与工具执行竞态，被拦命令可能已 spawn 并返回静默成功；abort 后自动重试
 * 又冲淡痕迹。探针据此误判为闸洞（假绿）。
 *
 * 修法：拦截前置到 tool_call 门（与 halt/loop-block 同机制）——被拦命令不执行，
 * SDK 对 block 生成 isError tool result（reason 正文）返回 LLM，即「显式落痕」：
 * 模型/探针看到「此命令被安全守卫拦截（未执行）：<理由>」而非静默 exit 0。
 *
 * 本文件锁定：
 *  ① 被拦 bash 命令 → {block:true, reason 含「被安全守卫拦截（未执行）」}（显式落痕）；
 *  ② 放行 bash 命令 → undefined（不误伤）；
 *  ③ 非 bash 工具 / store 缺守卫参数（fail-open）/ 空命令 → undefined；
 *  ④ 判定与 abortOnUnsafeBash 同源（同 checkBashCommandSafety），门与 abort 不分歧。
 */
import { describe, it, expect } from "vitest";
import { bashGuardGate, type OtterInvokeContext } from "@frameworks/agent/model-runtime-registry";

const store: OtterInvokeContext = {
  otterPromptConfig: undefined,
  identityPrefix: "",
  otterId: "test-otter",
  guardProjectRoot: "/Users/orca/ai/otter-buddy",
  guardSessionCwd: "/Users/orca/ai/otter-buddy/data/workspaces/test",
};

describe("bashGuardGate（M-2bf6e98c 拦截显式落痕）", () => {
  it("① 被拦 bash 命令返回 block + 显式「被安全守卫拦截（未执行）」reason", () => {
    const r = bashGuardGate(store, "bash", { command: "pkill -f otter-buddy" });
    expect(r).toBeDefined();
    expect(r!.block).toBe(true);
    expect(r!.reason).toContain("被安全守卫拦截（命令未执行）");
    expect(r!.reason).toContain("pkill"); // 理由透传守卫拦截文案
  });

  it("② 放行 bash 命令返回 undefined（不误伤）", () => {
    expect(bashGuardGate(store, "bash", { command: "git log --oneline -5" })).toBeUndefined();
  });

  it("③ 非 bash 工具返回 undefined", () => {
    expect(bashGuardGate(store, "speak", { body: "hi" })).toBeUndefined();
    expect(bashGuardGate(store, "read", { path: "x" })).toBeUndefined();
  });

  it("③ store 缺守卫参数（fail-open）返回 undefined", () => {
    const noGuard: OtterInvokeContext = { otterPromptConfig: undefined, identityPrefix: "", otterId: "t" };
    expect(bashGuardGate(noGuard, "bash", { command: "pkill -f otter-buddy" })).toBeUndefined();
    expect(bashGuardGate(undefined, "bash", { command: "pkill -f otter-buddy" })).toBeUndefined();
  });

  it("③ 空命令返回 undefined", () => {
    expect(bashGuardGate(store, "bash", { command: "" })).toBeUndefined();
    expect(bashGuardGate(store, "bash", {})).toBeUndefined();
  });

  it("④ 主仓写命令（main-write）同样显式落痕（与 abort 判定同源）", () => {
    const r = bashGuardGate(store, "bash", {
      command: `git commit --author="修复獭-守卫可观测 <otter-buddy>" -m "feat: x"`,
    });
    expect(r).toBeDefined();
    expect(r!.block).toBe(true);
    expect(r!.reason).toContain("被安全守卫拦截（命令未执行）");
  });
});
