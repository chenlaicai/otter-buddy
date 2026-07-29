import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ToolCallCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  buildToolSignature,
} from "@frameworks/agent/tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "@frameworks/agent/tool-call-circuit-breaker";
import type { Logger } from "@usecases/ports/logger";

function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  return { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides };
}

/** 创建 noop Logger mock */
function mockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => mockLogger(),
  };
}

describe("buildToolSignature", () => {
  it("bash 签名取命令词，参数不计（同一命令不同参数视为相同行为）", () => {
    expect(buildToolSignature("bash", { command: "git commit -m 'a'" })).toBe("bash: git commit");
    expect(buildToolSignature("bash", { command: "git commit -m '完全不同的消息'" })).toBe("bash: git commit");
  });

  it("bash 签名区分子命令（git status 与 git commit 是不同行为）", () => {
    expect(buildToolSignature("bash", { command: "git status" })).toBe("bash: git status");
    expect(buildToolSignature("bash", { command: "git commit -m x" })).toBe("bash: git commit");
  });

  it("bash 复合命令按 shell 操作符切段", () => {
    expect(buildToolSignature("bash", { command: "cd /repo && git add x && git commit -m y" }))
      .toBe("bash: cd | git add | git commit");
    expect(buildToolSignature("bash", { command: "cat a; ls -l | grep x" }))
      .toBe("bash: cat | ls | grep");
  });

  it("bash 签名跳过前导环境变量赋值与路径前缀", () => {
    expect(buildToolSignature("bash", { command: "FOO=bar /usr/bin/git status" })).toBe("bash: git status");
  });

  it("read/write/edit 签名带目标路径", () => {
    expect(buildToolSignature("read", { path: "/a.ts" })).toBe("read: /a.ts");
    expect(buildToolSignature("edit", { filePath: "/b.ts" })).toBe("edit: /b.ts");
    expect(buildToolSignature("write", { path: "/c.ts" })).toBe("write: /c.ts");
  });

  it("无参数或其他工具退化为工具名", () => {
    expect(buildToolSignature("bash")).toBe("bash");
    expect(buildToolSignature("search_memory", { query: "x" })).toBe("search_memory");
  });

  it("bash 穿透包装层与带值 flag（git -C / sudo / time 不塌缩）", () => {
    expect(buildToolSignature("bash", { command: "git -C /repoA status" })).toBe("bash: git status");
    expect(buildToolSignature("bash", { command: "git -C /repoB commit -m x" })).toBe("bash: git commit");
    expect(buildToolSignature("bash", { command: "git -c user.name=x commit -m y" })).toBe("bash: git commit");
    expect(buildToolSignature("bash", { command: "sudo git commit -m x" })).toBe("bash: git commit");
    expect(buildToolSignature("bash", { command: "sudo -E systemctl restart x" })).toBe("bash: systemctl");
    expect(buildToolSignature("bash", { command: "time npm test" })).toBe("bash: npm test");
  });

  it("write 签名含内容指纹：同路径不同内容不算重复，同内容重写算重复", () => {
    const v1 = buildToolSignature("write", { path: "/a.ts", content: "版本一" });
    const v2 = buildToolSignature("write", { path: "/a.ts", content: "版本二" });
    const v1Retry = buildToolSignature("write", { path: "/a.ts", content: "版本一" });
    expect(v1).not.toBe(v2);
    expect(v1).toBe(v1Retry);
    expect(v1).toContain("write: /a.ts#");
  });

  it("edit 签名含编辑内容指纹：同文件不同编辑不算重复，同一编辑重试算重复", () => {
    const e1 = buildToolSignature("edit", { path: "/a.ts", edits: [{ oldText: "x", newText: "y" }] });
    const e2 = buildToolSignature("edit", { path: "/a.ts", edits: [{ oldText: "x", newText: "z" }] });
    const e1Retry = buildToolSignature("edit", { path: "/a.ts", edits: [{ oldText: "x", newText: "y" }] });
    expect(e1).not.toBe(e2);
    expect(e1).toBe(e1Retry);
  });
});

