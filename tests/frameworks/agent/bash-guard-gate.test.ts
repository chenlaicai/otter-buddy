/**
 * F20261026gobs（M-2bf6e98c）：bash 守卫门（tool_call 层显式落痕）。
 *
 * 案发现场：#1616 主仓落点 node 探针「静默 exit 0、零输出」（--base nosuchref 必报错路径
 * 也静默），对照实验证明命令未执行到脚本——守卫拦截在 tool_execution_start 走 abort，
 * 信号异步生效与工具执行竞态，被拦命令可能已 spawn 并返回静默成功；abort 后自动重试
 * 又冲淡痕迹。探针据此误判为闸洞（假绿）。
 *
 * 修法：拦截前置到 tool_call 门（与 halt/loop-block 同机制）——被拦命令不执行，
 * SDK 对 block 生成 isError tool result（reason 正文）返回 LLM，即「显式落痕」。
 *
 * delta-r1（检视獭1646 处置）：
 *  - S1 测试环境卷绕：临时 projectRoot + .otter-buddy.pid（CI 无主仓 PID 文件，硬编码
 *    主仓路径曾致 readMainProcessPid null → kill 族门上静默 fail-open → 用例① CI 挂）；
 *    并补「PID 文件缺失时按名 kill 仍拦」生产面用例（kill 族不随 PID 缺失退役）。
 *  - S2 sandboxGuarded 透传：与 abort 链同参同判，沙箱会话 main_write 族退役不再误拦。
 *  - guardOnIntercept：门接管后拦截落 healing（与 abort 兜底链同一钩子）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashGuardGate, type OtterInvokeContext } from "@frameworks/agent/model-runtime-registry";
import { SLEEP_REASON_PREFIX } from "@frameworks/agent/sleep-command-guard";

let projectRoot: string;

function makeStore(extra: Partial<OtterInvokeContext> = {}): OtterInvokeContext {
  return {
    otterPromptConfig: undefined,
    identityPrefix: "",
    otterId: "test-otter",
    guardProjectRoot: projectRoot,
    guardSessionCwd: path.join(projectRoot, "ws"), // 生产等价：工作区在主仓树内（git 写面爬升到 projectRoot）
    ...extra,
  };
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "guard-gate-root-"));
  fs.writeFileSync(path.join(projectRoot, ".otter-buddy.pid"), "4242"); // 卷绕：PID 文件在场
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("bashGuardGate（M-2bf6e98c 拦截显式落痕）", () => {
  it("① 被拦 bash 命令返回 block + 显式「被安全守卫拦截（命令未执行）」reason", () => {
    const r = bashGuardGate(makeStore(), "bash", { command: "pkill -f otter-buddy" });
    expect(r).toBeDefined();
    expect(r!.block).toBe(true);
    expect(r!.reason).toContain("被安全守卫拦截（命令未执行）");
    expect(r!.reason).toContain("otter"); // 理由透传守卫拦截文案
  });

  it("② S1 生产面：PID 文件缺失时按名 kill 仍拦（kill 族不随 PID 缺失静默退役）", () => {
    fs.rmSync(path.join(projectRoot, ".otter-buddy.pid"));
    const r = bashGuardGate(makeStore(), "bash", { command: "pkill -f otter-buddy" });
    expect(r).toBeDefined();
    expect(r!.block).toBe(true);
    expect(r!.reason).toContain("被安全守卫拦截（命令未执行）");
  });

  it("③ S2 沙箱接防透传：sandboxGuarded=true 时写落点求值器退役放行（与 abort 链同判）", () => {
    // 写落点求值器族（文件写落点主仓）——沙箱接防（deny file-write*）时按 G3 枚举表退役
    const cmd = `echo hi > ${projectRoot}/x.txt`;
    expect(bashGuardGate(makeStore({ guardSandboxed: true }), "bash", { command: cmd })).toBeUndefined();
    // sandboxGuarded=false：同一命令拦（判定分歧消除——修复前门不传 sandboxGuarded 恒拦）
    const blocked = bashGuardGate(makeStore({ guardSandboxed: false }), "bash", { command: cmd });
    expect(blocked).toBeDefined();
    expect(blocked!.block).toBe(true);
  });

  it("③b 沙箱接防的保留面：git 写族不随沙箱退役（G3 枚举表保留项，双层同拦）", () => {
    // git commit 写 .git（爬升锚定）属保留面——sandboxGuarded=true 也照拦（降级不降安全）
    const cmd = `git commit --author="修复獭-守卫可观测 <otter-buddy>" -m "feat: x"`;
    expect(bashGuardGate(makeStore({ guardSandboxed: true }), "bash", { command: cmd })).toBeDefined();
    expect(bashGuardGate(makeStore({ guardSandboxed: false }), "bash", { command: cmd })).toBeDefined();
  });

  it("④ 拦截落 healing（guardOnIntercept 与 abort 兜底链同一钩子）", () => {
    const calls: Array<{ command: string; reason: string }> = [];
    const guardOnIntercept = (input: { command: string; reason: string }): void => {
      calls.push(input);
    };
    bashGuardGate(makeStore({ guardOnIntercept }), "bash", { command: "pkill -f otter-buddy" });
    expect(calls.length).toBe(1);
    expect(calls[0].command).toContain("pkill");
    expect(calls[0].reason).toBeTruthy();
  });

  it("⑤ 放行 bash 命令返回 undefined（不误伤，不落 healing）", () => {
    const calls: Array<{ command: string; reason: string }> = [];
    const guardOnIntercept = (input: { command: string; reason: string }): void => {
      calls.push(input);
    };
    expect(bashGuardGate(makeStore({ guardOnIntercept }), "bash", { command: "git log --oneline -5" })).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it("⑤ 非 bash 工具 / 空命令返回 undefined", () => {
    expect(bashGuardGate(makeStore(), "speak", { body: "hi" })).toBeUndefined();
    expect(bashGuardGate(makeStore(), "read", { path: "x" })).toBeUndefined();
    expect(bashGuardGate(makeStore(), "bash", { command: "" })).toBeUndefined();
    expect(bashGuardGate(makeStore(), "bash", {})).toBeUndefined();
  });

  it("⑤ store 缺守卫参数（fail-open）返回 undefined——退化由 abort 兜底链接管", () => {
    const noGuard: OtterInvokeContext = { otterPromptConfig: undefined, identityPrefix: "", otterId: "t" };
    expect(bashGuardGate(noGuard, "bash", { command: "pkill -f otter-buddy" })).toBeUndefined();
    expect(bashGuardGate(undefined, "bash", { command: "pkill -f otter-buddy" })).toBeUndefined();
  });

  it("⑥ kill 字面 PID 指向主 PID（4242）仍拦（保护零削弱，字面等值判定正常）", () => {
    const r = bashGuardGate(makeStore(), "bash", { command: "kill 4242" });
    expect(r).toBeDefined();
    expect(r!.block).toBe(true);
  });

  it("⑦ 带 sleep 标记的拦截 reason 不泄漏内部前缀（stripSleepMarkerIfPresent）", () => {
    const r = bashGuardGate(makeStore(), "bash", { command: "sleep 88888" });
    // sleep 拦截与否随守卫语义演进，但 reason 一旦给出就不应带内部标记前缀
    if (r) {
      expect(r.reason).not.toContain(SLEEP_REASON_PREFIX);
    }
  });
});
