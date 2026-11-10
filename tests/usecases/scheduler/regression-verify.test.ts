import { describe, it, expect, vi } from 'vitest';
import { extractAssertionDueDate } from '@usecases/scheduler/scheduler-service';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';

// ─── #1004：验证断言到期日期提取 ──────
// extractAssertionDueDate 是 regression-verify 任务的筛选核心：
// 从 closed daily-review issue 的 body 中定位「## 验证断言」段，提取「到期：YYYY-MM-DD」。
// 提取不到 → null（该 issue 不参与回查，prompt 层会提醒补写断言）。

describe('extractAssertionDueDate', () => {
  it('从标准断言段提取到期日期', () => {
    const body = [
      '## 问题',
      '某个问题描述',
      '',
      '## 验证断言',
      '- 断言：healing_events 中 errorType=X 连续 7 天为 0',
      '- 检查方式：sqlite3 查询 ...',
      '- 到期：2026-10-16',
      '',
      '## 其他',
    ].join('\n');
    expect(extractAssertionDueDate(body)).toBe('2026-10-16');
  });

  it('断言段在 body 末尾（无后续 ## 段）也能提取', () => {
    const body = '## 验证断言\n- 断言：某条件\n- 到期：2026-11-01\n';
    expect(extractAssertionDueDate(body)).toBe('2026-11-01');
  });

  it('支持中文冒号', () => {
    const body = '## 验证断言\n- 到期: 2026-10-20\n';
    expect(extractAssertionDueDate(body)).toBe('2026-10-20');
  });

  it('无断言段 → null', () => {
    expect(extractAssertionDueDate('## 问题\n没有断言段')).toBeNull();
  });

  it('断言段无到期行 → null', () => {
    const body = '## 验证断言\n- 断言：某条件\n- 检查方式：某方式\n';
    expect(extractAssertionDueDate(body)).toBeNull();
  });

  it('到期日期格式非法 → null', () => {
    const body = '## 验证断言\n- 到期：下个月\n';
    expect(extractAssertionDueDate(body)).toBeNull();
  });

  it('断言段后的其他段不影响提取', () => {
    const body = '## 验证断言\n- 到期：2026-10-16\n\n## 备注\n到期：2099-01-01\n';
    expect(extractAssertionDueDate(body)).toBe('2026-10-16');
  });
});

// ─── 检视发现 2/3：buildRegressionVerifyBody 失败路径与哨兵区分 ──────
// gh CLI 失败（auth 过期/网络）必须返回 REGRESSION_GH_FAILED 哨兵而非 null——
// 「gh 故障」与「真无到期断言」在调用方可区分，前者触发 warn 告警。
// 用 vi.mock 拦截 child_process 的 execFile，确定性模拟 gh 失败。

describe('buildRegressionVerifyBody gh 失败路径', () => {
  it('gh 执行失败时返回 REGRESSION_GH_FAILED 哨兵（非 null）', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFile: (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error) => void) => {
        // promisify 包装后回调签名 (err, stdout, stderr)
        if (cb) cb(new Error('gh: auth token expired'));
        return { on: () => {} };
      },
    }));
    const { buildRegressionVerifyBody, REGRESSION_GH_FAILED } = await import('@usecases/scheduler/scheduler-service');
    const result = await buildRegressionVerifyBody();
    expect(result).toBe(REGRESSION_GH_FAILED);
    vi.doUnmock('node:child_process');
  });
});

