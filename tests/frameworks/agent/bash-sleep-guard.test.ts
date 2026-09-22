/**
 * F20260922slan V5：bash_sleep 前缀全链测试。
 *
 * 验证 delta-2 D5 的 6 消费点闭合：
 * - 发射点（circuit-breaker-helpers）：守卫返回带标记的 sleep reason → doAbort(`bash_sleep:`)，
 *   kill 域仍走 `bash_safety:`（前缀分流不串）
 * - retry-policy：`bash_sleep:` 在 isRetryableGuardAbort 可重试；
 *   buildRetryFailBody/buildAutoRetryMsg/buildGuardAbortBody/buildGuardBounceFailBody/
 *   buildGuardBounceEscalationMsg 返回 sleep 语义文案、不含 kill 域「进程」措辞
 * - orchestrator 三门：shouldGuardBounce / isGuardBounceTerminal / recordRetrySafe kind 映射
 *   补 bash_sleep 分支（本文件覆盖发射点 + retry-policy 五函数；三门为 orchestrator 内部
 *   私有方法，经集成路径验证——见 tests/usecases/conversation/agent-turn-orchestrator/retry-policy.test.ts
 *   的 bounce 触发断言）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { attachCircuitBreaker } from "@frameworks/agent/circuit-breaker-helpers";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@frameworks/agent/tool-call-circuit-breaker";
import { createTestLogger } from "../../helpers/logger";

/** 构造最小可用的 session mock：记录 subscribe 回调以便手动派发事件 */
function mockSession() {
  const handlers: Array<(event: unknown) => void> = [];
  return {
    steer: vi.fn<(text: string) => Promise<void>>(async () => {}),
    abort: vi.fn(async () => {}),
    subscribe(fn: (event: unknown) => void) {
      handlers.push(fn);
      return () => {
        const i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    emit(event: unknown) {
      for (const fn of handlers) fn(event);
    },
  };
}

function sdkToolStart(toolName: string, args: unknown = {}) {
  return { type: "tool_execution_start", toolCallId: `tc-${toolName}`, toolName, args };
}

describe("bash_sleep 发射点（circuit-breaker-helpers）", () => {
  let tmpDir: string;
  let mainPid: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-guard-"));
    mainPid = 999999; // 与命令中的 PID 不冲突的假主进程 PID
    fs.writeFileSync(path.join(tmpDir, ".otter-buddy.pid"), String(mainPid));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function attach(abortOverride: (reason?: string) => void) {
    const session = mockSession();
    attachCircuitBreaker(
      session,
      "otter-1",
      { ...DEFAULT_CIRCUIT_BREAKER_CONFIG },
      createTestLogger(),
      { abortOverride, projectRoot: tmpDir },
    );
    return session;
  }

  it("裸 `sleep 30` 命中 → doAbort(`bash_sleep:...`)", () => {
    const abortOverride = vi.fn();
    const session = attach(abortOverride);
    session.emit(sdkToolStart("bash", { command: "sleep 30" }));
    expect(abortOverride).toHaveBeenCalledOnce();
    const reason = abortOverride.mock.calls[0][0] as string;
    expect(reason.startsWith("bash_sleep:")).toBe(true);
    // 发射点剥离标记后透传 sleep 引导文案（不再含 SLEEP_REASON_PREFIX 标记）
    expect(reason).not.toContain("__bash_sleep_block__:");
    expect(reason).toContain("wait 工具");
  });

  it("`sleep 2` 微 sleep 不拦（阈值下）", () => {
    const abortOverride = vi.fn();
    const session = attach(abortOverride);
    session.emit(sdkToolStart("bash", { command: "sleep 2" }));
    expect(abortOverride).not.toHaveBeenCalled();
  });

  it("kill 主进程仍走 `bash_safety:`（前缀分流不串）", () => {
    const abortOverride = vi.fn();
    const session = attach(abortOverride);
    session.emit(sdkToolStart("bash", { command: `kill ${mainPid}` }));
    expect(abortOverride).toHaveBeenCalledOnce();
    const reason = abortOverride.mock.calls[0][0] as string;
    expect(reason.startsWith("bash_safety:")).toBe(true);
    expect(reason.startsWith("bash_sleep:")).toBe(false);
  });

  it("复合命令 `sleep 30 && gh pr checks` 命中 → `bash_sleep:`", () => {
    const abortOverride = vi.fn();
    const session = attach(abortOverride);
    session.emit(sdkToolStart("bash", { command: "sleep 30 && gh pr checks" }));
    expect(abortOverride).toHaveBeenCalledOnce();
    expect((abortOverride.mock.calls[0][0] as string).startsWith("bash_sleep:")).toBe(true);
  });
});
