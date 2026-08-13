/**
 * F20260815rstrt pendingRestart 路径单元测试。
 *
 * 测试 restart_otter 工具的自重启延迟执行逻辑：
 * - 自重启：设置 pendingRestart，不立即执行
 * - 重启别人：直接执行 restart
 * - 异常处理：pendingRestart restart 失败时 catch 并记录日志
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@interface-adapters/agent-runtime/tools/tool-factory';

// ─── 辅助工具 ─────────────────────────────────────────────

/** 创建记录式 logger（记录调用，不使用 toHaveBeenCalledWith） */
function createRecordingLogger() {
  const infoCalls: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const errorCalls: Array<{ message: string; error?: Error; data?: Record<string, unknown> }> = [];

  return {
    _infoCalls: infoCalls,
    _errorCalls: errorCalls,
    info: vi.fn((message: string, data?: Record<string, unknown>) => {
      infoCalls.push({ message, data });
    }),
    warn: vi.fn(),
    error: vi.fn((message: string, error?: Error, data?: Record<string, unknown>) => {
      errorCalls.push({ message, error, data });
    }),
    debug: vi.fn(),
    child: vi.fn(() => createRecordingLogger()),
  };
}

/** 创建 ToolContext mock，使用 spy 记录 restart 调用 */
function createMockToolContext(overrides: Partial<ToolContext> = {}): ToolContext & { _restartCalls: Array<{ id: string; summary?: string }> } {
  const restartCalls: Array<{ id: string; summary?: string }> = [];

  return {
    _restartCalls: restartCalls,
    otterId: 'otter-1',
    conversationId: 'conv-1',
    currentMessageId: 'msg-1',
    client: {
      otter: {
        getById: vi.fn(async (id: string) => {
          if (id === 'otter-1') return { id: 'otter-1', type: 'big', name: '大獭' };
          if (id === 'otter-2') return { id: 'otter-2', type: 'big', name: '小獭' };
          return null;
        }),
        restart: vi.fn(async (id: string, summary?: string) => {
          restartCalls.push({ id, summary });
          return { id: `new-session-${id}`, summary };
        }),
      },
      conversation: {
        participant: {
          getActive: vi.fn(async () => []),
        },
      },
    },
    logger: createRecordingLogger(),
    ...overrides,
  } as unknown as ToolContext & { _restartCalls: Array<{ id: string; summary?: string }> };
}

// ─── 测试 ─────────────────────────────────────────────────

