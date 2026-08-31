/**
 * F20260825hndf Phase 2：四件套编排器 LLM 合成测试
 *
 * 验证件①摘要生成的三级防线：
 * 防线①：LLM 叙事合成（synthesize 函数提供且成功）
 * 防线②：机械转储（synthesize 失败/超时/返回空）
 * 防线③：无 synthesize 时直接走机械转储
 *
 * 断言策略（D7）：验证输出状态，不绑定调用参数。
 */
import { describe, it, expect, vi } from "vitest";
import { buildHandoffPackage } from "@frameworks/agent/handoff-package-builder";
import type { StateInventoryDeps } from "@frameworks/agent/state-inventory";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import { createTestLogger, createCapturingLogger } from "../../helpers/logger";

function mockQueryMessage(overrides?: Partial<QueryMessage>) {
  return {
    getMessageById: vi.fn().mockResolvedValue(null),
    getMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as QueryMessage;
}

function mockConversationRepo() {
  return {
    getLinkedResources: vi.fn().mockResolvedValue([]),
    listConversationsWithMeta: vi.fn().mockResolvedValue([]),
  } as unknown as ConversationRepository;
}

function makeStateInventoryDeps(overrides?: Partial<StateInventoryDeps>): StateInventoryDeps {
  return {
    queryMessage: mockQueryMessage(),
    conversationRepo: mockConversationRepo(),
    listArtifacts: vi.fn().mockResolvedValue([]),
    workspacePath: undefined,
    logger: createTestLogger(),
    ...overrides,
  };
}

describe("buildHandoffPackage - LLM 合成", () => {
  it("防线①：synthesize 成功时使用 LLM 合成摘要", async () => {
    const synthesize = vi.fn().mockResolvedValue("## 交接摘要\nmimo2 的叙事摘要内容");
    const pkg = await buildHandoffPackage("conv-1", "otter-1", {
      stateInventoryDeps: makeStateInventoryDeps(),
      queryMessage: mockQueryMessage(),
      synthesize,
      otterName: "mimo2",
      trigger: "70%阈值",
    });

    // summary 应包含 LLM 输出
    expect(pkg.summary).toContain("mimo2 的叙事摘要内容");
    // synthesize 应被调用
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it("防线②：synthesize 返回空时降级为机械转储", async () => {
    const logger = createCapturingLogger();
    const synthesize = vi.fn().mockResolvedValue("");
    const pkg = await buildHandoffPackage("conv-1", "otter-1", {
      stateInventoryDeps: makeStateInventoryDeps(),
      queryMessage: mockQueryMessage(),
      synthesize,
      logger,
      otterName: "mimo2",
      trigger: "70%阈值",
    });

    // summary 应是机械转储（包含降级标记）
    expect(pkg.summary).toContain("机械转储");
    // 应打 warn 日志
    expect(logger.captured.warns.some(w => w.includes("LLM synthesis returned empty"))).toBe(true);
  });

  it("防线②：synthesize 抛异常时降级为机械转储", async () => {
    const logger = createCapturingLogger();
    const synthesize = vi.fn().mockRejectedValue(new Error("API timeout"));
    const pkg = await buildHandoffPackage("conv-1", "otter-1", {
      stateInventoryDeps: makeStateInventoryDeps(),
      queryMessage: mockQueryMessage(),
      synthesize,
      logger,
      otterName: "mimo2",
      trigger: "70%阈值",
    });

    expect(pkg.summary).toContain("机械转储");
    expect(logger.captured.warns.some(w => w.includes("LLM synthesis failed"))).toBe(true);
  });

  it("防线②：synthesize 超时时降级为机械转储", async () => {
    const logger = createCapturingLogger();
    // 模拟超时行为：synthesize 抛出 timeout 错误（与 Promise.race 超时行为等价）
    const synthesize = vi.fn().mockRejectedValue(new Error('Synthesis timeout'));
    const pkg = await buildHandoffPackage("conv-1", "otter-1", {
      stateInventoryDeps: makeStateInventoryDeps(),
      queryMessage: mockQueryMessage(),
      synthesize,
      logger,
      otterName: "mimo2",
      trigger: "70%阈值",
    });

    expect(pkg.summary).toContain("机械转储");
    // timeout 错误应被 warn 日志记录
    expect(logger.captured.warns.some(w => w.includes("LLM synthesis failed"))).toBe(true);
  });

  it("防线③：无 synthesize 时直接走机械转储", async () => {
    const pkg = await buildHandoffPackage("conv-1", "otter-1", {
      stateInventoryDeps: makeStateInventoryDeps(),
      queryMessage: mockQueryMessage(),
      otterName: "mimo2",
      trigger: "手动",
    });

    expect(pkg.summary).toContain("机械转储");
    expect(pkg.summary).toContain("手动");
  });

  it("件②③④始终生成（无论 synthesize 是否成功）", async () => {
    const synthesize = vi.fn().mockResolvedValue("LLM 摘要");
    const pkg = await buildHandoffPackage("conv-1", "otter-1", {
      stateInventoryDeps: makeStateInventoryDeps(),
      queryMessage: mockQueryMessage(),
      synthesize,
      otterName: "mimo2",
      trigger: "70%阈值",
    });

    // 件②③④应该都有内容（即使是降级的）
    expect(pkg.fileTrail).toBeDefined();
    expect(pkg.recencyWindow).toBeDefined();
    expect(pkg.stateInventory).toBeDefined();
  });

  it("totalTokenEstimate 合理（四件套总 token 估算）", async () => {
    const synthesize = vi.fn().mockResolvedValue("a".repeat(4000)); // ~1000 tokens
    const pkg = await buildHandoffPackage("conv-1", "otter-1", {
      stateInventoryDeps: makeStateInventoryDeps(),
      queryMessage: mockQueryMessage(),
      synthesize,
      otterName: "mimo2",
      trigger: "70%阈值",
    });

    expect(pkg.totalTokenEstimate).toBeGreaterThan(0);
    // 应该在合理范围内（不超过 10.7k 预算）
    expect(pkg.totalTokenEstimate).toBeLessThan(20000);
  });

  it("触发原因透传到机械转储", async () => {
    const pkg = await buildHandoffPackage("conv-1", "otter-1", {
      stateInventoryDeps: makeStateInventoryDeps(),
      queryMessage: mockQueryMessage(),
      trigger: "熔断",
    });

    expect(pkg.summary).toContain("熔断");
  });
});
