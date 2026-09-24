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
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import {
  buildNarrativeSynthesisPrompt,
  trimMessagesToBudget,
  synthesisFullBudgetChars,
  TRIM_NOTE_RESERVE_CHARS,
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

describe("synthesisFullBudgetChars（F20260924swin 夹逼定标：trim 与预检共享的唯一预算对象）", () => {
  it("262K 窗口 → 181,688 chars（最小失败 227,110 × 0.8）", () => {
    expect(synthesisFullBudgetChars(262_144)).toBe(181_688);
  });
  it("跨窗口按占比缩放：1M → 726,752（保守外推，安全方向）", () => {
    expect(synthesisFullBudgetChars(1_048_576)).toBe(726_752);
  });
  it("trim 与预检同一对象：trim 裁满的产物天然过预检（全文口径，不自拦）", () => {
    // trim 内部预算 = 全文预算 − 固定段实测 − trim-note 预留 → trim 后全文 ≤ 全文预算 = 预检阈值 → 放行
    const msgs = makeMessages(10, 50_000);
    const r = trimMessagesToBudget(msgs, 262_144, 5_000);
    expect(r.historyBudgetChars).toBe(synthesisFullBudgetChars(262_144) - 5_000 - TRIM_NOTE_RESERVE_CHARS);
    expect(r.droppedCount).toBeGreaterThan(0);
  });
});

describe("trimMessagesToBudget（F20260923hsyn 预算裁剪：丢最老保最近）", () => {
  it("历史在预算内 → 不裁剪，droppedCount=0", () => {
    const msgs = makeMessages(4, 100);
    const r = trimMessagesToBudget(msgs, 262_144, 1_200);
    expect(r.droppedCount).toBe(0);
    expect(r.messages).toHaveLength(4);
  });

  it("历史超预算 → 从最老端整条丢弃直到进预算", () => {
    // F20260924swin 口径：历史预算 = 181,688 − 1,200（固定段） − 200（trim-note 预留）≈ 180k
    // 造 10 条 × 50k = 500k chars（单条 < 预算不会被全丢）→ 丢到 ≤180k
    const msgs = makeMessages(10, 50_000);
    const r = trimMessagesToBudget(msgs, 262_144, 1_200);
    expect(r.droppedCount).toBeGreaterThan(0);
    // 保留的是最近的（最后一条一定在）
    expect(r.messages[r.messages.length - 1]).toEqual(msgs[msgs.length - 1]);
    // 丢的是最老的（第一条不在）
    expect(r.messages[0]).not.toEqual(msgs[0]);
  });

  it("窗口过小（连固定段都装不下）→ 保底空历史（机械供料仍在，合成仍可产出）", () => {
    const msgs = makeMessages(3, 100);
    // 固定段实测 ≥ 全文预算 → 历史预算 ≤ 0 → 保底分支
    const r = trimMessagesToBudget(msgs, 262_144, synthesisFullBudgetChars(262_144) + 1);
    expect(r.messages).toHaveLength(0);
    expect(r.droppedCount).toBe(3);
  });

  it("1M 窗口大 session（956k chars 实证案例量级）→ 不裁剪", () => {
    // 新口径 1M → 全文预算 726,752；造 700k chars（< 预算）不该裁
    const msgs = makeMessages(5, 140_000);
    const r = trimMessagesToBudget(msgs, 1_048_576, 1_200);
    expect(r.droppedCount).toBe(0);
  });

  it("同历史在 kimi-256k（262k 窗口）下必须裁剪（死亡链实证场景）", () => {
    // 新口径 262k → 历史预算 ≈ 180k；造 360k chars 必裁（单条 60k < 预算不会全丢）
    const msgs = makeMessages(6, 60_000);
    const r = trimMessagesToBudget(msgs, 262_144, 1_200);
    expect(r.droppedCount).toBeGreaterThan(0);
    expect(r.messages[r.messages.length - 1]).toEqual(msgs[msgs.length - 1]);
  });
});

describe("buildNarrativeSynthesisPrompt 集成裁剪（F20260923hsyn + F20260924swin 口径修正）", () => {
  const base = {
    otterName: "测试獭",
    oldSessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    trigger: "水位" as const,
    lineage: "- gen1 a1b2c3d4: 初代",
  };

  it("传 contextWindowTokens 且历史超预算 → prompt 含裁剪标注且历史段进预算", () => {
    // F20260924swin 口径：历史段预算 = 全文预算(181,688) − 固定段实测。
    // 造 10 条 × 5 万 = 50 万 chars（单条 < 预算，不会被全丢——旧版 10×20 万的造法在新口径下全丢合法）
    const msgs = makeMessages(10, 50_000);
    const prompt = buildNarrativeSynthesisPrompt({
      ...base,
      messagesToSummarize: msgs,
      contextWindowTokens: 262_144,
    });
    expect(prompt).toContain("<trim-note>");
    expect(prompt).toContain("预算裁剪：已丢弃最老");
    // 最近消息原文必须在（丢最老保最近）
    expect(prompt).toContain("msg-9-");
    // 最老消息被丢
    expect(prompt).not.toContain("msg-0-");
    // 总 prompt 长度 ≤ 全文预算 + 余量（固定段 ~1.2K + 标注段）
    expect(prompt.length).toBeLessThanOrEqual(synthesisFullBudgetChars(262_144)); // delta 复核严重4：严格 ≤ 预算，零余量（trim-note 已计入预留）
  });

  it("F20260924swin 动机案例回归：22.2 万 chars 合成数据（9/24 实证 227,110 同档）→ dropped ≥ 1 且全文 ≤ 预算且预检放行（单分支）", () => {
    // 9/24 搭档重启大獭实测：promptLength 227,110 chars → 400（trim 未触发——旧预算 731,856）。
    //  新口径：227,110 > 181,688 必裁；「dropped=0 且放行」分支恰是公式写错时的 bug 行为，断言不得兼容。
    //  （delta 复核建议3 改名：造数为合成数据同量级，非 jsonl 真实切片——名实相符）
    const msgs = makeMessages(6, 37_000); // ≈22.2 万 chars + 固定段 ≈ 超预算
    let trimLog: { inputChars: number; measuredFixedChars: number; historyBudgetChars: number; droppedCount: number; promptChars: number } | undefined;
    const prompt = buildNarrativeSynthesisPrompt({
      ...base,
      messagesToSummarize: msgs,
      contextWindowTokens: 262_144,
      onTrim: (r) => { trimLog = r; },
    });
    expect(trimLog).toBeDefined();
    expect(trimLog!.droppedCount).toBeGreaterThanOrEqual(1); // 必裁
    expect(trimLog!.measuredFixedChars).toBeGreaterThan(0); // 固定段实测生效
    expect(prompt.length).toBeLessThanOrEqual(synthesisFullBudgetChars(262_144)); // delta 复核严重4：严格 ≤ 全文预算，零余量
    // 预检同一预算函数：prompt ≤ 预算 → 放行（不自拦）
    expect(prompt.length).toBeLessThanOrEqual(synthesisFullBudgetChars(262_144));
    // trim 观测日志字段齐全（9/24 观测缺口补上的锚）
    expect(trimLog!.inputChars).toBeGreaterThan(trimLog!.historyBudgetChars);
    expect(trimLog!.promptChars).toBe(prompt.length);
  });

  it("delta 复核建议1 处方a：贴顶真边界——kept 历史恰占满历史预算，终稿仍严格 ≤ 全文预算", () => {
    // 真边界构造（检视獭-岚 复核指出旧用例距边界 ≈30k，修复前后同过、不区分 bug——本用例替代它）：
    //  两跑法——第一跑读 onTrim 实测 historyBudgetChars（fixed 依赖模板，数学构造不可控）；
    //  第二跑造「最后一条序列化长度恰 = 历史预算（贴顶）+ 前置大消息触发裁剪」数据。
    //  真区分：修复前（trim-note 不进预算）此数据下 final = 全文预算 + trim-note > 预算 → 必红；
    //  防静默重开：TRIM_NOTE_RESERVE_CHARS 未来下调到 < trim-note 实长 → final 溢出 → 本用例必红。
    const mk = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
    // 第一跑：探针读实测历史预算
    let historyBudget = 0;
    buildNarrativeSynthesisPrompt({
      ...base,
      messagesToSummarize: [mk("p".repeat(1_000)), mk("q".repeat(1_000))],
      contextWindowTokens: 262_144,
      onTrim: (r) => { historyBudget = r.historyBudgetChars; },
    });
    expect(historyBudget).toBeGreaterThan(0);
    // 第二跑：贴顶消息序列化长度恰 = 历史预算（单条包装开销实测扣除）
    const wrapperChars = serializeConversation([mk("x".repeat(100))] as never).length - 100;
    const topping = mk("x".repeat(historyBudget - wrapperChars));
    const msgs = [mk("y".repeat(historyBudget * 2)), topping]; // 前置大消息触发裁剪，只剩贴顶消息
    let trimLog: { droppedCount: number; promptChars: number } | undefined;
    const prompt = buildNarrativeSynthesisPrompt({
      ...base,
      messagesToSummarize: msgs,
      contextWindowTokens: 262_144,
      onTrim: (r) => { trimLog = r; },
    });
    expect(trimLog!.droppedCount).toBe(1); // 恰丢前置大消息；贴顶消息 = 边界（不丢，`>` 严格才丢）
    expect(prompt).toContain("<trim-note>");
    expect(prompt.length).toBeLessThanOrEqual(synthesisFullBudgetChars(262_144)); // 真边界严格闭合，零余量
    expect(trimLog!.promptChars).toBe(prompt.length);
  });

  it("F20260924swin 不误裁边界：15 万 chars（< 预算 181,688）→ dropped=0", () => {
    const msgs = makeMessages(5, 28_000); // ≈14 万 chars
    let trimLog: { droppedCount: number } | undefined;
    buildNarrativeSynthesisPrompt({
      ...base,
      messagesToSummarize: msgs,
      contextWindowTokens: 262_144,
      onTrim: (r) => { trimLog = r; },
    });
    expect(trimLog!.droppedCount).toBe(0);
  });

  it("F20260924swin 边界：20 万 chars（> 预算）→ 裁但保留最近段（裁最老保最近语义）", () => {
    const msgs = makeMessages(5, 40_000); // ≈20 万 chars
    const prompt = buildNarrativeSynthesisPrompt({
      ...base,
      messagesToSummarize: msgs,
      contextWindowTokens: 262_144,
    });
    expect(prompt).toContain("msg-4-"); // 最近段必在
    expect(prompt).toContain("<trim-note>"); // 裁了
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

  it("审视严重1回归：机械档案交接不清零——只有合成成功（narrativeSummary 非空）才清零", () => {
    // 9/23 死亡链时序：合成失败(+1) → 机械档案交接成功（restart 成功但无叙事）→ 计数保留
    // → 下次交接 getConsecutiveFailures>=2 → 熔断分支直接跳过合成。清零挂交接成功会让熔断永不生效。
    // 本测试固化状态机语义：recordHandoffFailure 只增不减，唯一清零通道是 clearHandoffFailures
    // （调用方仅在 narrativeSummary 非空时调用——接线语义见 agent-invoker unifiedHandoff）。
    const s = new HandoffState();
    s.recordHandoffFailure("o1"); // 第 1 次合成失败 → 机械档案交接（不清零）
    s.recordHandoffFailure("o1"); // 第 2 次合成失败 → 机械档案交接（不清零）
    expect(s.getConsecutiveFailures("o1")).toBe(2); // 熔断阈值到达
    // 熔断生效后交接走纯机械路径（无合成调用无失败记录）→ 计数保持
    expect(s.getConsecutiveFailures("o1")).toBe(2);
    // 模型配额恢复/窗口切换后某次合成成功 → 清零重启计数
    s.clearHandoffFailures("o1");
    expect(s.getConsecutiveFailures("o1")).toBe(0);
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