describe('#1779 buildRegressionVerifyBody 排除已回查 issue', () => {
  function fakeGh(issues: Array<Record<string, unknown>>, commentsByIssue: Record<number, Array<{ body: string }>>, failView = false) {
    const calls: string[][] = [];
    let active = 0;
    let maxActive = 0;
    const runGh = async (_command: string, args: string[]) => {
      calls.push(args);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await Promise.resolve();
        if (args[0] === 'issue' && args[1] === 'list') return { stdout: JSON.stringify(issues) };
        if (args[0] === 'issue' && args[1] === 'view') {
          if (failView) throw new Error('comments unavailable');
          return { stdout: JSON.stringify({ comments: commentsByIssue[Number(args[2])] ?? [] }) };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      } finally {
        active--;
      }
    };
    return { runGh, calls, get maxActive() { return maxActive; } };
  }

  const dueIssue = (number: number) => ({
    number, title: `issue-${number}`, closedAt: '2026-11-01T00:00:00Z',
    body: '## 验证断言\n- 断言：机制正常\n- 到期：2026-11-01',
  });

  it('完整 marker 绑定判定，最新 verdict 生效，gh 调用精确且顺序执行', async () => {
    const gh = fakeGh([
      dueIssue(101), dueIssue(102), dueIssue(103), dueIssue(104),
      dueIssue(105), dueIssue(106), dueIssue(107), dueIssue(108),
    ], {
      101: [{ body: '<!-- regression-verify: issue=101; verdict=pass; at=2026-11-04T00:00:00Z -->' }],
      102: [],
      103: [{ body: '<!-- regression-verify: issue=999; verdict=pass -->' }],
      104: [{ body: '<!-- regression-verify: issue=104; at=2026-11-04T00:00:00Z -->' }],
      105: [{ body: '<!-- regression-verify: issue=105; verdict=unknown -->；历史文字 verdict=pass 不算' }],
      106: [{ body: '<!-- regression-verify: issue=106; verdict=fail --> <!-- regression-verify: issue=999; verdict=pass -->' }],
      107: [{ body: '<!-- regression-verify: issue=107; verdict=pass --> <!-- regression-verify: issue=107; verdict=fail -->' }],
      108: [{ body: '<!-- regression-verify: issue=108; verdict=fail --> <!-- regression-verify: issue=108; verdict=pass -->' }],
    });
    const { buildRegressionVerifyBody } = await import('@usecases/scheduler/scheduler-service');
    const result = await buildRegressionVerifyBody(gh.runGh);
    expect(result).not.toContain('issue #101');
    expect(result).not.toContain('issue #108');
    for (const issue of [102, 103, 104, 105, 106, 107]) expect(result).toContain(`issue #${issue}`);
    expect(result).toContain('共 6 条');
    expect(gh.calls).toHaveLength(9);
    expect(gh.calls.filter(args => args[1] === 'view').map(args => Number(args[2])))
      .toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
    expect(gh.maxActive).toBe(1);
  });

  it('评论查询失败返回 GH_FAILED，不把查不到当未回查', async () => {
    const gh = fakeGh([dueIssue(101)], {}, true);
    const { buildRegressionVerifyBody, REGRESSION_GH_FAILED } = await import('@usecases/scheduler/scheduler-service');
    expect(await buildRegressionVerifyBody(gh.runGh)).toBe(REGRESSION_GH_FAILED);
    expect(gh.calls).toHaveLength(2);
  });
});

// ─── #1208：regression-verify 心跳可见性（REGRESSION_VERIFY_HEARTBEAT）──────
// 生产现场 9/18–9/29：任务每天触发但每天因「无到期断言」或「gh 故障」跳过，
// 既不落 execution 也无任何心跳——「活着但没活干」与「死了」在指标上不可区分。
// 心跳事件让 due-assertion skipped 状态可查询（24h 去重），GH_FAILED 独立事件不被压制。

