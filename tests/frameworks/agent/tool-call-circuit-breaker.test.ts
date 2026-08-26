import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ToolCallCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  buildToolSignature,
} from "@frameworks/agent/tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "@frameworks/agent/tool-call-circuit-breaker";
import { createTestLogger } from "../../helpers/logger";

function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  return { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides };
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

  it("speak 签名含 body 内容指纹：不同内容不算重复，同一内容重试算重复（F20260820d338）", () => {
    const s1 = buildToolSignature("speak", { body: "## 进度汇报\n已完成 A" });
    const s2 = buildToolSignature("speak", { body: "## 进度汇报\n已完成 B" });
    const s1Retry = buildToolSignature("speak", { body: "## 进度汇报\n已完成 A" });
    expect(s1).not.toBe(s2);
    expect(s1).toBe(s1Retry);
    expect(s1).toContain("speak#");
  });

  it("speak 无 body 时退化为工具名", () => {
    expect(buildToolSignature("speak")).toBe("speak");
    expect(buildToolSignature("speak", {})).toBe("speak");
  });

  it("dissolve_otter 签名含 otterId——不同 otter 不算重复", () => {
    expect(buildToolSignature("dissolve_otter", { otterId: "otter-1" })).toBe("dissolve_otter: otter-1");
    expect(buildToolSignature("dissolve_otter", { otterId: "otter-2" })).toBe("dissolve_otter: otter-2");
    expect(buildToolSignature("dissolve_otter", { otterId: "otter-1" })).toBe("dissolve_otter: otter-1");
  });

  it("dissolve_otter 无 otterId 时退化为工具名", () => {
    expect(buildToolSignature("dissolve_otter")).toBe("dissolve_otter");
    expect(buildToolSignature("dissolve_otter", {})).toBe("dissolve_otter");
  });

  it("restart_otter 签名含 otterId——不同 otter 不算重复", () => {
    expect(buildToolSignature("restart_otter", { otterId: "otter-A" })).toBe("restart_otter: otter-A");
    expect(buildToolSignature("restart_otter", { otterId: "otter-B" })).toBe("restart_otter: otter-B");
  });

  it("create_otter 签名含 name——不同名字不算重复", () => {
    expect(buildToolSignature("create_otter", { name: "小獭甲" })).toBe("create_otter: 小獭甲");
    expect(buildToolSignature("create_otter", { name: "小獭乙" })).toBe("create_otter: 小獭乙");
    expect(buildToolSignature("create_otter", { name: "小獭甲" })).toBe("create_otter: 小獭甲");
  });

  it("create_otter 无 name 时退化为工具名", () => {
    expect(buildToolSignature("create_otter")).toBe("create_otter");
    expect(buildToolSignature("create_otter", {})).toBe("create_otter");
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
    const cb = new ToolCallCircuitBreaker(makeConfig(), "otter-1", createTestLogger());
    for (let i = 0; i < 19; i++) {
      const result = cb.check(`tool_${i}`);
      expect(result.action).toBe("allow");
      expect(result.blocked).toBe(false);
    }
  });

  it("triggers steer on consecutive identical signatures (AC-4: B-3)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3 }),
      "otter-1",
      createTestLogger(),
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
      makeConfig({ maxConsecutiveIdentical: 3 }),
      "otter-1",
      createTestLogger(),
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
      makeConfig({ maxConsecutiveIdentical: 3 }),
      "otter-1",
      createTestLogger(),
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
      makeConfig({ maxConsecutiveIdentical: 3 }),
      "otter-1",
      createTestLogger(),
    );

    expect(cb.check("tool_a").action).toBe("allow");
    expect(cb.check("tool_a").action).toBe("allow");
    expect(cb.check("tool_a").action).toBe("allow");

    // Different tool resets counter
    expect(cb.check("tool_b").action).toBe("allow");

    // Can call tool_a again without triggering
    expect(cb.check("tool_a").action).toBe("allow");
  });

  it("批量解散 8 只 otter 不误报重复——每只 otterId 不同，签名各异 (#464)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig(),
      "big-otter",
      createTestLogger(),
    );

    // 模拟大獭批量解散 8 只小獭
    for (let i = 1; i <= 8; i++) {
      const result = cb.check("dissolve_otter", { otterId: `small-otter-${i}` });
      expect(result.action).toBe("allow");
    }
  });

  it("真正重复解散同一只 otter 仍能检测 (#464 边界)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3 }),
      "big-otter",
      createTestLogger(),
    );

    const retry = () => cb.check("dissolve_otter", { otterId: "small-otter-1" });
    expect(retry().action).toBe("allow");
    expect(retry().action).toBe("allow");
    expect(retry().action).toBe("allow");
    // 第 4 次重复解散同一只 → steer
    expect(retry().action).toBe("steer");
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
      makeConfig({ maxConsecutiveIdentical: 2, maxRepeatAfterWarning: 2 }),
      "otter-1",
      createTestLogger(),
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
      makeConfig({ maxConsecutiveIdentical: 2, maxRepeatAfterWarning: 3 }),
      "otter-1",
      createTestLogger(),
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
      makeConfig({ maxConsecutiveIdentical: 3 }),
      "otter-1",
      createTestLogger(),
    );

    for (let i = 0; i < 7; i++) {
      const result = cb.check("edit", { path: "/a.ts", edits: [{ oldText: `old_${i}`, newText: `new_${i}` }] });
      expect(result.action).toBe("allow");
    }
  });

  it("同一编辑反复重试才累计（edit 卡壳抓得住）", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({ maxConsecutiveIdentical: 3 }),
      "otter-1",
      createTestLogger(),
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
      }),
      "otter-1",
      createTestLogger(),
    );

    // A-B-C 交替 18 次触发滑窗 steer（strike 1），继续无视 → strike 2、3
    const tools = ["A", "B", "C"];
    let lastAction = "";
    for (let i = 0; i < 20; i++) {
      lastAction = cb.check(tools[i % 3]).action;
    }
    expect(lastAction).toBe("terminate");
  });

  it("detects sliding window cross-tool alternating loop (AC-8: B-3b)", () => {
    const cb = new ToolCallCircuitBreaker(
      makeConfig({
        slidingWindowSize: 6,
        slidingWindowRepeat: 3,
      }),
      "otter-1",
      createTestLogger(),
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
      }),
      "otter-1",
      createTestLogger(),
    );

    // Different tools each time: no repeating pattern
    for (let i = 0; i < 18; i++) {
      const result = cb.check(`unique_tool_${i}`);
      expect(result.action).toBe("allow");
    }
  });

  it("records call history as signatures (B-6)", () => {
    const cb = new ToolCallCircuitBreaker(makeConfig(), "otter-1", createTestLogger());

    cb.check("bash", { command: "git status" });
    cb.check("read", { path: "/a.ts" });
    cb.check("tool_a");

    expect(cb.getCallHistory()).toEqual(["bash: git status", "read: /a.ts", "tool_a"]);
  });

  it("metadata has no circuitReason when under limit", () => {
    const cb = new ToolCallCircuitBreaker(makeConfig(), "otter-1", createTestLogger());

    cb.check("tool_1");

    const meta = cb.getMetadata();
    expect(meta.totalCalls).toBe(1);
    expect(meta.circuitReason).toBeUndefined();
  });

  it("getCallHistory returns a copy, not a reference", () => {
    const cb = new ToolCallCircuitBreaker(makeConfig(), "otter-1", createTestLogger());
    cb.check("tool_a");

    const history = cb.getCallHistory();
    history.push("injected");

    expect(cb.getCallHistory()).toEqual(["tool_a"]);
  });
});