describe("ToolCallCircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows tool calls under threshold (AC-7: normal execution unaffected)", () => {
    const cb = new ToolCallCircuitBreaker(makeConfig(), "otter-1", mockLogger());
    for (let i = 0; i < 19; i++) {
      const result = cb.check(`tool_${i}`);
      expect(result.action).toBe("allow");
      expect(result.blocked).toBe(false);
    }
  });

  it("triggers steer when exceeding maxToolCalls (AC-1: B-2)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxToolCalls: 5, warningThreshold: 3 }),
      "otter-1",
      mockLogger(),
    );

    // Under limit: allow
    for (let i = 0; i < 5; i++) {
      expect(cb.check(`tool_${i}`).action).toBe("allow");
    }

    // Exceed limit: steer
    const result = cb.check("tool_5");
    expect(result.action).toBe("steer");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("6/5");
  });

  it("force terminates after maxToolCalls + 3 (AC-2: B-5)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxToolCalls: 5, warningThreshold: 3 }),
      "otter-1",
      mockLogger(),
    );

    // Fill up to maxToolCalls
    for (let i = 0; i < 5; i++) {
      cb.check(`tool_${i}`);
    }

    // 3 more calls after limit: still steer
    for (let i = 0; i < 3; i++) {
      expect(cb.check("extra_tool").action).toBe("steer");
    }

    // maxToolCalls + 4: force terminate
    const result = cb.check("extra_tool");
    expect(result.action).toBe("terminate");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("Force terminated");
    expect(result.trigger).toBe("tool_call_limit");
  });

  it("triggers steer on consecutive identical signatures (AC-4: B-3)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    // First 3 calls: allow
    expect(cb.check("search_memory").action).toBe("allow");
    expect(cb.check("search_memory").action).toBe("allow");
    expect(cb.check("search_memory").action).toBe("allow");

    // 4th consecutive: steer
    const result = cb.check("search_memory");
    expect(result.action).toBe("steer");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("search_memory");
    expect(result.reason).toContain("4");
  });

  it("bash 连续调用不同命令不算重复（正常工作序列不误报）", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    // 模拟排查现场：bash 连击但每条命令不同
    const commands = [
      "git status",
      "git add x && git commit -m a",
      "git branch --show-current",
      "git checkout -b feat && git commit -m b",
      "cat .husky/commit-msg",
      "ls .githooks",
      "cat package.json",
    ];
    for (const command of commands) {
      expect(cb.check("bash", { command }).action).toBe("allow");
    }
  });

  it("bash 同一命令反复执行才累计（真卡壳抓得住）", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    const retry = () => cb.check("bash", { command: "git commit -m '重试'" });
    expect(retry().action).toBe("allow");
    expect(retry().action).toBe("allow");
    expect(retry().action).toBe("allow");

    const result = retry();
    expect(result.action).toBe("steer");
    expect(result.reason).toContain("bash: git commit");
  });

  it("resets consecutive count when tool changes", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    expect(cb.check("tool_a").action).toBe("allow");
    expect(cb.check("tool_a").action).toBe("allow");
    expect(cb.check("tool_a").action).toBe("allow");

    // Different tool resets counter
    expect(cb.check("tool_b").action).toBe("allow");

    // Can call tool_a again without triggering
    expect(cb.check("tool_a").action).toBe("allow");
  });
});

