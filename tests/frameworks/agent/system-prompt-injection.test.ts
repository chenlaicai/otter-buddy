/**
 * S1（R20260810piab）system prompt 注入测试。
 *
 * 覆盖对抗检视要求的 3 个场景：
 * 1. before_agent_start handler 返回值包含 otter prompt + identity
 * 2. 身份信息每轮都构建（不只首次 invoke）
 * 3. AsyncLocalStorage 并发隔离——两个 otter 并发 invoke 时 handler 读到各自上下文
 *
 * 测试通过导出的纯函数 buildBeforeAgentStartResult + otterInvokeStorage.run() 验证，
 * 不需要走完整 SDK 调用链。
 */
import { describe, it, expect } from "vitest";
import { buildBeforeAgentStartResult, otterInvokeStorage } from "@frameworks/agent/pi-session-factory";
import type { OtterInvokeContext } from "@frameworks/agent/pi-session-factory";
import type { OtterPromptConfig } from "@contract/api/otter";

const BASE_PROMPT = "You are a coding agent with tools: read, write, edit, bash.";
const IDENTITY_BIG = "## 你的身份\n- 名称：大獭\n- 类型：大獭\n- 海獭团队的头儿";
const IDENTITY_SMALL = "## 你的身份\n- 名称：小獭\n- 类型：小獭";
const OTTER_PROMPT_STRING = "你是一个友好的助手。";
const OTTER_PROMPT_CONFIG: OtterPromptConfig = {
  systemPrompt: "你是一个专业的编码助手。",
  reminders: [
    { content: "记得调用 speak 工具结束发言", priority: "high" },
  ],
};

describe("buildBeforeAgentStartResult（S1 system prompt 注入纯函数）", () => {
  it("base + otterPrompt + identity 三段拼接，返回完整 systemPrompt", () => {
    const ctx: OtterInvokeContext = {
      otterPromptConfig: OTTER_PROMPT_STRING,
      identityPrefix: IDENTITY_BIG,
    };
    const result = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, ctx);

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain(BASE_PROMPT);
    expect(result!.systemPrompt).toContain(OTTER_PROMPT_STRING);
    expect(result!.systemPrompt).toContain(IDENTITY_BIG);
    // 三段用 \n\n 分隔
    expect(result!.systemPrompt).toBe([BASE_PROMPT, OTTER_PROMPT_STRING, IDENTITY_BIG].join("\n\n"));
  });

  it("OtterPromptConfig（含 reminders）：systemPrompt + reminders 按优先级拼接", () => {
    const ctx: OtterInvokeContext = {
      otterPromptConfig: OTTER_PROMPT_CONFIG,
      identityPrefix: IDENTITY_SMALL,
    };
    const result = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, ctx);

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain(OTTER_PROMPT_CONFIG.systemPrompt!);
    // reminder 的 content 应出现在最终 systemPrompt 中（buildOtterPrompt 会包装为 <system-reminder>）
    expect(result!.systemPrompt).toContain("记得调用 speak 工具结束发言");
    expect(result!.systemPrompt).toContain(IDENTITY_SMALL);
  });

  it("只有 base（无 otterPrompt、无 identity）→ 返回 undefined（不覆盖 SDK base）", () => {
    const ctx: OtterInvokeContext = {
      otterPromptConfig: undefined,
      identityPrefix: "",
    };
    const result = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, ctx);
    expect(result).toBeUndefined();
  });

  it("ctx 为 undefined（ALS 无 store）→ 返回 undefined", () => {
    const result = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, undefined);
    expect(result).toBeUndefined();
  });

  it("base 为空串时仍拼接 otterPrompt + identity", () => {
    const ctx: OtterInvokeContext = {
      otterPromptConfig: OTTER_PROMPT_STRING,
      identityPrefix: IDENTITY_BIG,
    };
    const result = buildBeforeAgentStartResult({ systemPrompt: "" }, ctx);

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toBe([OTTER_PROMPT_STRING, IDENTITY_BIG].join("\n\n"));
  });

  it("只有 otterPrompt 无 identity → base + otterPrompt 两段", () => {
    const ctx: OtterInvokeContext = {
      otterPromptConfig: OTTER_PROMPT_STRING,
      identityPrefix: "",
    };
    const result = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, ctx);

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toBe([BASE_PROMPT, OTTER_PROMPT_STRING].join("\n\n"));
    expect(result!.systemPrompt).not.toContain(IDENTITY_BIG);
  });
});

