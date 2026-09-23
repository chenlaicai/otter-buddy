/**
 * F20260923hsyn：压缩死亡链修复——预算裁剪 + 兜底超时 + 失败熔断 + 守卫工作区豁免。
 *
 * 9/23 事故链（日志实证）：
 * - 合成 prompt 从不裁剪 → ctx 超「模型窗口 − prompt 开销」后 kimi-256k 必 400（362k-956k chars vs 262k 窗口）
 * - 60s 固定超时误判大 session 正常合成（实测最大 146s）→ 白跑 + 降级双重损失
 * - 失败后 continuing with current session → ctx 继续涨 → 再触发再失败（死循环）
 * - bash 守卫绝对路径豁免不认主仓树下 data/workspaces/（合法工作区被拦）
 */

import { describe, it, expect } from "vitest";
import {
  buildNarrativeSynthesisPrompt,
  trimMessagesToBudget,
  SYNTHESIS_OUTPUT_RESERVE_TOKENS,
  SYNTHESIS_FIXED_OVERHEAD_TOKENS,
  NARRATIVE_SYNTHESIS_TIMEOUT_MS,
} from "@frameworks/agent/narrative-synthesis-engine";
import { HandoffState } from "@interface-adapters/agent-runtime/handoff-support";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

function makeMessages(count: number, charsEach: number) {
  // 注：serializeConversation 长度按 UTF-16 code unit 计，中文 1 字 = 1 unit；
  // 但 token 估算 chars/4 的口径下中文更接近 chars/1.5——测试用 ASCII 避免口径干扰
  const text = "x".repeat(charsEach);
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `msg-${i}-${text}` }],
  }));
}

describe("trimMessagesToBudget（F20260923hsyn 预算裁剪：丢最老保最近）", () => {
  it("历史在预算内 → 不裁剪，droppedCount=0", () => {
    const msgs = makeMessages(4, 100);
    const r = trimMessagesToBudget(msgs, 262_144);
    expect(r.droppedCount).toBe(0);
    expect(r.messages).toHaveLength(4);
  });

  it("历史超预算 → 从最老端整条丢弃直到进预算", () => {
    // kimi-256k 窗口：预算 chars = (262144 - 8192 - 10000) * 4 ≈ 975k
    // 造 10 条 × 200k chars = 2M chars 历史 → 必须丢到 ≤975k
    const msgs = makeMessages(10, 200_000);
    const r = trimMessagesToBudget(msgs, 262_144);
    expect(r.droppedCount).toBeGreaterThan(0);
    // 保留的是最近的（最后一条一定在）
    expect(r.messages[r.messages.length - 1]).toEqual(msgs[msgs.length - 1]);
    // 丢的是最老的（第一条不在）
    expect(r.messages[0]).not.toEqual(msgs[0]);
  });

  it("窗口过小（连固定段都装不下）→ 保底空历史（机械供料仍在，合成仍可产出）", () => {
    const msgs = makeMessages(3, 100);
    const r = trimMessagesToBudget(msgs, SYNTHESIS_OUTPUT_RESERVE_TOKENS + SYNTHESIS_FIXED_OVERHEAD_TOKENS - 1);
    expect(r.messages).toHaveLength(0);
    expect(r.droppedCount).toBe(3);
  });

  it("1M 窗口大 session（956k chars 实证案例）→ 不裁剪", () => {
    // 今早 kimi 1M 案例：prompt 956k chars < (1048576-8192-10000)*4 ≈ 4.1M → 不该裁
    const msgs = makeMessages(5, 190_000);
    const r = trimMessagesToBudget(msgs, 1_048_576);
    expect(r.droppedCount).toBe(0);
  });

  it("同历史在 kimi-256k（262k 窗口）下必须裁剪（死亡链实证场景）", () => {
    // 262k 窗口预算 ≈ (262144-8192-10000)*4 ≈ 975k chars；造 1.5M chars 历史必裁
    const msgs = makeMessages(6, 250_000);
    const r = trimMessagesToBudget(msgs, 262_144);
    expect(r.droppedCount).toBeGreaterThan(0);
    expect(r.messages[r.messages.length - 1]).toEqual(msgs[msgs.length - 1]);
  });
});