describe('#1208 buildRegressionVerifyBody 心跳', () => {
  /** 最小任务实体：含 [regression-verify] 占位符即可进入心跳分支 */
  function makeRegressionTask(): ScheduledTask {
    return {
      id: 'task-reg',
      conversationId: 'conv-1',
      name: 'regression-verify',
      scheduleType: 'cron',
      cron: '0 11 * * *',
      triggerAt: null,
      timezone: 'Asia/Shanghai',
      body: '[regression-verify]',
      description: null,
      executorRole: '大獭',
      talkingStonePassedTo: ['otter-1'],
      senderId: 'otter-1',
      status: 'active',
      consecutiveFailures: 0,
      lastTriggeredAt: null,
      restartBeforeInvoke: true,
      timeoutMinutes: null,
      executorType: 'agent',
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    };
  }

  function makeHeartbeatRepo(openEvents: Array<Record<string, unknown>> = []) {
    const events: Array<Record<string, unknown>> = [];
    return {
      _events: events,
      create: vi.fn(async (e: Record<string, unknown>) => { events.push(e); }),
      findOpen: vi.fn(async () => openEvents),
      // #1208 发现 2：心跳写入即 resolved，去重查 resolved 池
      findAll: vi.fn(async (status: string) => status === 'resolved'
        ? openEvents.filter(e => e.status === 'resolved')
        : openEvents),
      autoStaleDismiss: vi.fn(async () => 0),
    };
  }

  it('无到期断言 skip → 落 HEARTBEAT 心跳事件（写入即 resolved，24h 内不重复落）', async () => {
    vi.resetModules();
    // gh 返回 closed issue 但均无断言段 → build 返 null（无到期断言路径）
    vi.doMock('node:child_process', () => ({
      execFile: (_cmd: string, _args: string[], _opts: unknown, cb?: (err: null, stdout: string) => void) => {
        if (cb) cb(null, JSON.stringify([{ number: 1, title: 't', body: '## 问题\n无断言段', closedAt: '2026-09-01T00:00:00Z' }]));
        return { on: () => {} };
      },
    }));
    const { buildRegressionVerifyHeartbeat } = await import('@usecases/scheduler/scheduler-service');
    const repo = makeHeartbeatRepo();
    const task = makeRegressionTask();

    // 首次 skip → 落 1 条心跳
    await buildRegressionVerifyHeartbeat(task, repo as never, 'no-due-assertions');
    expect(repo._events).toHaveLength(1);
    expect(String(repo._events[0].description)).toContain('回归验证心跳');
    expect(String(repo._events[0].description)).toContain('regression-verify');
    // #1208 发现 2：写入即 resolved（#751 先例），不进 open 池
    expect(repo._events[0].status).toBe('resolved');
    expect(repo._events[0].resolvedAt).toBeTruthy();

    // 24h 内再次 skip（同 reason，resolved 池能查到未过期心跳）→ 不重复落
    const recentResolved = [{
      errorType: 'other',
      status: 'resolved',
      context: { taskId: 'task-reg', reason: 'no-due-assertions', heartbeatAt: new Date().toISOString() },
    }];
    const repo2 = makeHeartbeatRepo(recentResolved);
    await buildRegressionVerifyHeartbeat(task, repo2 as never, 'no-due-assertions');
    expect(repo2._events).toHaveLength(0);
    vi.doUnmock('node:child_process');
  });

  it('超过 24h 的旧心跳不压制新心跳', async () => {
    const { buildRegressionVerifyHeartbeat } = await import('@usecases/scheduler/scheduler-service');
    const stale = [{
      errorType: 'other',
      status: 'resolved',
      context: { taskId: 'task-reg', reason: 'no-due-assertions', heartbeatAt: new Date(Date.now() - 25 * 3600_000).toISOString() },
    }];
    const repo = makeHeartbeatRepo(stale);
    await buildRegressionVerifyHeartbeat(makeRegressionTask(), repo as never, 'no-due-assertions');
    expect(repo._events).toHaveLength(1);
  });

  it('gh-cli-failure 与 no-due-assertions 是独立心跳（reason 不同不互压）', async () => {
    const { buildRegressionVerifyHeartbeat } = await import('@usecases/scheduler/scheduler-service');
    const existing = [{
      errorType: 'other',
      status: 'resolved',
      context: { taskId: 'task-reg', reason: 'no-due-assertions', heartbeatAt: new Date().toISOString() },
    }];
    const repo = makeHeartbeatRepo(existing);
    await buildRegressionVerifyHeartbeat(makeRegressionTask(), repo as never, 'gh-cli-failure');
    expect(repo._events).toHaveLength(1);
  });
});
