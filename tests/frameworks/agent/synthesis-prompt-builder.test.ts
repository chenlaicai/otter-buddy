/**
 * F20260825hndf Phase 2：交接摘要 LLM 叙事合成 prompt 构建器测试
 *
 * 验证六分区模板生成、件④机械数据注入、降级摘要构建。
 * 断言策略（D7）：验证输出结构，不绑定具体实现细节。
 */
import { describe, it, expect } from "vitest";
import { buildSynthesisPrompt, buildMechanicalDump } from "@frameworks/agent/synthesis-prompt-builder";
import type { StateInventory } from "@frameworks/agent/state-inventory";

const mockInventory: StateInventory = {
  talkingStone: { holders: ["otter-1"], from: "user-1" },
  scheduledTasks: [{ name: "daily-review", schedule: "0 10 * * *", nextTrigger: "2026-09-01T02:00:00Z" }],
  workspaceFiles: ["file1.ts", "file2.md"],
  artifacts: { active: 3, superseded: 1, flagged: 0, latestTitle: "F20260825hndf" },
  healingOpen: { count: 1, latestDesc: "test healing event" },
  activity: { status: "awaiting_review", waitingFor: "kimi" },
};

describe("buildSynthesisPrompt", () => {
  it("生成包含六分区模板的完整 prompt", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "mimo2",
      oldSessionId: "abc12345-def6-7890",
      trigger: "70%阈值",
    });

    // 六分区标题都应出现
    expect(prompt).toContain("### ① 下一步");
    expect(prompt).toContain("### ② 当前任务与完成标准");
    expect(prompt).toContain("### ③ 关键决策与理由");
    expect(prompt).toContain("### ④ 产物与锚点");
    expect(prompt).toContain("### ⑤ 协作状态");
    expect(prompt).toContain("### ⑥ 搭档上下文");
    expect(prompt).toContain("### ⑦ 交接谱系");
  });

  it("meta 行包含 otter 名称、短 session ID 和触发原因", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "mimo2",
      oldSessionId: "abc12345-def6-7890",
      trigger: "70%阈值",
    });

    expect(prompt).toContain("mimo2");
    expect(prompt).toContain("abc12345"); // 短 ID（前 8 位）
    expect(prompt).toContain("70%阈值");
  });

  it("有谱系时注入到 §⑦", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "mimo2",
      oldSessionId: "abc12345-def6-7890",
      lineage: "gen1 abc12345: Phase 1 实现",
      trigger: "手动",
    });

    expect(prompt).toContain("gen1 abc12345: Phase 1 实现");
  });

  it("无谱系时 §⑦ 提供模板占位符", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "mimo2",
      oldSessionId: "abc12345-def6-7890",
      trigger: "手动",
    });

    expect(prompt).toContain("gen1 abc12345: {{一句话干了什么}}");
  });

  it("有 StateInventory 时注入件④机械数据到 §⑤", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "mimo2",
      oldSessionId: "abc12345-def6-7890",
      trigger: "70%阈值",
      stateInventory: mockInventory,
    });

    // B1 发言石数据
    expect(prompt).toContain("在场: otter-1 手中（user-1 yield）");
    // B6 进行中数据
    expect(prompt).toContain("进行中: awaiting_review，等待 kimi");
  });

  it("无 StateInventory 时 §⑤ 降级为预渲染文本", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "mimo2",
      oldSessionId: "abc12345-def6-7890",
      trigger: "70%阈值",
      stateInventoryText: "## 活状态盘点\n- 发言石：无\n- 进行中：无",
    });

    expect(prompt).toContain("发言石：无");
    expect(prompt).toContain("进行中：无");
  });

  it("无 StateInventory 也无预渲染文本时 §⑤ 降级为空数据", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "mimo2",
      oldSessionId: "abc12345-def6-7890",
      trigger: "70%阈值",
    });

    expect(prompt).toContain("在场: 无数据");
  });

  it("prompt 包含规则指令（锚点优于复制、预算约束等）", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "mimo2",
      oldSessionId: "abc12345-def6-7890",
      trigger: "70%阈值",
    });

    expect(prompt).toContain("锚点优于复制");
    expect(prompt).toContain("≤1200 token");
    expect(prompt).toContain("§⑤ 协作状态必须使用下方提供的机械数据");
    expect(prompt).toContain("不要自行回忆");
  });
});

describe("buildMechanicalDump", () => {
  it("生成降级摘要包含 meta 行", () => {
    const dump = buildMechanicalDump("mimo2", "70%阈值");

    expect(dump).toContain("## 交接摘要（机械转储，LLM 合成降级）");
    expect(dump).toContain("mimo2");
    expect(dump).toContain("70%阈值");
  });

  it("包含降级说明", () => {
    const dump = buildMechanicalDump("mimo2", "70%阈值");

    expect(dump).toContain("LLM 叙事合成失败/超时");
    expect(dump).toContain("降级为机械转储");
  });

  it("有状态盘点文本时包含在输出中", () => {
    const dump = buildMechanicalDump("mimo2", "70%阈值", "## 活状态盘点\n- 发言石：无");

    expect(dump).toContain("### 活状态盘点");
    expect(dump).toContain("发言石：无");
  });

  it("无状态盘点文本时不含 §④", () => {
    const dump = buildMechanicalDump("mimo2", "70%阈值");

    expect(dump).not.toContain("### 活状态盘点");
  });
});