describe("buildNarrativeSynthesisPrompt 集成裁剪（F20260923hsyn）", () => {
  const base = {
    otterName: "测试獭",
    oldSessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    trigger: "水位" as const,
    lineage: "- gen1 a1b2c3d4: 初代",
  };

  it("传 contextWindowTokens 且历史超预算 → prompt 含裁剪标注且历史段进预算", () => {
    const msgs = makeMessages(10, 200_000);
    const prompt = buildNarrativeSynthesisPrompt({
      ...base,
      messagesToSummarize: msgs,
      contextWindowTokens: 262_144,
    });
    expect(prompt).toContain("预算裁剪：已丢弃最老");
    // 最近消息原文必须在
    expect(prompt).toContain("msg-9-");
    // 最老消息被丢
    expect(prompt).not.toContain("msg-0-");
    // 总 prompt 长度必须小于窗口（留 prompt 其余段 + 输出余量）
    expect(prompt.length).toBeLessThan(262_144 * 4);
  });

  it("不传 contextWindowTokens → 不裁剪（向后兼容）", () => {
    const msgs = makeMessages(3, 100);
    const prompt = buildNarrativeSynthesisPrompt({ ...base, messagesToSummarize: msgs });
    expect(prompt).not.toContain("预算裁剪");
    expect(prompt).toContain("msg-0-");
  });

  it("历史在预算内 → 无裁剪标注", () => {
    const msgs = makeMessages(3, 100);
    const prompt = buildNarrativeSynthesisPrompt({
      ...base,
      messagesToSummarize: msgs,
      contextWindowTokens: 262_144,
    });
    expect(prompt).not.toContain("预算裁剪");
  });
});

describe("NARRATIVE_SYNTHESIS_TIMEOUT_MS 兜底语义（F20260923hsyn）", () => {
  it("超时 = 300s 兜底异常（非质量闸门——实证最大真实案例 146s）", () => {
    expect(NARRATIVE_SYNTHESIS_TIMEOUT_MS).toBe(300_000);
  });
});

describe("HandoffState 失败熔断（F20260923hsyn 死循环防线）", () => {
  it("连续失败计数累加，成功后清零", () => {
    const s = new HandoffState();
    expect(s.getConsecutiveFailures("o1")).toBe(0);
    expect(s.recordHandoffFailure("o1")).toBe(1);
    expect(s.recordHandoffFailure("o1")).toBe(2);
    expect(s.getConsecutiveFailures("o1")).toBe(2);
    s.clearHandoffFailures("o1");
    expect(s.getConsecutiveFailures("o1")).toBe(0);
  });

  it("不同獭的失败计数隔离", () => {
    const s = new HandoffState();
    s.recordHandoffFailure("o1");
    s.recordHandoffFailure("o1");
    s.recordHandoffFailure("o2");
    expect(s.getConsecutiveFailures("o1")).toBe(2);
    expect(s.getConsecutiveFailures("o2")).toBe(1);
  });
});

describe("bash 守卫工作区豁免（F20260923hsyn，9/23 排查实证缺口）", () => {
  const mainPid = 42877;
  const projectRoot = "/repo";

  it("重定向落主仓树下 data/workspaces/（合法工作区）→ 放行", () => {
    const cmd = `tail -c 8000000 /repo/data/logs/app.log > /repo/data/workspaces/abc-123/morning.log`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });

  it("重定向落主仓树下其他 data 子目录（logs/metrics）→ 仍拦截", () => {
    const cmd = `echo x > /repo/data/logs/injected.log`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).not.toBeNull();
  });

  it("重定向落主仓 src/ → 仍拦截", () => {
    const cmd = `echo x > /repo/src/foo.ts`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).not.toBeNull();
  });

  it("重定向落主仓外绝对路径 → 放行（既有豁免不回退）", () => {
    const cmd = `echo x > /tmp/y.log`;
    expect(checkBashCommandSafety(cmd, mainPid, undefined, { projectRoot })).toBeNull();
  });
});