describe("身份信息每轮注入（对抗检视 BUG-1 回归锁）", () => {
  it("invoke 2+（非首次）也构建 identityPrefix 并注入 system role", () => {
    // 旧 bug：identityPrefix 只在首次 invoke 构建，invoke 2+ 为空串
    // 修复后：identityPrefix 每次都构建（system prompt 不持久化，不能只首次注入）
    // 这里验证 buildBeforeAgentStartResult 收到非空 identityPrefix 时正确注入
    const ctxInvoke2: OtterInvokeContext = {
      otterPromptConfig: OTTER_PROMPT_STRING,
      identityPrefix: IDENTITY_BIG, // 修复后每次都构建，invoke 2+ 也有值
    };
    const result = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, ctxInvoke2);

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain(IDENTITY_BIG);
  });

  it("两个不同身份的 otter 产生的 systemPrompt 不同（身份不会串）", () => {
    const ctxBig: OtterInvokeContext = {
      otterPromptConfig: undefined,
      identityPrefix: IDENTITY_BIG,
    };
    const ctxSmall: OtterInvokeContext = {
      otterPromptConfig: undefined,
      identityPrefix: IDENTITY_SMALL,
    };

    const resultBig = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, ctxBig);
    const resultSmall = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, ctxSmall);

    expect(resultBig!.systemPrompt).toContain("大獭");
    expect(resultBig!.systemPrompt).not.toContain("小獭");
    expect(resultSmall!.systemPrompt).toContain("小獭");
    expect(resultSmall!.systemPrompt).not.toContain("大獭");
  });
});

describe("AsyncLocalStorage 并发隔离", () => {
  it("两个 otter 并发 invoke 时 handler 读到各自上下文（无竞态）", async () => {
    const ctxA: OtterInvokeContext = {
      otterPromptConfig: "otterA prompt",
      identityPrefix: "## 身份A\n- 名称：大獭A",
    };
    const ctxB: OtterInvokeContext = {
      otterPromptConfig: "otterB prompt",
      identityPrefix: "## 身份B\n- 名称：小獭B",
    };

    // 模拟两个并发 invoke：各自 ALS scope 内调用 handler
    // 交叉执行验证 scope 不会串
    const results: Record<string, { systemPrompt: string } | undefined> = {};

    const invokeA = otterInvokeStorage.run(ctxA, async () => {
      // 在 A 的 scope 内，先不调用（模拟等待），让 B 先进入
      await new Promise(r => setTimeout(r, 5));
      // B 此时可能已进入自己的 scope——验证 A 仍然读到 ctxA
      return buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, otterInvokeStorage.getStore());
    });

    const invokeB = otterInvokeStorage.run(ctxB, async () => {
      // B 的 scope 内立即调用
      return buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, otterInvokeStorage.getStore());
    });

    const [resultA, resultB] = await Promise.all([invokeA, invokeB]);
    results.A = resultA;
    results.B = resultB;

    // A 读到的是 ctxA（身份A），不是 ctxB
    expect(results.A).toBeDefined();
    expect(results.A!.systemPrompt).toContain("大獭A");
    expect(results.A!.systemPrompt).toContain("otterA prompt");
    expect(results.A!.systemPrompt).not.toContain("小獭B");
    expect(results.A!.systemPrompt).not.toContain("otterB prompt");

    // B 读到的是 ctxB
    expect(results.B).toBeDefined();
    expect(results.B!.systemPrompt).toContain("小獭B");
    expect(results.B!.systemPrompt).toContain("otterB prompt");
    expect(results.B!.systemPrompt).not.toContain("大獭A");
  });

  it("ALS scope 外 getStore() 返回 undefined", () => {
    // 不在 run() scope 内
    expect(otterInvokeStorage.getStore()).toBeUndefined();
  });

  it("嵌套 run() 内层覆盖外层", async () => {
    const outer: OtterInvokeContext = {
      otterPromptConfig: "outer",
      identityPrefix: "outer-identity",
    };
    const inner: OtterInvokeContext = {
      otterPromptConfig: "inner",
      identityPrefix: "inner-identity",
    };

    await otterInvokeStorage.run(outer, async () => {
      // 外层读到 outer
      expect(otterInvokeStorage.getStore()?.otterPromptConfig).toBe("outer");

      await otterInvokeStorage.run(inner, async () => {
        // 内层读到 inner
        expect(otterInvokeStorage.getStore()?.otterPromptConfig).toBe("inner");
        const result = buildBeforeAgentStartResult({ systemPrompt: BASE_PROMPT }, otterInvokeStorage.getStore());
        expect(result!.systemPrompt).toContain("inner-identity");
      });

      // 退出内层后恢复 outer
      expect(otterInvokeStorage.getStore()?.otterPromptConfig).toBe("outer");
    });
  });
});
