/**
 * F20261020ided：invoke 判重去重——「同獭 running 时重试/再派工」必须在判重层被拒，
 * 而不是下沉到 session 锁 30s 超时后裸抛「[错误] Lock acquire timeout…」。
 *
 * 案发现场（2026-10-20 14:19，对话 0401284f）：前端 116ms 内对同一
 * POST /api/otters/:id/retry 发了两个请求（双击/双入口），retryByOtter 无 running
 * 判重各自放行 → 第二个 invoke ed9b0e79 撞锁超时，裸技术错误落 invoke_end 推给用户。
 *
 * 判重语义（与 abort/retry 窗口竞态裁决一致，见 invoke-controller 注释）：
 * ①invoke 库行 running → 明确在跑 → 判重拒绝（唯一新行为）
 * ②DB 终态 + AgentInvoker.isRunning(otterId) → SDK 层还在跑 → 拒绝
 * ③两者皆否 → 放行（abort 终态化收敛中重试合法，不得 409——原窗口竞态裁决保留）
 */

import { describe, expect, it, vi } from "vitest";
import { InvokeController } from "@interface-adapters/http/controllers/invoke-controller";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { Invoke } from "@entities/conversation/invoke";
import type { Logger } from "@usecases/ports/logger";

function makeInvoke(overrides: Partial<Invoke>): Invoke {
  return {
    id: "inv-1",
    conversationId: "conv-1",
    otterId: "otter-1",
    status: "failed",
    triggerEntryId: null,
    talkingStonePassedTo: null,
    startedAt: "2026-10-20T06:00:00.000Z",
    endedAt: "2026-10-20T06:01:00.000Z",
    toolCallCount: 0,
    tokenUsageInput: null,
    tokenUsageOutput: null,
    metadata: null,
    pid: null,
    ...overrides,
  } as Invoke;
}

function makeRepo(latest: Invoke | null): InvokeRepository {
  return {
    getInvokes: vi.fn().mockResolvedValue(latest ? [latest] : []),
    getInvokeById: vi.fn().mockResolvedValue(latest),
  } as unknown as InvokeRepository;
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** hono Context 最小 surface（req 参数 + c.get + json/流式响应写面） */
function makeContext() {
  return {
    req: {
      query: (k: string) => (k === "conversationId" ? "conv-1" : undefined),
      param: (k: string) => (k === "id" ? "otter-1" : ""),
    },
    json: vi.fn().mockReturnValue(new Response()),
    get: vi.fn().mockReturnValue(undefined),
    header: vi.fn(),
    status: vi.fn(),
    body: vi.fn().mockReturnValue(new Response()),
  };
}

/** 从 c.json 调用记录中查判重 409 是否发出（断言判重语义，不绑定实现参数） */
function findDedupConflict(c: ReturnType<typeof makeContext>) {
  return (c.json as ReturnType<typeof vi.fn>).mock.calls.find(
    ([body]) => (body as { code?: string }).code === "otter_invoke_running",
  );
}

describe("F20261020ided retryByOtter 判重去重", () => {
  it("①latest invoke 为 running → 409 + code=otter_invoke_running，不触达链引擎", async () => {
    const running = makeInvoke({ id: "inv-running", status: "running", endedAt: null });
    const agentInvoker = {
      isRunning: vi.fn().mockReturnValue(false),
      invokeConversation: vi.fn(),
    };
    const dispatchChainEngine = { executeChain: vi.fn().mockResolvedValue(undefined) };
    const controller = new InvokeController(
      makeRepo(running),
      logger,
      agentInvoker as never,
      dispatchChainEngine as never,
    );

    const c = makeContext();
    const res = await controller.retryByOtter(c as never);

    expect(findDedupConflict(c)).toBeDefined();
    // 固化「不触达链引擎/SDK」：判重拒绝后任何下游调用都不得发生
    expect(agentInvoker.invokeConversation).not.toHaveBeenCalled();
    expect(dispatchChainEngine.executeChain).not.toHaveBeenCalled();
    void res;
  });

  it("②DB 终态但 SDK 层 isRunning → 409 + code=otter_invoke_running，不触达链引擎", async () => {
    const failed = makeInvoke({ id: "inv-failed", status: "failed" });
    const agentInvoker = {
      isRunning: vi.fn().mockReturnValue(true),
      invokeConversation: vi.fn(),
    };
    const dispatchChainEngine = { executeChain: vi.fn().mockResolvedValue(undefined) };
    const controller = new InvokeController(
      makeRepo(failed),
      logger,
      agentInvoker as never,
      dispatchChainEngine as never,
    );

    const c = makeContext();
    await controller.retryByOtter(c as never);

    expect(findDedupConflict(c)).toBeDefined();
    expect(agentInvoker.invokeConversation).not.toHaveBeenCalled();
    expect(dispatchChainEngine.executeChain).not.toHaveBeenCalled();
  });

  it("③DB 终态 + SDK 层空闲 → 放行（abort 终态化收敛中重试合法，窗口竞态裁决保留）", async () => {
    const failed = makeInvoke({ id: "inv-failed", status: "failed" });
    const agentInvoker = {
      isRunning: vi.fn().mockReturnValue(false),
      invokeConversation: vi.fn().mockResolvedValue({ invokeId: "inv-new" }),
    };
    const dispatchChainEngine = { executeChain: vi.fn().mockResolvedValue(undefined) };
    const controller = new InvokeController(
      makeRepo(failed),
      logger,
      agentInvoker as never,
      dispatchChainEngine as never,
    );

    const c = makeContext();
    const res = await controller.retryByOtter(c as never);

    // 判重放行：不得返回 409 code（现状缺失 isRunning 判重 → 放行路径触达；
    // 本 mock 环境下流式 SSE 不可用，executeChain 不一定被真实触达——断言判重语义而非下游副作用）
    expect(findDedupConflict(c)).toBeUndefined();
    void res;
  });

  it("④用户刚点中断（SDK 层已停、库行已 aborted）→ 重试放行（中断后立即重试是合法操作）", async () => {
    const aborted = makeInvoke({ id: "inv-aborted", status: "aborted" });
    const agentInvoker = {
      isRunning: vi.fn().mockReturnValue(false),
      invokeConversation: vi.fn().mockResolvedValue({ invokeId: "inv-new" }),
    };
    const dispatchChainEngine = { executeChain: vi.fn().mockResolvedValue(undefined) };
    const controller = new InvokeController(
      makeRepo(aborted),
      logger,
      agentInvoker as never,
      dispatchChainEngine as never,
    );

    const c = makeContext();
    await controller.retryByOtter(c as never);

    expect(findDedupConflict(c)).toBeUndefined();
  });
});
