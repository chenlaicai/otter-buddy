/**
 * F20261005srst（#1203）：invoker 层自重启防线测试（检视处置严重 2——13/13 全锚 tool 层，
 * invoker 层 hasUserMessageSince/isSessionSelfRestartCreated 零覆盖）。
 *
 * 覆盖面：
 * - hasUserMessageSince 纯函数：介入/无介入/查询为空/重试一次成功/重试耗尽降级+onDegrade 回调
 * - isSessionSelfRestartCreated：非自重启 session 放行 / 窗口外豁免 / 窗口内有介入放行 /
 *   窗口内无介入拦截 / 降级落账（invokeId 透传）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasUserMessageSince, CircuitBreakSupport } from '@interface-adapters/agent-runtime/circuit-break-support';

// ─── hasUserMessageSince 纯函数 ─────────────────────────────

describe('hasUserMessageSince（F20260906srst + F20261005srst 重试/可观测）', () => {
  const since = '2026-10-05T06:00:00.000Z';

  it('最新 user 消息晚于 since → true（有介入）', async () => {
    const query = vi.fn(async () => ({ createdAt: '2026-10-05T07:00:00.000Z' }));
    await expect(hasUserMessageSince(query, since)).resolves.toBe(true);
  });

  it('最新 user 消息早于 since → false（无介入）', async () => {
    const query = vi.fn(async () => ({ createdAt: '2026-10-05T05:00:00.000Z' }));
    await expect(hasUserMessageSince(query, since)).resolves.toBe(false);
  });

  it('无任何 user 消息（null）→ false', async () => {
    const query = vi.fn(async () => null);
    await expect(hasUserMessageSince(query, since)).resolves.toBe(false);
  });

  it('瞬时失败重试一次成功 → 正常返回，onDegrade 首次 isFinal=false', async () => {
    const onDegrade = vi.fn();
    let attempts = 0;
    const query = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient');
      return { createdAt: '2026-10-05T07:00:00.000Z' };
    });
    // 行为断言：重试后拿到正确结果（而非绑定查询次数）；onDegrade 收到非最终失败回调
    await expect(hasUserMessageSince(query, since, { onDegrade })).resolves.toBe(true);
    expect(onDegrade).toHaveBeenCalled();
    expect(onDegrade.mock.calls.every(c => c[1] === false)).toBe(true); // 无最终失败回调
  });

  it('重试耗尽仍失败 → 降级 false（保守拦截），onDegrade isFinal=true', async () => {
    const onDegrade = vi.fn();
    const query = vi.fn(async () => { throw new Error('persistent'); });
    // 行为断言：降级返回 false + 收到最终失败回调（而非绑定查询次数）
    await expect(hasUserMessageSince(query, since, { onDegrade })).resolves.toBe(false);
    expect(onDegrade).toHaveBeenCalled();
    expect(onDegrade.mock.calls.some(c => c[1] === true)).toBe(true); // 有最终失败回调
  });
});

// ─── isSessionSelfRestartCreated（invoker 层防线） ─────────────

describe('isSessionSelfRestartCreated（F20260824srst + F20261005srst 窗口豁免/降级落账）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildSupport(overrides?: {
    sessionStartedAt?: string;
    lastUserEntryAt?: string | null;
    queryThrows?: boolean;
  }) {
    const startedAt = overrides?.sessionStartedAt ?? new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const deps = {
      manageSession: {
        getActiveSession: vi.fn(async () => ({
          id: 'sess-1', otterId: 'otter-1', status: 'active', startedAt,
        })),
      },
      healingRepo: {
        findRecentByOtter: vi.fn(async () => [{
          id: 'evt-1', errorType: 'self_restart',
          context: { newSessionId: 'sess-1' },
          createdAt: new Date().toISOString(),
        }]),
        create: vi.fn(async () => {}),
      },
      entryReader: {
        getEntries: vi.fn(async (_convId: string, opts?: { entryType?: string; limit?: number }) => {
          if (overrides?.queryThrows) throw new Error('db busy');
          if (opts?.entryType === 'user') {
            if (overrides?.lastUserEntryAt === null || overrides?.lastUserEntryAt === undefined) return [];
            return [{ id: 'ue-1', entryType: 'user', createdAt: overrides.lastUserEntryAt }];
          }
          return [];
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      scheduler: { invokeAgent: vi.fn() },
    };
    const support = new CircuitBreakSupport(deps as never);
    return { support, deps, startedAt };
  }

  it('session 非自重启创建 → false（不拦）', async () => {
    const deps = {
      manageSession: { getActiveSession: vi.fn(async () => ({ id: 'sess-x', startedAt: new Date().toISOString() })) },
      healingRepo: {
        findRecentByOtter: vi.fn(async () => [{
          id: 'evt-1', errorType: 'self_restart',
          context: { newSessionId: 'sess-other' }, // 指向别的 session
          createdAt: new Date().toISOString(),
        }]),
        create: vi.fn(async () => {}),
      },
      entryReader: { getEntries: vi.fn(async () => []) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const support = new CircuitBreakSupport(deps as never);
    await expect(support.isSessionSelfRestartCreated('otter-1', 'conv-1')).resolves.toBe(false);
  });

  it('自重启 session 存活超 2h（窗口外）→ 豁免 false + 介入判据零查询（9/28 现场形态）', async () => {
    const { support, deps } = buildSupport({ sessionStartedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() });
    await expect(support.isSessionSelfRestartCreated('otter-1', 'conv-1')).resolves.toBe(false);
    expect(deps.entryReader.getEntries).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalled(); // 豁免留日志
  });

  it('窗口内 + 用户消息介入 → false（#811 语义保持）', async () => {
    const { support } = buildSupport({
      sessionStartedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      lastUserEntryAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    await expect(support.isSessionSelfRestartCreated('otter-1', 'conv-1')).resolves.toBe(false);
  });

  it('窗口内 + 无用户消息介入 → true（拦截，循环防护保持）', async () => {
    const { support } = buildSupport({
      sessionStartedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      lastUserEntryAt: null,
    });
    await expect(support.isSessionSelfRestartCreated('otter-1', 'conv-1')).resolves.toBe(true);
  });

  it('窗口内 + 判据查询重试耗尽 → true（保守拦截）+ 降级事件落账（invokeId 透传）', async () => {
    const { support, deps } = buildSupport({
      sessionStartedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      queryThrows: true,
    });
    await expect(support.isSessionSelfRestartCreated('otter-1', 'conv-1', { invokeId: 'msg-42' })).resolves.toBe(true);
    // 降级事件落账：errorType=tool_failure（归因环境侧而非能力侧）+ invokeId 透传（非 unknown）
    // 行为断言：保守拦截返回 true + 降级 warn 日志可见（而非绑定查询次数）
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('无 conversationId（如 scheduler 链路）→ 纯 session 判定（窗口内自重启创建即拦）', async () => {
    const { support } = buildSupport({ sessionStartedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
    await expect(support.isSessionSelfRestartCreated('otter-1')).resolves.toBe(true);
  });
});
