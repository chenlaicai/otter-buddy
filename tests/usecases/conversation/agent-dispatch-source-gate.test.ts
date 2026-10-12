/**
 * dispatch() 共享入口的来源闸接线断言（#1430 首轮严重1 处置）。
 *
 * 背景：dispatch() 是共享入口——feishu/weixin（IM 用户消息）与 agent-invoker 首哑处置
 * （system 合成告警文本）都从这里进。首轮实现曾在此入口硬标 triggerSenderType: "user"，
 * 导致首哑合成文本仍被当用户消息扫描（11:57 二次复现的嫌疑路径）。
 * 修法：来源由调用方显式声明，dispatch() 透传到 fireDirectChain / dispatchLegacyChain
 * 的 executeChain——本文件断言透传线本身（接线层，非引擎层）。
 */
import { describe, it, expect, vi } from "vitest";
import { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import { createTestLogger } from "../../helpers/logger";

/** 采集 executeChain 入参的链引擎 mock（fireDirectChain 是 fire-and-forget，断言前等一拍） */
function makeCapturingEngine() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    engine: {
      executeChain: vi.fn(async (params: Record<string, unknown>) => {
        calls.push(params);
        return {};
      }),
    },
  };
}

function makeDeps(engine: unknown, opts: { withRouter?: boolean } = {}) {
  return {
    dispatchChainEngine: engine,
    entryRepo: { getEntries: vi.fn(async () => [{ id: "e-1", yieldTargets: ["otter-1"] }]) },
    agentInvokePort: { invokeConversation: vi.fn(async () => ({ messageId: "m-1" })) },
    logger: createTestLogger(),
    ...(opts.withRouter ? { signalRouter: { routeSignals: vi.fn(async () => []) } } : {}),
  } as never;
}

const sleep = () => new Promise(r => setTimeout(r, 50));

describe("dispatch() 来源闸接线（#1430 首轮严重1）", () => {
  it("显式目标直连链（fireDirectChain）：system 来源透传到 executeChain——首哑合成文本不进扫描", async () => {
    const cap = makeCapturingEngine();
    const svc = new AgentDispatchService(makeDeps(cap.engine, { withRouter: true }));
    await svc.dispatch({
      conversationId: "conv-1",
      userMessageContent: "[首哑告警] …原派工任务：…发简报说明故障并停下，不要自行改脚本",
      senderId: "system",
      resolvedTargets: ["otter-big-1"],
      triggerSenderType: "system",
    });
    await sleep();
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].triggerSenderType).toBe("system");
    expect(cap.calls[0].userMessageContent).toContain("停下");
  });

  it("显式目标直连链：user 来源透传（IM 用户消息过闸）", async () => {
    const cap = makeCapturingEngine();
    const svc = new AgentDispatchService(makeDeps(cap.engine, { withRouter: true }));
    await svc.dispatch({
      conversationId: "conv-1",
      userMessageContent: "停下",
      senderId: "ou_user",
      resolvedTargets: ["otter-1"],
      triggerSenderType: "user",
    });
    await sleep();
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].triggerSenderType).toBe("user");
  });

  it("显式目标直连链：来源缺省不透传（undefined → 引擎不扫描，漏报方向安全）", async () => {
    const cap = makeCapturingEngine();
    const svc = new AgentDispatchService(makeDeps(cap.engine, { withRouter: true }));
    await svc.dispatch({
      conversationId: "conv-1",
      userMessageContent: "停下",
      senderId: "ou_user",
      resolvedTargets: ["otter-1"],
    });
    await sleep();
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].triggerSenderType).toBeUndefined();
  });

  it("旧降级路径（dispatchLegacyChain）：来源同样透传，不因路径切换丢闸", async () => {
    const cap = makeCapturingEngine();
    const svc = new AgentDispatchService(makeDeps(cap.engine, { withRouter: false }));
    await svc.dispatch({
      conversationId: "conv-1",
      userMessageContent: "[首哑告警] 合成文本…停下",
      senderId: "system",
      triggerSenderType: "system",
    });
    await sleep();
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].triggerSenderType).toBe("system");
  });
});