describe("ToolCallCircuitBreaker — 两档制与签名判据", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("steer 后行为纠正（出现 allow）即解除警告状态，不升级 terminate", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 2, maxRepeatAfterWarning: 2, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    // 3 次相同 → 第 3 次 steer（strike 1）
    cb.check("bash", { command: "git commit -m x" });
    cb.check("bash", { command: "git commit -m x" });
    expect(cb.check("bash", { command: "git commit -m x" }).action).toBe("steer");

    // 纠正：换成其他命令 → allow 清零 strikes
    expect(cb.check("bash", { command: "git status" }).action).toBe("allow");

    // 再次进入相同循环：重新从 steer 起步，而非直接 terminate
    cb.check("bash", { command: "git commit -m x" });
    cb.check("bash", { command: "git commit -m x" });
    expect(cb.check("bash", { command: "git commit -m x" }).action).toBe("steer");
  });

  it("steer 警告后继续触发满 maxRepeatAfterWarning 次则 terminate（两档制）", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 2, maxRepeatAfterWarning: 3, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    const stuck = () => cb.check("bash", { command: "git commit -m x" });
    stuck();
    stuck();
    // 第 3 次起 steer（strike 1,2,3）
    expect(stuck().action).toBe("steer");
    expect(stuck().action).toBe("steer");
    expect(stuck().action).toBe("steer");

    // 第 4 次 steer（strike 4 > 3）→ terminate
    const result = stuck();
    expect(result.action).toBe("terminate");
    expect(result.trigger).toBe("ignored_steer");
    expect(result.reason).toContain("steers ignored");
  });

  it("同一文件的不同编辑连续执行不算重复（重构场景不误杀）", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    for (let i = 0; i < 7; i++) {
      const result = cb.check("edit", { path: "/a.ts", edits: [{ oldText: `old_${i}`, newText: `new_${i}` }] });
      expect(result.action).toBe("allow");
    }
  });

  it("同一编辑反复重试才累计（edit 卡壳抓得住）", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    const retry = () => cb.check("edit", { path: "/a.ts", edits: [{ oldText: "x", newText: "y" }] });
    expect(retry().action).toBe("allow");
    expect(retry().action).toBe("allow");
    expect(retry().action).toBe("allow");

    const result = retry();
    expect(result.action).toBe("steer");
    expect(result.reason).toContain("edit: /a.ts#");
  });

  it("滑窗 steer 被持续无视也会升级为 terminate（全局 strike 覆盖跨规则路径）", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({
        slidingWindowSize: 6,
        slidingWindowRepeat: 3,
        maxRepeatAfterWarning: 2,
        maxToolCalls: 100,
        warningThreshold: 100,
      }),
      "otter-1",
      mockLogger(),
    );

    // A-B-C 交替 18 次触发滑窗 steer（strike 1），继续无视 → strike 2、3
    const tools = ["A", "B", "C"];
    let lastAction = "";
    for (let i = 0; i < 20; i++) {
      lastAction = cb.check(tools[i % 3]).action;
    }
    expect(lastAction).toBe("terminate");
  });

  it("strike 跨规则累计：连续规则 steer 后接调用上限 steer，满额 terminate", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 1, maxRepeatAfterWarning: 3, maxToolCalls: 4, warningThreshold: 100 }),
      "otter-1",
      mockLogger(),
    );

    const stuck = () => cb.check("bash", { command: "git commit -m x" });
    stuck(); // allow（call 1）
    expect(stuck().action).toBe("steer"); // strike 1
    expect(stuck().action).toBe("steer"); // strike 2
    expect(stuck().action).toBe("steer"); // strike 3

    // 换命令避开连续规则，但撞 maxToolCalls=4 的 limit-steer → strike 4 > 3
    const result = cb.check("bash", { command: "git status" });
    expect(result.action).toBe("terminate");
    expect(result.trigger).toBe("ignored_steer");
  });

  it("detects sliding window cross-tool alternating loop (AC-8: B-3b)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({
        slidingWindowSize: 6,
        slidingWindowRepeat: 3,
        maxToolCalls: 100,
        warningThreshold: 100,
      }),
      "otter-1",
      mockLogger(),
    );

    // Pattern A-B-C repeated 3 times (18 calls, window=6, repeat=3)
    // Each window of 6 sorted = "A,B,C,A,B,C" → same pattern
    for (let i = 0; i < 18; i++) {
      const tools = ["A", "B", "C"];
      const result = cb.check(tools[i % 3]);
      if (i < 17) {
        expect(result.action).toBe("allow");
      }
    }

    // 18th call should trigger sliding window detection
    const result = cb.check("A");
    // The sliding window should have detected the pattern by now
    expect(result.action).toBe("steer");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("Repeating tool call pattern");
  });

  it("does not trigger sliding window for non-repeating patterns", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({
        slidingWindowSize: 6,
        slidingWindowRepeat: 3,
        maxToolCalls: 100,
        warningThreshold: 100,
      }),
      "otter-1",
      mockLogger(),
    );

    // Different tools each time: no repeating pattern
    for (let i = 0; i < 18; i++) {
      const result = cb.check(`unique_tool_${i}`);
      expect(result.action).toBe("allow");
    }
  });

  it("force terminates on execution timeout (AC-3: B-4)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxExecutionTimeMs: 5000, maxToolCalls: 100 }),
      "otter-1",
      mockLogger(),
    );

    expect(cb.check("tool_1").action).toBe("allow");

    // Advance time past limit
    vi.advanceTimersByTime(6000);

    const result = cb.check("tool_2");
    expect(result.action).toBe("terminate");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("timeout");
  });

  it("records call history as signatures (B-6)", () => {
    const cb = new ToolCallCircuitBreaker(makeConfig(), "otter-1", mockLogger());

    cb.check("bash", { command: "git status" });
    cb.check("read", { path: "/a.ts" });
    cb.check("tool_a");

    expect(cb.getCallHistory()).toEqual(["bash: git status", "read: /a.ts", "tool_a"]);
  });

  it("returns metadata with circuit reason (B-7)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxToolCalls: 3, warningThreshold: 2 }),
      "otter-1",
      mockLogger(),
    );

    cb.check("tool_1");
    cb.check("tool_2");
    cb.check("tool_3");

    // Exceed limit
    cb.check("tool_4");

    const meta = cb.getMetadata();
    expect(meta.totalCalls).toBe(4);
    expect(meta.circuitReason).toContain("4/3");
  });

  it("metadata has no circuitReason when under limit", () => {
    const cb = new ToolCallCircuitBreaker(makeConfig(), "otter-1", mockLogger());

    cb.check("tool_1");

    const meta = cb.getMetadata();
    expect(meta.totalCalls).toBe(1);
    expect(meta.circuitReason).toBeUndefined();
  });

  it("getCallHistory returns a copy, not a reference", () => {
    const cb = new ToolCallCircuitBreaker(makeConfig(), "otter-1", mockLogger());
    cb.check("tool_a");

    const history = cb.getCallHistory();
    history.push("injected");

    expect(cb.getCallHistory()).toEqual(["tool_a"]);
  });
});