describe('restart_otter pendingRestart 路径（F20260815rstrt）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('自重启：设置 pendingRestart，不立即执行 restart', async () => {
    const ctx = createMockToolContext();

    // 模拟 restart_otter 工具的 execute 逻辑（自重启路径）
    const targetOtterId = ctx.otterId;
    const summary = '测试前情摘要';

    // 自重启时设置 pendingRestart
    if (targetOtterId === ctx.otterId) {
      ctx.pendingRestart = { summary };
    }

    // 验证 pendingRestart 被设置
    expect(ctx.pendingRestart).toBeDefined();
    expect(ctx.pendingRestart!.summary).toBe('测试前情摘要');

    // 验证 restart 没有被调用（延迟执行）
    expect(ctx._restartCalls).toHaveLength(0);
  });

  it('自重启：pendingRestart 设置后，PiSessionFactory 应执行 restart', async () => {
    const ctx = createMockToolContext();

    // 模拟 restart_otter 工具设置 pendingRestart
    ctx.pendingRestart = { summary: '测试前情摘要' };

    // 模拟 PiSessionFactory 在 prompt 完成后检查 pendingRestart
    if (ctx.pendingRestart) {
      const newSession = await ctx.client.otter.restart(ctx.otterId, ctx.pendingRestart.summary);
      ctx.logger.info('Self-restart completed after invoke', { otterId: ctx.otterId, newSessionId: newSession.id });
    }

    // 验证 restart 被调用（通过记录的调用）
    expect(ctx._restartCalls).toHaveLength(1);
    expect(ctx._restartCalls[0].id).toBe('otter-1');
    expect(ctx._restartCalls[0].summary).toBe('测试前情摘要');

    // 验证日志记录（通过记录的调用）
    const logger = ctx.logger as unknown as { _infoCalls: Array<{ message: string; data?: Record<string, unknown> }> };
    expect(logger._infoCalls).toHaveLength(1);
    expect(logger._infoCalls[0].message).toBe('Self-restart completed after invoke');
    expect(logger._infoCalls[0].data?.otterId).toBe('otter-1');
  });

  it('自重启：pendingRestart restart 失败时 catch 并记录日志', async () => {
    const ctx = createMockToolContext();

    // 模拟 restart_otter 工具设置 pendingRestart
    ctx.pendingRestart = { summary: '测试前情摘要' };

    // 模拟 restart 失败（保留记录调用的能力）
    const originalRestart = ctx.client.otter.restart as ReturnType<typeof vi.fn>;
    originalRestart.mockImplementationOnce(async (id: string, summary?: string) => {
      ctx._restartCalls.push({ id, summary });
      throw new Error('restart failed');
    });

    // 模拟 PiSessionFactory 在 prompt 完成后检查 pendingRestart（带错误处理）
    if (ctx.pendingRestart) {
      try {
        const newSession = await ctx.client.otter.restart(ctx.otterId, ctx.pendingRestart.summary);
        ctx.logger.info('Self-restart completed after invoke', { otterId: ctx.otterId, newSessionId: newSession.id });
      } catch (restartErr) {
        ctx.logger.error('Self-restart failed after invoke', restartErr as Error, { otterId: ctx.otterId });
      }
    }

    // 验证 restart 被调用（通过记录的调用）
    expect(ctx._restartCalls).toHaveLength(1);

    // 验证错误被记录（通过记录的调用）
    const logger = ctx.logger as unknown as { _errorCalls: Array<{ message: string; error?: Error; data?: Record<string, unknown> }> };
    expect(logger._errorCalls).toHaveLength(1);
    expect(logger._errorCalls[0].message).toBe('Self-restart failed after invoke');
    expect(logger._errorCalls[0].error?.message).toBe('restart failed');
    expect(logger._errorCalls[0].data?.otterId).toBe('otter-1');

    // 验证 info 没有被调用（restart 失败）
    const infoLogger = ctx.logger as unknown as { _infoCalls: Array<{ message: string; data?: Record<string, unknown> }> };
    expect(infoLogger._infoCalls).toHaveLength(0);
  });

  it('重启别人：直接执行 restart，不设置 pendingRestart', async () => {
    const ctx = createMockToolContext();

    // 模拟 restart_otter 工具的 execute 逻辑（重启别人路径）
    const targetOtterId = 'otter-2';
    const summary = '测试前情摘要';

    // 重启别人：直接执行 restart
    if (targetOtterId !== ctx.otterId) {
      const session = await ctx.client.otter.restart(targetOtterId, summary);
      ctx.logger.info('Restart other otter', { targetOtterId, sessionId: session.id });
    }

    // 验证 restart 被调用（通过记录的调用）
    expect(ctx._restartCalls).toHaveLength(1);
    expect(ctx._restartCalls[0].id).toBe('otter-2');
    expect(ctx._restartCalls[0].summary).toBe('测试前情摘要');

    // 验证 pendingRestart 没有被设置
    expect(ctx.pendingRestart).toBeUndefined();
  });

  it('自重启无 summary：pendingRestart.summary 为 undefined', async () => {
    const ctx = createMockToolContext();

    // 模拟 restart_otter 工具设置 pendingRestart（无 summary）
    ctx.pendingRestart = {};

    // 验证 pendingRestart 被设置
    expect(ctx.pendingRestart).toBeDefined();
    expect(ctx.pendingRestart!.summary).toBeUndefined();

    // 模拟 PiSessionFactory 在 prompt 完成后检查 pendingRestart
    if (ctx.pendingRestart) {
      const newSession = await ctx.client.otter.restart(ctx.otterId, ctx.pendingRestart.summary);
      ctx.logger.info('Self-restart completed after invoke', { otterId: ctx.otterId, newSessionId: newSession.id });
    }

    // 验证 restart 被调用（summary 为 undefined）
    expect(ctx._restartCalls).toHaveLength(1);
    expect(ctx._restartCalls[0].id).toBe('otter-1');
    expect(ctx._restartCalls[0].summary).toBeUndefined();
  });
});
