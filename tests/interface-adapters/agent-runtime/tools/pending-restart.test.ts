/**
 * F20260815rstrt pendingRestart 路径单元测试。
 *
 * 通过公共 API createTools 测试 restart_otter 工具的自重启延迟执行逻辑。
 * 实际调用生产代码，而非手动复制逻辑。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';
import type { ToolContext } from '@usecases/ports/agent-tools';

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
        getActiveSession: vi.fn(async () => null),
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

/** 获取 restart_otter 工具 */
function getRestartTool(ctx: ToolContext) {
  const tools = createTools(ctx, undefined, createRecordingLogger());
  const restartTool = tools.find(t => t.name === 'restart_otter');
  if (!restartTool) throw new Error('restart_otter tool not found');
  return restartTool;
}

// ─── 测试 ─────────────────────────────────────────────────

describe('restart_otter pendingRestart 路径（F20260815rstrt）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('自重启：设置 pendingRestart，不立即执行 restart', async () => {
    const ctx = createMockToolContext();
    const restartTool = getRestartTool(ctx);

    // 调用生产代码（自重启路径）
    const result = await restartTool.execute('call-1', { summary: '测试前情摘要' });

    // 验证 pendingRestart 被设置
    expect(ctx.pendingRestart).toBeDefined();
    expect(ctx.pendingRestart!.summary).toBe('测试前情摘要');

    // 验证 restart 没有被调用（延迟执行）
    expect(ctx._restartCalls).toHaveLength(0);

    // 验证返回消息
    expect(result.content[0].text).toContain('已标记重启');
  });

  it('自重启无 summary：pendingRestart.summary 为 undefined', async () => {
    const ctx = createMockToolContext();
    const restartTool = getRestartTool(ctx);

    // 调用生产代码（自重启路径，无 summary）
    const result = await restartTool.execute('call-1', {});

    // 验证 pendingRestart 被设置
    expect(ctx.pendingRestart).toBeDefined();
    expect(ctx.pendingRestart!.summary).toBeUndefined();

    // 验证 restart 没有被调用（延迟执行）
    expect(ctx._restartCalls).toHaveLength(0);

    // 验证返回消息不含"前情摘要"
    expect(result.content[0].text).toContain('已标记重启');
    expect(result.content[0].text).not.toContain('前情摘要');
  });

  it('重启别人：直接执行 restart，不设置 pendingRestart', async () => {
    const ctx = createMockToolContext();
    const restartTool = getRestartTool(ctx);

    // 调用生产代码（重启别人路径）
    const result = await restartTool.execute('call-1', { otterId: 'otter-2', summary: '测试前情摘要' });

    // 验证 restart 被调用（通过记录的调用）
    expect(ctx._restartCalls).toHaveLength(1);
    expect(ctx._restartCalls[0].id).toBe('otter-2');
    expect(ctx._restartCalls[0].summary).toBe('测试前情摘要');

    // 验证 pendingRestart 没有被设置
    expect(ctx.pendingRestart).toBeUndefined();

    // 验证返回消息
    expect(result.content[0].text).toContain('已重启獭生');
  });

  it('目标 Otter 不存在：返回错误', async () => {
    const ctx = createMockToolContext();
    const restartTool = getRestartTool(ctx);

    // 调用生产代码（目标不存在）
    const result = await restartTool.execute('call-1', { otterId: 'non-existent' });

    // 验证返回错误
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('不存在或已解散');

    // 验证 restart 没有被调用
    expect(ctx._restartCalls).toHaveLength(0);
  });

  it('小獭不能重启别人：返回错误', async () => {
    const ctx = createMockToolContext({
      otterId: 'small-otter',
      client: {
        otter: {
          getById: vi.fn(async (id: string) => {
            if (id === 'small-otter') return { id: 'small-otter', type: 'small', name: '小獭' };
            if (id === 'otter-2') return { id: 'otter-2', type: 'big', name: '大獭' };
            return null;
          }),
          getActiveSession: vi.fn(async () => null),
          restart: vi.fn(async (id: string, summary?: string) => ({
            id: `new-session-${id}`,
            summary,
          })),
        },
      },
    } as unknown as Partial<ToolContext>);
    const restartTool = getRestartTool(ctx);

    // 调用生产代码（小獭重启别人）
    const result = await restartTool.execute('call-1', { otterId: 'otter-2' });

    // 验证返回错误
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('小獭只能重启自己的獭生');
  });
});

describe('restart_otter 自重启循环防护（F20260824srst）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('session 由自重启创建时，返回系统保护错误', async () => {
    const ctx = createMockToolContext();
    // mock healingRepo: 当前 session 由自重启创建
    const healingRepo = {
      create: async () => {},
      findById: async () => null,
      findOpen: async () => [],
      findAll: async () => [],
      findByConversation: async () => [],
      findRecentByOtter: async () => [{
        id: 'evt-1', errorType: 'self_restart',
        context: { newSessionId: 'new-session-otter-1' },
        createdAt: new Date().toISOString(),
      }],
      updateStatus: async () => {},
      resolve: async () => {},
      getStats: async () => ({ open: 0, resolved: 0, dismissed: 0, byType: {}, bySeverity: {} }),
      autoStaleDismiss: async () => 0,
    } as unknown as import('@usecases/healing/healing-event-repository').HealingEventRepository;
    // mock getActiveSession 返回匹配的 session
    (ctx.client.otter.getActiveSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'new-session-otter-1', otterId: 'otter-1', status: 'active',
    });
    const tools = createTools(ctx, healingRepo, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '测试' });

    // 验证返回系统保护错误
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('系统保护');
    expect(result.content[0].text).toContain('不允许连续自重启');
    // 验证 restart 未被调用
    expect(ctx._restartCalls).toHaveLength(0);
  });

  it('healingRepo 未注入时，降级放行（不拦截）', async () => {
    const ctx = createMockToolContext();
    const tools = createTools(ctx, undefined, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '测试' });

    // 无 healingRepo → isSelfRestartLoop 返回 false → 放行
    expect(result.isError).toBeUndefined();
    expect(ctx.pendingRestart).toBeDefined();
  });

  it('session 不是由自重启创建时，正常放行', async () => {
    const ctx = createMockToolContext();
    const healingRepo = {
      create: async () => {},
      findById: async () => null,
      findOpen: async () => [],
      findAll: async () => [],
      findByConversation: async () => [],
      findRecentByOtter: async () => [], // 无 self_restart 事件
      updateStatus: async () => {},
      resolve: async () => {},
      getStats: async () => ({ open: 0, resolved: 0, dismissed: 0, byType: {}, bySeverity: {} }),
      autoStaleDismiss: async () => 0,
    } as unknown as import('@usecases/healing/healing-event-repository').HealingEventRepository;
    const tools = createTools(ctx, healingRepo, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '测试' });

    // 无 self_restart 事件 → 放行
    expect(result.isError).toBeUndefined();
    expect(ctx.pendingRestart).toBeDefined();
  });
});
