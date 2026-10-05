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
        message: {
          getLastBySenderType: vi.fn(async () => null),
        },
        // F20260913ctlv 批3：entry 命名空间（用户介入检测数据源切 entries）
        entry: {
          getEntries: vi.fn(async () => []),
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

  /** F20261005srst（#1203）：self_restart 事件指向 new-session-otter-1 的 healingRepo mock（多用例共享） */
  function createSelfRestartHealingRepo(overrides?: { create?: (e: Record<string, unknown>) => Promise<void> }) {
    return {
      create: overrides?.create ?? (async () => {}),
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
  }

  /** mock active session（自重启创建，ageMinutes 分钟前启动） */
  function mockActiveSession(ctx: ToolContext, ageMinutes: number) {
    (ctx.client.otter.getActiveSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'new-session-otter-1', otterId: 'otter-1', status: 'active',
      startedAt: new Date(Date.now() - ageMinutes * 60 * 1000).toISOString(),
    });
  }

  it('session 由自重启创建时（窗口内），返回系统保护错误', async () => {
    const ctx = createMockToolContext();
    const healingRepo = createSelfRestartHealingRepo();
    // F20260906srst：显式带 startedAt，验证无用户消息介入时的降级路径；
    // F20261005srst（#1203）：startedAt 用窗口内相对时间（1h 前）——固定旧日期会被时间衰减豁免放行
    mockActiveSession(ctx, 60);
    const tools = createTools(ctx, healingRepo, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '测试' });

    // 验证返回系统保护错误（#1203：文案含替代通道引导）
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('系统保护');
    expect(result.content[0].text).toContain('不允许连续自重启');
    expect(result.content[0].text).toContain('UI 手动重启');
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

  it('#811：session 由自重启创建但用户消息已介入 → 放行（不再误拦）', async () => {
    const ctx = createMockToolContext();
    const healingRepo = createSelfRestartHealingRepo();
    // session 由自重启创建，startedAt 早于用户消息
    // F20261005srst（#1203）：改窗口内相对时间（30min 前）——固定旧日期会被时间衰减豁免短路，
    // 该用例将不再测介入判据路径（退化为与豁免用例重复）
    mockActiveSession(ctx, 30);
    // 最新 user entry 晚于 session 创建（搭档重启后发过新指令；批3 切 entries 数据源）
    (ctx.client.conversation.entry.getEntries as ReturnType<typeof vi.fn>) = vi.fn(async (_convId: string, opts?: { entryType?: string }) => {
      if (opts?.entryType === 'user') {
        return [{ id: 'user-entry-1', entryType: 'user', body: '新指令', senderId: 'chen', senderType: 'user', createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }];
      }
      return [];
    });
    const tools = createTools(ctx, healingRepo, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '搭档指令重启' });

    // 用户消息介入 → 正常运维，放行
    expect(result.isError).toBeUndefined();
    expect(ctx.pendingRestart).toBeDefined();
  });

  it('#811：用户消息早于 session 创建（重启前的旧消息）→ 仍拦截', async () => {
    const ctx = createMockToolContext();
    const healingRepo = createSelfRestartHealingRepo();
    // F20261005srst（#1203）：窗口内相对时间（30min 前）——旧固定日期会被时间衰减豁免放行
    mockActiveSession(ctx, 30);
    // 最新 user entry 早于 session 创建 → 无新介入，维持拦截（批3 切 entries 数据源）
    (ctx.client.conversation.entry.getEntries as ReturnType<typeof vi.fn>) = vi.fn(async (_convId: string, opts?: { entryType?: string }) => {
      if (opts?.entryType === 'user') {
        return [{ id: 'user-entry-0', entryType: 'user', body: '旧指令', senderId: 'chen', senderType: 'user', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }];
      }
      return [];
    });
    const tools = createTools(ctx, healingRepo, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '测试' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('系统保护');
    expect(ctx._restartCalls).toHaveLength(0);
    expect(ctx.pendingRestart).toBeUndefined();
  });

  it('#1203：session 由自重启创建但存活超 2h（窗口外）→ 时间衰减豁免放行', async () => {
    const ctx = createMockToolContext();
    const healingRepo = createSelfRestartHealingRepo();
    // 9/28 现场形态：07:27 自重启创建，12:38 搭档指令重启（间隔 5h）——旧逻辑被拦，新逻辑豁免放行
    mockActiveSession(ctx, 5 * 60);
    // 介入判据查询抛错（模拟 9/28 判据失效）——豁免层在其之前生效，查询都不该被触发
    let interventionQueries = 0;
    (ctx.client.conversation.entry.getEntries as ReturnType<typeof vi.fn>) = vi.fn(async () => {
      interventionQueries++;
      throw new Error('query degraded');
    });
    const tools = createTools(ctx, healingRepo, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '搭档指令重启' });

    // 豁免放行：不拦 + 不再触发介入判据查询
    expect(result.isError).toBeUndefined();
    expect(ctx.pendingRestart).toBeDefined();
    expect(interventionQueries).toBe(0);
  });

  it('#1203：窗口内判据查询瞬时失败 → 重试一次后成功判定（无介入仍拦，不落降级事件）', async () => {
    const ctx = createMockToolContext();
    const createCalls: Array<Record<string, unknown>> = [];
    const healingRepo = createSelfRestartHealingRepo({ create: async (e) => { createCalls.push(e); } });
    mockActiveSession(ctx, 30);
    // 第一次抛错（瞬时故障），第二次成功返回无介入（旧消息）
    let attempts = 0;
    (ctx.client.conversation.entry.getEntries as ReturnType<typeof vi.fn>) = vi.fn(async (_convId: string, opts?: { entryType?: string }) => {
      attempts++;
      if (attempts === 1) throw new Error('transient');
      if (opts?.entryType === 'user') {
        return [{ id: 'user-entry-0', entryType: 'user', body: '旧指令', senderId: 'chen', senderType: 'user', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }];
      }
      return [];
    });
    const tools = createTools(ctx, healingRepo, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '测试' });

    // 重试成功 → 正常判定无介入 → 拦截；查询尝试了 2 次；无降级落账
    expect(attempts).toBe(2);
    expect(result.isError).toBe(true);
    expect(createCalls).toHaveLength(0);
  });

  it('#1203：窗口内判据查询重试后仍失败 → 拦截且降级事件落 healing 台账（不再静默）', async () => {
    const ctx = createMockToolContext();
    const createCalls: Array<Record<string, unknown>> = [];
    const healingRepo = createSelfRestartHealingRepo({ create: async (e) => { createCalls.push(e); } });
    mockActiveSession(ctx, 30);
    // 每次都抛错——重试耗尽后降级
    let attempts = 0;
    (ctx.client.conversation.entry.getEntries as ReturnType<typeof vi.fn>) = vi.fn(async () => {
      attempts++;
      throw new Error('persistent failure');
    });
    const tools = createTools(ctx, healingRepo, createRecordingLogger());
    const restartTool = tools.find(t => t.name === 'restart_otter');
    if (!restartTool) throw new Error('restart_otter tool not found');

    const result = await restartTool.execute('call-1', { summary: '测试' });

    // 重试耗尽 → 维持拦截 + 降级事件落账（可观测）
    expect(attempts).toBe(2);
    expect(result.isError).toBe(true);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].errorType).toBe('other');
    expect(String(createCalls[0].description)).toContain('判据失效');
  });
});
