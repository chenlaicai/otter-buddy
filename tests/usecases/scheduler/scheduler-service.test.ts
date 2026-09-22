import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchedulerService, type CronParser } from '@usecases/scheduler/scheduler-service';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendEntry } from '@usecases/conversation/send-entry';
import type { EntryRepository } from '@usecases/conversation/entry-repository';
import type { AgentTurnPort } from '@usecases/ports/agent-turn-port';
import type { ManageScheduledTask, TaskChangeCallback } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { ManageSession } from '@usecases/otter/manage-session';
import { DomainError } from '@entities/errors';
import { SessionLockConflictError } from '@entities/errors';
import type { Logger } from '@usecases/ports/logger';
import type { DispatchChainEngine } from '@usecases/conversation/dispatch-chain-engine';

// ─── 辅助工具 ─────────────────────────────────────────────

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

/** 创建一个标准的 active 任务实体 */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    conversationId: 'conv-1',
    name: '每日问候',
    scheduleType: 'cron',
    cron: '0 9 * * *',
    triggerAt: null,
    timezone: 'Asia/Shanghai',
    body: '早上好！',
    description: null,
    talkingStonePassedTo: ['otter-1'],
    senderId: 'otter-1',
    status: 'active',
    consecutiveFailures: 0,
    lastTriggeredAt: null,
    restartBeforeInvoke: false,
    timeoutMinutes: null,
    executorType: 'agent',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── 状态化 Mock 工厂 ─────────────────────────────────────

/** 创建 ScheduledTaskRepository 的状态化 mock */
function createMockTaskRepo() {
  /** 存储所有任务（按 id 索引） */
  const store = new Map<string, ScheduledTask>();
  /** 存储执行记录（按 executionId 索引） */
  const executions = new Map<string, Record<string, unknown>>();
  /** 记录执行记录创建时的初始状态（用于断言创建时为 'running'） */
  const executionInitialStatuses = new Map<string, string>();
  /** 记录 updateStatus 调用（用于断言状态变更） */
  const statusUpdates: Array<{ id: string; status: string }> = [];
  /** claimTask 默认返回 true，可通过 _setClaimResult 控制 */
  let claimResult = true;
  /** 连续失败计数器 */
  let failureCount = 0;
  /** 记录 resetConsecutiveFailures 调用次数 */
  let resetCallCount = 0;

  return {
    _store: store,
    _executions: executions,
    _executionInitialStatuses: executionInitialStatuses,
    _statusUpdates: statusUpdates,
    _getFailureCount: () => failureCount,
    _getResetCallCount: () => resetCallCount,
    /** 设置 claimTask 返回值（用于模拟抢占失败） */
    _setClaimResult: (result: boolean) => { claimResult = result; },

    create: vi.fn(async (task: ScheduledTask) => {
      store.set(task.id, task);
    }),
    getById: vi.fn(async (id: string) => store.get(id) ?? null),
    getByConversationId: vi.fn(async (conversationId: string) => {
      return Array.from(store.values()).filter(t => t.conversationId === conversationId);
    }),
    getAllActive: vi.fn(async () => {
      return Array.from(store.values()).filter(t => t.status === 'active');
    }),
    update: vi.fn(async (task: ScheduledTask) => {
      store.set(task.id, { ...task });
    }),
    updateStatus: vi.fn(async (id: string, status: string) => {
      const task = store.get(id);
      if (task) {
        task.status = status as ScheduledTask['status'];
      }
      statusUpdates.push({ id, status });
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    incrementConsecutiveFailures: vi.fn(async () => {
      failureCount += 1;
      return failureCount;
    }),
    resetConsecutiveFailures: vi.fn(async () => {
      failureCount = 0;
      resetCallCount += 1;
    }),
    claimTask: vi.fn(async (id: string, lastTriggeredAt: string) => {
      // #640: 更新任务的 lastTriggeredAt 字段，防止轮询重复触发
      const task = store.get(id);
      if (task && claimResult) {
        task.lastTriggeredAt = lastTriggeredAt;
      }
      return claimResult;
    }),
    createExecution: vi.fn(async (execution: Record<string, unknown>) => {
      const id = execution.id as string;
      executions.set(id, { ...execution });
      // 记录创建时的初始状态
      executionInitialStatuses.set(id, execution.status as string);
    }),
    updateExecutionStatus: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const existing = executions.get(id);
      if (existing) {
        Object.assign(existing, updates);
      }
    }),
    getExecutions: vi.fn(async () => []),
    getExecutionCount: vi.fn(async () => 0),
    failAllRunningExecutions: vi.fn(async () => 0),
  };
}

/** 创建 ConversationRepository 的状态化 mock */
function createMockConvRepo() {
  /** 存储对话（按 id 索引） */
  const conversations = new Map<string, Record<string, unknown>>();

  return {
    _conversations: conversations,
    /** 注册一个对话 */
    _addConversation: (id: string, data: Record<string, unknown>) => {
      conversations.set(id, { id, ...data });
    },

    getById: vi.fn(async (id: string) => conversations.get(id) ?? null),
    getActiveTurn: vi.fn(async () => ({ id: 'turn-1' })),
    // 以下方法在 SchedulerService 中未使用，但需要满足接口
    create: vi.fn(),
    updateStatus: vi.fn(),
    getIdsByOtterId: vi.fn(),
    getAllIds: vi.fn(),
    getOtterIds: vi.fn(),
    createTurn: vi.fn(),
    closeTurn: vi.fn(),
    getMaxTurnNumber: vi.fn(),
    getMessagesByTurnId: vi.fn(),
    createCompletedMessage: vi.fn(),
    createStreamingMessage: vi.fn(),
    completeMessage: vi.fn(),
    failMessage: vi.fn(),
    abortMessage: vi.fn(),
    getMaxSequenceNum: vi.fn(),
    getMessageById: vi.fn(),
    getMessages: vi.fn(),
    getMessagesBefore: vi.fn(),
    getMessagesAfter: vi.fn(),
    getLatestMessagesAfter: vi.fn(),
    appendEvent: vi.fn(),
    getMessageEvents: vi.fn(),
    getMessageEventsByMessageIds: vi.fn(),
    getMaxEventSequenceNum: vi.fn(),
    searchMessages: vi.fn(),
    findByExternalId: vi.fn(async () => null),
    getTurnHistory: vi.fn(),
    linkResource: vi.fn(),
    getLinkedResources: vi.fn(),
    getLinkedResourceById: vi.fn(),
    getLinkedResourcesByGroup: vi.fn(),
    updateResourceStatus: vi.fn(),
    supersedeLinkedResource: vi.fn(),
    deleteLinkedResource: vi.fn(),
    flagResource: vi.fn(),
    createParticipant: vi.fn(),
    createParticipants: vi.fn(),
    getParticipant: vi.fn(),
    getActiveParticipants: vi.fn(),
    updateParticipantLeave: vi.fn(),
    updateTokenUsage: vi.fn(async () => {}),
    updateLastReadTurnNumber: vi.fn().mockResolvedValue(undefined),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getTurnById: vi.fn().mockResolvedValue(null),
    markParticipantLeft: vi.fn().mockResolvedValue(undefined),
    getLastMessageBySender: vi.fn().mockResolvedValue(null),
  };
}

/** 创建 SendEntry 的状态化 mock（F20260913ctlv 批2：scheduler 信号落 entries） */
function createMockSendEntry() {
  /** 已创建 system entry 计数 */
  let entryCount = 0;

  return {
    /** 获取已创建 entry 数 */
    _getEntryCount: () => entryCount,
    createSystemEntry: vi.fn(async () => {
      entryCount += 1;
      return { entry: { id: `entry-${entryCount}`, body: '早上好！',
    description: null, sequenceNum: entryCount } };
    }),
  };
}

/** 创建 EntryRepository 的状态化 mock（看门狗/记账校验数据源） */
function createMockEntryRepo() {
  /** entry 存储：id → entry（测试可预置锚点后产出） */
  const entries = new Map<string, { id: string; senderId: string | null; entryType: string; body: string | null; yieldTargets: string[] | null; metadata: Record<string, unknown> | null }>();

  return {
    _entries: entries,
    /** 预置一条 entry */
    _addEntry: (e: { id: string; senderId?: string | null; entryType?: string; body?: string | null; yieldTargets?: string[] | null; metadata?: Record<string, unknown> | null }) => {
      entries.set(e.id, { id: e.id, senderId: e.senderId ?? null, entryType: e.entryType ?? 'speak', body: e.body ?? null, yieldTargets: e.yieldTargets ?? null, metadata: e.metadata ?? null });
    },
    getEntryById: vi.fn(async (id: string) => entries.get(id) ?? null),
    getEntriesAfter: vi.fn(async (id: string, count: number) => {
      // 简化实现：锚点在 Map 中不存在时返回空（测试里按需 _addEntry 组装序列）
      const all = [...entries.values()];
      const idx = all.findIndex(e => e.id === id);
      if (idx === -1) return [];
      return all.slice(idx + 1, idx + 1 + count);
    }),
  };
}

/** 创建 AgentTurnPort 的状态化 mock */
function createMockAgentInvoke() {
  /** agent 调用是否应该失败 */
  let shouldFail = false;

  return {
    _setShouldFail: (fail: boolean) => { shouldFail = fail; },
    invokeConversation: vi.fn(async () => {
      if (shouldFail) {
        throw new Error('Agent invocation failed');
      }
      return { messageId: 'agent-msg-1', duration: 0 };
    }),
    abort: vi.fn(),
  };
}

/** 创建 CronParser 的状态化 mock */
function createMockCronParser(nextTime: Date, prevTime?: Date | null) {
  const callCount = { value: 0 };
  const state = { prevTime: prevTime ?? null };
  return {
    _callCount: callCount,
    /** #823 测试可变窗口：运行时对账用例需要在 start() 后推进 prevDue */
    set prevDue(v: Date | null) { state.prevTime = v; },
    getNextTime: vi.fn(() => {
      callCount.value++;
      return nextTime;
    }),
    // #814：调度完整性对账（可选——undefined 表示不支持，start() 跳过对账）
    ...(prevTime !== undefined ? { getPrevTime: vi.fn(() => state.prevTime) } : {}),
  };
}

/** 创建 ManageScheduledTask 的状态化 mock（仅用于 onChange 回调） */
function createMockManageScheduledTask() {
  const callbacks: TaskChangeCallback[] = [];

  return {
    _callbacks: callbacks,
    /** 手动触发 onChange 回调 */
    _emitChange: async (taskId: string, action: 'created' | 'updated' | 'deleted') => {
      for (const cb of callbacks) {
        cb(taskId, action);
      }
      // setImmediate 在 fake timer 环境中需要推进以执行异步回调
      await vi.advanceTimersByTimeAsync(0);
    },
    onChange: vi.fn((callback: TaskChangeCallback) => {
      callbacks.push(callback);
    }),
    create: vi.fn(),
    getById: vi.fn(),
    getByConversationId: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getExecutions: vi.fn(),
  };
}

// ─── 测试 ─────────────────────────────────────────────────

describe('SchedulerService - start/stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start()', () => {
    it('获取所有 active 任务并为每个任务调度定时器', async () => {
      // 准备：当前时间 8:00，两个 active 任务
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      // 下次触发时间设为 1 小时后
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      // 两个 active 任务，各自关联不同的对话
      taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
      taskRepo._store.set('task-2', makeTask({ id: 'task-2', conversationId: 'conv-2' }));

      // 注册对应的 active 对话（定时器触发时需要校验对话）
      convRepo._addConversation('conv-1', { status: 'active' });
      convRepo._addConversation('conv-2', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      await service.start();

      // 验证：cronParser 为每个任务都计算了下次触发时间
      expect(cronParser._callCount.value).toBe(2);

      // 推进 1 小时，定时器触发，两个任务各创建一个执行记录
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(taskRepo._executions.size).toBe(2);
      expect(taskRepo._executions.has('task-1') || taskRepo._executions.has('task-2')).toBe(false);
      // 执行记录的 key 是 executionId（UUID），不是 taskId，验证数量即可
    });

    it('延迟超过 24 小时时，定时器在 24 小时后触发（cap 到 24h）', async () => {
      // 准备：当前时间 8:00，任务的下次触发时间为 72 小时后
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      // 下次触发时间设为 72 小时后（远超 24h 限制）
      const nextTime = new Date('2025-06-18T08:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      await service.start();

      // #247 修复：24h 截断后只重新调度，不触发任务
      // 推进 23 小时：不应触发（delay 被 cap 到 24h）
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      expect(taskRepo._executions.size).toBe(0);

      // 再推进 1 小时（总计 24h）：不应触发任务，只重新调度
      await vi.advanceTimersByTimeAsync(1 * 60 * 60 * 1000);
      expect(taskRepo._executions.size).toBe(0);
      // cronParser 应被再次调用（重新调度）
      expect(cronParser._callCount.value).toBe(2);
    });

    it('#247 24h 截断后重新调度，到真实触发时间时正常触发', async () => {
      // 验证：24h 重新调度后，cronParser 被再次调用，任务仍然活着
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      // 下次触发时间设为 72 小时后
      const nextTime = new Date('2025-06-18T08:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      await service.start();

      // 推进 24h：触发重新调度
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(taskRepo._executions.size).toBe(0); // 不触发
      expect(cronParser._callCount.value).toBe(2); // 重新计算下次时间
    });

    it('没有 active 任务时，不调度任何定时器', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      await service.start();

      // 推进任意时间，不应产生任何执行记录
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(taskRepo._executions.size).toBe(0);
    });
  });

  describe('stop()', () => {
    it('清除所有定时器，之后定时器不再触发任务', async () => {
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      await service.start();

      // 停止调度器，清除所有定时器
      service.stop();

      // 推进 1 小时，不应触发任何任务
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(taskRepo._executions.size).toBe(0);
    });
  });
});

describe('SchedulerService - trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('trigger()', () => {
    it('任务存在且 active -> 创建执行记录、发送系统消息、调用 agent，最终执行完成', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      // 注册 active 任务和 active 对话
      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      const result = await service.trigger('task-1');

      // 验证返回了 executionId
      expect(result.executionId).toBeTruthy();

      // 验证执行记录创建时初始状态为 running
      expect(taskRepo._executionInitialStatuses.get(result.executionId)).toBe('running');

      // 验证执行记录最终状态为 completed（mock 通过 Object.assign 原地更新）
      const execution = taskRepo._executions.get(result.executionId);
      expect(execution).toBeTruthy();
      expect(execution!.taskId).toBe('task-1');
      expect(execution!.status).toBe('completed');

      // 验证发送了系统消息（消息计数从 0 变为 1）
      expect(sendEntry._getEntryCount()).toBe(1);

      // 验证连续失败计数被重置（说明成功流程执行了 resetConsecutiveFailures）
      expect(taskRepo._getResetCallCount()).toBe(1);
    });

    it('任务不存在 -> 抛出 DomainError（kind=not_found）', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      const err = await service.trigger('nonexistent').catch(e => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe('not_found');
    });

    it('任务非 active 状态 -> 抛出 DomainError（kind=validation）', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      // 注册 disabled 状态的任务
      taskRepo._store.set('task-1', makeTask({ status: 'disabled' }));

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      const err = await service.trigger('task-1').catch(e => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe('validation');
    });
  });

  describe('任务抢占（claimTask）', () => {
    it('claimTask 返回 false -> 抛出 validation 错误，不创建执行记录，不发送消息', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      // 模拟抢占失败（任务已被其他实例触发）
      taskRepo._setClaimResult(false);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      const err = await service.trigger('task-1').catch(e => e);

      // 应抛出 validation 错误
      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe('validation');

      // 不应创建执行记录
      expect(taskRepo._executions.size).toBe(0);

      // 不应发送消息（计数应为 0）
      expect(sendEntry._getEntryCount()).toBe(0);
    });
  });

  describe('对话校验', () => {
    it('对话不存在 -> 自动禁用任务并抛出 validation 错误', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      // 不注册对话 -> getById 返回 null

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      const err = await service.trigger('task-1').catch(e => e);

      // 应抛出 validation 错误
      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe('validation');

      // 任务应被禁用
      expect(taskRepo._statusUpdates).toHaveLength(1);
      expect(taskRepo._statusUpdates[0]).toEqual({ id: 'task-1', status: 'disabled' });

      // 不应创建执行记录
      expect(taskRepo._executions.size).toBe(0);
    });

    it('对话状态非 active -> 自动禁用任务并抛出 validation 错误', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      // 对话状态为 archived
      convRepo._addConversation('conv-1', { status: 'archived' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      const err = await service.trigger('task-1').catch(e => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe('validation');

      // 任务应被禁用
      expect(taskRepo._statusUpdates).toHaveLength(1);
      expect(taskRepo._statusUpdates[0]).toEqual({ id: 'task-1', status: 'disabled' });

      // 不应创建执行记录
      expect(taskRepo._executions.size).toBe(0);
    });
  });
});

describe('SchedulerService - error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Agent 调用超时（5 分钟）', () => {
    it('agent 调用失败 -> 记录失败执行并增加连续失败计数', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      // 模拟 agent 调用抛出错误（超时或网络异常等失败场景均走同一路径）
      agentInvoke._setShouldFail(true);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      const err = await service.trigger('task-1').catch(e => e);

      // 错误应被捕获并向上抛出
      expect(err).toBeInstanceOf(Error);

      // 执行记录应标记为 failed
      const executions = Array.from(taskRepo._executions.values());
      expect(executions).toHaveLength(1);
      expect(executions[0].status).toBe('failed');
      expect(executions[0].errorMessage).toBeTruthy();

      // 连续失败计数应增加到 1
      expect(taskRepo._getFailureCount()).toBe(1);
    });
  });

  describe('连续失败处理', () => {
    it('连续 3 次失败 -> 任务状态变为 error', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      // 模拟 agent 调用失败
      agentInvoke._setShouldFail(true);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      // 连续触发 3 次
      for (let i = 0; i < 3; i++) {
        await service.trigger('task-1').catch(() => {});
      }

      // 验证：任务状态应被设为 error
      const errorUpdate = taskRepo._statusUpdates.find(u => u.status === 'error');
      expect(errorUpdate).toBeTruthy();
      expect(errorUpdate!.id).toBe('task-1');
    });

    it('失败次数未达 3 次 -> 任务保持 active 状态', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      // 模拟 agent 调用失败
      agentInvoke._setShouldFail(true);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      // 只触发 2 次
      for (let i = 0; i < 2; i++) {
        await service.trigger('task-1').catch(() => {});
      }

      // 不应有 error 状态更新
      const errorUpdate = taskRepo._statusUpdates.find(u => u.status === 'error');
      expect(errorUpdate).toBeUndefined();
    });
  });
});

describe('#913: catch-up 前置阶段炸点落 healing（claim 后 execution 建立前）', () => {
  function makeHealingRepo() {
    const events: Array<Record<string, unknown>> = [];
    return {
      _events: events,
      create: vi.fn(async (e: Record<string, unknown>) => { events.push(e); }),
      findOpen: vi.fn(async () => []),
      autoStaleDismiss: vi.fn(async () => 0),
    };
  }

  function makePreExecService(healingRepo: ReturnType<typeof makeHealingRepo>, taskRepoOverrides?: Record<string, unknown>) {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const cronParser = createMockCronParser(new Date(Date.now()));
    taskRepo._store.set('task-x', makeTask({
      id: 'task-x',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      lastTriggeredAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    } as never));
    convRepo._addConversation('conv-1', { status: 'active' });
    // createExecution 炸点模拟（#912 修复前的 FK 现场同构）：INSERT 抛 SqliteError 型异常
    const original = taskRepo.createExecution;
    (taskRepo as Record<string, unknown>).createExecution = vi.fn(async () => {
      throw new Error('SqliteError: no such table: main.messages');
    });
    void original;
    Object.assign(taskRepo, taskRepoOverrides ?? {});
    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });
    return { service, taskRepo };
  }

  it('createExecution 抛错（claim 后、execution 前）→ 落 medium healing 且无 execution 行', async () => {
    const healingRepo = makeHealingRepo();
    const { service } = makePreExecService(healingRepo);

    // start 不 rethrow（tick 内 logger.error 消化——这正是 #913 静默问题的形态）；
    // 等待 tick 微任务链完成后再断言 healing
    await service.start();
    await new Promise(r => setTimeout(r, 50));
    service.stop();

    // 核心断言：前置炸点落 healing（#913 修复前为零痕迹）。mock cronParser 无间隔控制，
    // 50ms 窗口内 tick 多轮触发多份（每轮独立落账，生产场景由真实 cron 间隔自然隔开）——
    // 断言「存在且全部为前置炸点形态」而非条数
    const preEvents = healingRepo._events.filter(ev => (ev.context as Record<string, unknown>)?.stage === 'pre-execution');
    expect(preEvents.length).toBeGreaterThanOrEqual(1);
    const e = preEvents[0]!;
    expect(e.severity).toBe('medium');
    expect(e.errorType).toBe('other');
    expect((e.context as Record<string, unknown>).taskId).toBe('task-x');
    expect((e.context as Record<string, unknown>).stage).toBe('pre-execution');
    expect(String((e.context as Record<string, unknown>).triggerError)).toContain('no such table');
  });

  it('claim 被拒（running execution 存在）→ 正常跳过，不落前置 healing', async () => {
    const healingRepo = makeHealingRepo();
    const taskRepo = createMockTaskRepo();
    taskRepo._store.set('task-y', makeTask({
      id: 'task-y', scheduleType: 'cron', cron: '0 9 * * *',
      lastTriggeredAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    } as never));
    // claim 拒绝：已有未超时 running execution
    (taskRepo as Record<string, unknown>).getExecutions = vi.fn(async () => [
      { id: 'exec-running', status: 'running', triggeredAt: new Date().toISOString() },
    ]);
    const convRepo = createMockConvRepo();
    convRepo._addConversation('conv-1', { status: 'active' });
    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: createMockSendEntry() as unknown as SendEntry,
      entryRepo: createMockEntryRepo() as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: createMockCronParser(new Date(Date.now())) as unknown as CronParser,
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });
    await service.start();
    await new Promise(r => setTimeout(r, 50));
    service.stop();

    // claim 被拒是正常跳过（skipped），不得落前置 healing
    expect(healingRepo._events.filter(ev => (ev.context as Record<string, unknown>)?.stage === 'pre-execution')).toHaveLength(0);
  });
});

// #929 边界系列公共 helper（模块级，避免 describe 回调超 max-lines）：按 offsetMs 构造 lastTriggeredAt 跑一轮对账，返回落账事件数
async function runReconcileEdge(prevDue: Date, offsetMs: number): Promise<number> {
  const taskRepo = createMockTaskRepo();
  const convRepo = createMockConvRepo();
  const sendEntry = createMockSendEntry();
  const entryRepo = createMockEntryRepo();
  const cronParser = createMockCronParser(new Date(Date.now()), prevDue);
  const events: Array<Record<string, unknown>> = [];
  const healingRepo = {
    _events: events,
    create: vi.fn(async (e: Record<string, unknown>) => { events.push(e); }),
    findOpen: vi.fn(async () => events.map(e => ({ errorType: e.errorType, context: e.context }))),
    autoStaleDismiss: vi.fn(async () => 0),
  };

  taskRepo._store.set(`task-edge-${offsetMs}`, makeTask({
    id: `task-edge-${offsetMs}`,
    scheduleType: 'cron',
    cron: '0 9 * * *',
    lastTriggeredAt: new Date(prevDue.getTime() - offsetMs).toISOString(),
  } as never));
  convRepo._addConversation('conv-1', { status: 'active' });

  const service = new SchedulerService({
    taskRepo: taskRepo as unknown as ScheduledTaskRepository,
    convRepo: convRepo as unknown as ConversationRepository,
    sendEntry: sendEntry as unknown as SendEntry,
    entryRepo: entryRepo as unknown as EntryRepository,
    agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
    cronParser: cronParser as unknown as CronParser,
    logger: mockLogger,
    healingRepo: healingRepo as never,
  });
  await service.start();
  await service.stop();
  return healingRepo._events.length;
}

describe('#814: 调度完整性对账（启动时错过窗口落 healing）', () => {
  function makeHealingRepo() {
    const events: Array<Record<string, unknown>> = [];
    return {
      _events: events,

      create: vi.fn(async (e: Record<string, unknown>) => { events.push(e); }),
      findOpen: vi.fn(async () => events.map(e => ({ errorType: e.errorType, context: e.context }))),
      autoStaleDismiss: vi.fn(async () => 0),
    };
  }

  it('lastTriggeredAt 落后于应触发时间 → 落 low 级 healing 事件', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    // 应触发时间 = 昨天；任务 lastTriggeredAt = 前天（错过窗口）
    const prevDue = new Date(Date.now() - 24 * 3600_000);
    const cronParser = createMockCronParser(new Date(Date.now()), prevDue);
    const healingRepo = makeHealingRepo();

    taskRepo._store.set('task-missed', makeTask({
      id: 'task-missed',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      lastTriggeredAt: new Date(Date.now() - 48 * 3600_000).toISOString(), // 早于 prevDue
    } as never));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });
    await service.start();
    await service.stop();

    expect(healingRepo._events).toHaveLength(1);
    const e = healingRepo._events[0]!;
    expect(e.severity).toBe('low');
    expect(e.errorType).toBe('other');
    expect((e.context as Record<string, unknown>).taskId).toBe('task-missed');
    expect((e.context as Record<string, unknown>).missedWindowAt).toBe(prevDue.toISOString());
  });

  it('lastTriggeredAt 不落后 → 零事件（无错过）', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const prevDue = new Date(Date.now() - 24 * 3600_000);
    const cronParser = createMockCronParser(new Date(Date.now()), prevDue);
    const healingRepo = makeHealingRepo();

    taskRepo._store.set('task-ok', makeTask({
      id: 'task-ok',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      lastTriggeredAt: new Date(prevDue.getTime() + 1000).toISOString(), // 已触发当次窗口
    } as never));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });
    await service.start();
    await service.stop();

    expect(healingRepo._events).toHaveLength(0);
  });

  it('#929 回归：lastTriggeredAt 比窗口早 0.3-1.6s（准时触发抖动）→ 不误报', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const prevDue = new Date(Date.now() - 3600_000);
    const cronParser = createMockCronParser(new Date(Date.now()), prevDue);
    const healingRepo = makeHealingRepo();

    // 现场同构：lastTriggeredAt 仅早窗口 0.645s（9/15 误报 5 条之一）
    taskRepo._store.set('task-jitter', makeTask({
      id: 'task-jitter',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      lastTriggeredAt: new Date(prevDue.getTime() - 645).toISOString(),
    } as never));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });
    await service.start();
    await service.stop();

    expect(healingRepo._events).toHaveLength(0); // 抖动在 5s 容差内
  });

  it('#929 回归：lastTriggeredAt 早窗口超 5s（真错过）→ 仍落账', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const prevDue = new Date(Date.now() - 3600_000);
    const cronParser = createMockCronParser(new Date(Date.now()), prevDue);
    const healingRepo = makeHealingRepo();

    taskRepo._store.set('task-real-miss', makeTask({
      id: 'task-real-miss',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      lastTriggeredAt: new Date(Date.now() - 48 * 3600_000).toISOString(), // 早超过一天，真错过
    } as never));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });
    await service.start();
    await service.stop();

    expect(healingRepo._events).toHaveLength(1);
  });

  it('#929 边界：精确 5s 边界锁定（4999ms/5000ms 容差内，5001ms 刚出容差）', async () => {
    // 边界数学：reference >= prevDue - 5_000
    // - 早 4999ms：(P-4999) >= (P-5000) 成立 → 容差内
    // - 早 5000ms：(P-5000) >= (P-5000) 成立（>= 含边界）→ 容差内
    //   （防重构把 >= 改成 > 时，本用例拦截：5000ms 会变误报）
    // - 早 5001ms：(P-5001) >= (P-5000) 不成立 → 错过（防边界被悄然扩大/缩小）
    const prevDue = new Date(Date.now() - 3600_000);

    expect(await runReconcileEdge(prevDue, 4999)).toBe(0);
    expect(await runReconcileEdge(prevDue, 5000)).toBe(0);
    expect(await runReconcileEdge(prevDue, 5001)).toBe(1);
  });

  it('重复重启去重：同一错过窗口已落 open 事件 → 不重复落账', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const prevDue = new Date(Date.now() - 24 * 3600_000);
    const cronParser = createMockCronParser(new Date(Date.now()), prevDue);
    const healingRepo = makeHealingRepo();

    taskRepo._store.set('task-missed', makeTask({
      id: 'task-missed',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      lastTriggeredAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
    } as never));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });

    // 第一次 start → 落账 1 条
    await service.start();
    await service.stop();
    expect(healingRepo._events).toHaveLength(1);

    // 第二次 start（模拟重启）→ 去重命中，不再落账
    // mock findOpen 返回第一次落的事件（errorType=other + context.taskId/missedWindowAt）
    healingRepo.findOpen = vi.fn(async () => healingRepo._events.map(e => ({
      errorType: e.errorType, context: e.context,
    })));
    await service.start();
    await service.stop();
    expect(healingRepo._events).toHaveLength(1);
  });

  it('cronParser 不支持 getPrevTime（旧实现）→ 跳过对账不报错', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const healingRepo = makeHealingRepo();
    taskRepo._store.set('task-legacy', makeTask({ id: 'task-legacy' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: createMockCronParser(new Date()) as unknown as CronParser, // 无 getPrevTime
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });
    await service.start();
    await service.stop();

    expect(healingRepo._events).toHaveLength(0);
  });
});

describe('SchedulerService - onChange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('onChange 集成', () => {
    it('created 事件 -> 为新任务调度定时器，到时触发执行', async () => {
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);
      const manageScheduledTask = createMockManageScheduledTask();

      // 注册任务和对应的 active 对话
      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        manageScheduledTask: manageScheduledTask as unknown as ManageScheduledTask,
      });

      // 模拟 onChange 发出 created 事件
      await manageScheduledTask._emitChange('task-1', 'created');

      // 验证：cronParser 被调用以计算下次触发时间
      expect(cronParser._callCount.value).toBeGreaterThanOrEqual(1);

      // 推进到触发时间（1 小时后）
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // 验证任务被触发（产生了执行记录）
      expect(taskRepo._executions.size).toBe(1);
    });

    it('deleted 事件 -> 清除对应任务的定时器，不再触发', async () => {
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);
      const manageScheduledTask = createMockManageScheduledTask();

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        manageScheduledTask: manageScheduledTask as unknown as ManageScheduledTask,
      });

      // 先通过 created 事件调度任务
      await manageScheduledTask._emitChange('task-1', 'created');

      // 然后发出 deleted 事件，清除定时器
      await manageScheduledTask._emitChange('task-1', 'deleted');

      // 推进到原定触发时间
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // 验证：任务不应被触发（没有执行记录）
      expect(taskRepo._executions.size).toBe(0);
    });

    it('updated 事件 -> 清除旧定时器并重新调度任务', async () => {
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      // 第一次（created）触发时间在 2 小时后
      const nextTime1 = new Date('2025-06-15T10:00:00.000Z');
      // 第二次（updated）触发时间在 1 小时后
      const nextTime2 = new Date('2025-06-15T09:00:00.000Z');

      // cronParser 随调用次数返回不同的下次时间
      let cronCallCount = 0;
      const cronParser: CronParser = {
        getNextTime: vi.fn(() => {
          cronCallCount += 1;
          return cronCallCount <= 1 ? nextTime1 : nextTime2;
        }),
      };
      const manageScheduledTask = createMockManageScheduledTask();

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        manageScheduledTask: manageScheduledTask as unknown as ManageScheduledTask,
      });

      // 先通过 created 事件调度任务（触发时间 2 小时后）
      await manageScheduledTask._emitChange('task-1', 'created');

      // 发出 updated 事件（清除旧定时器，重新计算触发时间为 1 小时后）
      await manageScheduledTask._emitChange('task-1', 'updated');

      // 推进 1 小时（updated 后的新触发时间）
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // 验证：任务在新时间点被触发（产生了执行记录）
      expect(taskRepo._executions.size).toBe(1);
    });
  });

  // once 任务调度测试已移至独立 describe 块
});

describe('SchedulerService - once 任务调度', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("once 任务调度", () => {
    it("once 任务 triggerAt 在未来 -> setTimeout 调度", async () => {
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      taskRepo._store.set('task-1', makeTask({
        scheduleType: 'once',
        triggerAt: '2025-06-15T09:00:00.000Z',
        cron: '',
      }));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: { getNextTime: () => new Date() } as unknown as CronParser,
        logger: mockLogger,
      });

      // 启动调度器，触发 start() -> scheduleNext() -> scheduleOnce()
      await service.start();

      // 推进 1 小时到触发时间
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // 验证任务被触发并删除（一次性任务触发后不保留）
      expect(taskRepo._executions.size).toBe(1);
      expect(taskRepo._store.has('task-1')).toBe(false);
    });

    it("once 任务 triggerAt 已过期 -> 立即 disabled，不触发", async () => {
      const now = new Date('2025-06-15T10:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      // triggerAt 在过去
      taskRepo._store.set('task-1', makeTask({
        scheduleType: 'once',
        triggerAt: '2025-06-15T09:00:00.000Z',
        cron: '',
      }));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: { getNextTime: () => new Date() } as unknown as CronParser,
        logger: mockLogger,
      });

      // 启动调度器，触发 start() -> scheduleNext() -> scheduleOnce()
      await service.start();

      // scheduleOnce 中的 updateStatus 是 .then()/.catch() 调用（fire-and-forget）
      // flush 微任务队列让 Promise resolve
      await Promise.resolve();
      await Promise.resolve();

      // 验证：已过期的一次性任务被删除，未产生执行记录
      expect(taskRepo._store.has('task-1')).toBe(false);
      expect(taskRepo._executions.size).toBe(0);
    });

    it("once 任务触发失败 -> 重试成功 -> disabled", async () => {
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      taskRepo._store.set('task-1', makeTask({
        scheduleType: 'once',
        triggerAt: '2025-06-15T09:00:00.000Z',
        cron: '',
      }));
      convRepo._addConversation('conv-1', { status: 'active' });

      // 第一次 invoke 失败，第二次成功
      let invokeCount = 0;
      agentInvoke.invokeConversation = vi.fn(async () => {
        invokeCount++;
        if (invokeCount === 1) throw new Error('agent invoke failed');
        return { messageId: 'msg-1', duration: 0 };
      });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: { getNextTime: () => new Date() } as unknown as CronParser,
        logger: mockLogger,
      });

      await service.start();

      // 推进到触发时间
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      // 推进重试延迟（65s）
      await vi.advanceTimersByTimeAsync(65_000);

      // 验证：invoke 被调用 2 次（首次 + 1 次重试），任务被删除（重试成功后不保留）
      expect(invokeCount).toBe(2);
      expect(taskRepo._store.has('task-1')).toBe(false);
    });

    it("once 任务重试全部失败 -> 标记 error（#246 修复：所有重试均执行）", async () => {
      const now = new Date('2025-06-15T08:00:00.000Z');
      vi.setSystemTime(now);

      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      taskRepo._store.set('task-1', makeTask({
        scheduleType: 'once',
        triggerAt: '2025-06-15T09:00:00.000Z',
        cron: '',
      }));
      convRepo._addConversation('conv-1', { status: 'active' });

      // 所有 invoke 都失败
      agentInvoke.invokeConversation = vi.fn(async () => {
        throw new Error('agent invoke failed');
      });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: { getNextTime: () => new Date() } as unknown as CronParser,
        logger: mockLogger,
      });

      await service.start();

      // 推进到触发时间
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      // 推进 3 次重试延迟（65s × 3）
      await vi.advanceTimersByTimeAsync(65_000 * 3);
      // flush 微任务
      await Promise.resolve();
      await Promise.resolve();

      // 验证：任务标记 error（而非 disabled）
      // #246 修复后：所有重试均执行，由 triggerOnceWithRetry 标记 error
      expect(taskRepo._statusUpdates.some(u => u.status === 'error')).toBe(true);
      expect(taskRepo._statusUpdates.some(u => u.status === 'disabled')).toBe(false);
    });

    it("#251 resetConsecutiveFailures 失败不覆写已 completed 的 execution", async () => {
      // #251: completeExecution 之后 resetConsecutiveFailures 抛 DB 错时，
      // 不应走 handleExecutionFailure 覆写已 completed 的 execution record。
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      // 模拟 resetConsecutiveFailures 抛 DB 错（如 SQLite locked）
      taskRepo.resetConsecutiveFailures = vi.fn(async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: { getNextTime: () => new Date('2025-06-15T09:00:00.000Z') } as unknown as CronParser,
        logger: mockLogger,
      });

      // trigger 应成功返回（不抛错）
      const result = await service.trigger('task-1');
      expect(result.executionId).toBeTruthy();

      // execution record 应为 completed（不被覆写为 failed）
      const execution = taskRepo._executions.get(result.executionId);
      expect(execution).toBeTruthy();
      expect(execution!.status).toBe('completed');

      // #251 核心验证：trigger 成功返回且 execution 为 completed，
      // 说明 resetConsecutiveFailures 的错误被吞掉，不影响成功语义。
    });
  });
});

describe('SchedulerService - restartBeforeInvoke', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T08:59:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call manageSession.restartSession before invoking agent when restartBeforeInvoke=true', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    taskRepo._store.set('task-1', makeTask({ restartBeforeInvoke: true, cron: '0 9 * * *' }));
    convRepo._addConversation('conv-1', { status: 'active' });
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    let restartCalled = false;
    let invokeCalled = false;
    const mockManageSession = {
      restartSession: vi.fn(async () => {
        restartCalled = true;
        return { id: 'new-session-id' };
      }),
    };
    agentInvoke.invokeConversation.mockImplementation(async () => {
      invokeCalled = true;
      return { messageId: 'msg-1', duration: 0 };
    });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: { getNextTime: () => new Date('2025-01-15T09:00:00.000Z') } as unknown as CronParser,
      logger: mockLogger,
      manageSession: mockManageSession as unknown as ManageSession,
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await Promise.resolve();

    // 断言副作用：restart 和 invoke 都被调用
    expect(restartCalled).toBe(true);
    expect(invokeCalled).toBe(true);
  });

  it('should not call restartSession when restartBeforeInvoke=false', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    taskRepo._store.set('task-1', makeTask({ restartBeforeInvoke: false, cron: '0 9 * * *' }));
    convRepo._addConversation('conv-1', { status: 'active' });
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    let restartCalled = false;
    const mockManageSession = {
      restartSession: vi.fn(async () => {
        restartCalled = true;
        return { id: 'new-session-id' };
      }),
    };

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: { getNextTime: () => new Date('2025-01-15T09:00:00.000Z') } as unknown as CronParser,
      logger: mockLogger,
      manageSession: mockManageSession as unknown as ManageSession,
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await Promise.resolve();

    expect(restartCalled).toBe(false);
    expect(agentInvoke.invokeConversation).toHaveBeenCalled();
  });

  it('should log warning when manageSession not injected and restartBeforeInvoke=true', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    taskRepo._store.set('task-1', makeTask({ restartBeforeInvoke: true, cron: '0 9 * * *' }));
    convRepo._addConversation('conv-1', { status: 'active' });
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: { getNextTime: () => new Date('2025-01-15T09:00:00.000Z') } as unknown as CronParser,
      logger: mockLogger,
      // manageSession not injected
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await Promise.resolve();

    // 断言日志输出：manageSession 未注入时应有 warning
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(agentInvoke.invokeConversation).toHaveBeenCalled();
  });

  it('should handle concurrent restarts when multiple tasks trigger simultaneously', async () => {
    const task1 = makeTask({ id: 'task-1', restartBeforeInvoke: true, cron: '0 9 * * *' });
    const task2 = makeTask({ id: 'task-2', restartBeforeInvoke: true, cron: '0 9 * * *', name: '午间检查' });
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    taskRepo._store.set('task-1', task1);
    taskRepo._store.set('task-2', task2);
    convRepo._addConversation('conv-1', { status: 'active' });
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const restartCallIds: string[] = [];
    const mockManageSession = {
      restartSession: vi.fn(async () => {
        restartCallIds.push(crypto.randomUUID());
        return { id: 'new-session-id' };
      }),
    };

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: { getNextTime: () => new Date('2025-01-15T09:00:00.000Z') } as unknown as CronParser,
      logger: mockLogger,
      manageSession: mockManageSession as unknown as ManageSession,
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    // flush 微任务让两个任务的异步操作完成
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 断言：两个任务都触发了 restart，且 invoke 也被调用
    expect(restartCallIds.length).toBeGreaterThanOrEqual(2);
    expect(agentInvoke.invokeConversation).toHaveBeenCalled();
  });
});

// ─── #332: 链外 invoke 路径走 DispatchChainEngine 续跑发言链 ────────────

describe('#332: dispatchChainEngine 注入后 invokeAgentWithTimeout 走链引擎', () => {
  function createMockDispatchChainEngine() {
    return {
      executeChain: vi.fn(async () => ({ otterReply: 'chain reply' })),
    };
  }

  it('注入 dispatchChainEngine 后，触发任务走 executeChain 而非直接 invoke', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());
    const dispatchChainEngine = createMockDispatchChainEngine();

    const task = makeTask({
      id: 'task-chain',
      conversationId: 'conv-chain',
      talkingStonePassedTo: ['otter-1', 'otter-2'],
      senderId: 'boss',
      body: '问候',
    });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-chain', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      dispatchChainEngine: dispatchChainEngine as unknown as DispatchChainEngine,
    });

    // 直接调用 trigger 走完整 triggerTask 流程
    const result = await service.trigger('task-chain');
    expect(result.executionId).toBeTruthy();

    // 链引擎被调用：initialTargets 包含全部 talkingStonePassedTo
    const calls = (dispatchChainEngine.executeChain as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const callArg = calls[0][0];
    expect(callArg.conversationId).toBe('conv-chain');
    expect(callArg.initialTargets).toEqual(['otter-1', 'otter-2']);
    expect(callArg.senderId).toBe('boss');

    // 直接 invoke 未被调用（链引擎接管）
    expect((agentInvoke.invokeConversation as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // 执行记录最终状态为 completed
    const execution = taskRepo._executions.get(result.executionId);
    expect(execution!.status).toBe('completed');
  });

  it('未注入 dispatchChainEngine 时，降级为直接 invoke（兼容旧行为）', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    const task = makeTask({
      id: 'task-fallback',
      conversationId: 'conv-fallback',
      talkingStonePassedTo: ['otter-1'],
      senderId: 'boss',
      body: '问候',
    });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-fallback', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      // 不注入 dispatchChainEngine
    });

    const result = await service.trigger('task-fallback');
    expect(result.executionId).toBeTruthy();

    // 降级：直接 invoke 被调用
    const calls = (agentInvoke.invokeConversation as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0].otterId).toBe('otter-1');

    // 执行记录最终状态为 completed
    const execution = taskRepo._executions.get(result.executionId);
    expect(execution!.status).toBe('completed');
  });

  it('dispatchChainEngine.executeChain 失败时 execution 标记为 failed', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    // 模拟链引擎抛出错误
    const dispatchChainEngine = {
      executeChain: vi.fn(async () => { throw new Error('Chain engine failed'); }),
    };

    const task = makeTask({
      id: 'task-chain-fail',
      conversationId: 'conv-chain-fail',
      talkingStonePassedTo: ['otter-1'],
      senderId: 'boss',
      body: '问候',
    });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-chain-fail', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      dispatchChainEngine: dispatchChainEngine as unknown as DispatchChainEngine,
    });

    const err = await service.trigger('task-chain-fail').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Chain engine failed');

    // 链引擎被调用，直接 invoke 未被调用
    expect((dispatchChainEngine.executeChain as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((agentInvoke.invokeConversation as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // execution 标记为 failed
    const execs = [...taskRepo._executions.values()];
    expect(execs.length).toBeGreaterThanOrEqual(1);
    const lastExec = execs[execs.length - 1];
    expect(lastExec.status).toBe('failed');
  });
});

// ─── #516/#517: 链看门狗 + 记账校验 + error 通知 ────────────────────

describe('#516: 任务级超时配置（timeoutMinutes）', () => {
  it('create 时 timeoutMinutes 传入并持久化，校验非法值抛 DomainError', async () => {
    // 实体层校验函数单测见 tests/entities/scheduled-task/scheduled-task.test.ts
    // 此处验证 scheduler 链路取值：timeoutMinutes=1 → 静默窗 1 分钟
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    // 链 promise 永不 settle（模拟长编排任务）
    let neverResolve: (v: unknown) => void = () => {};
    const dispatchChainEngine = {
      executeChain: vi.fn(() => new Promise(r => { neverResolve = r; })),
    };

    const task = makeTask({
      id: 'task-silence',
      timeoutMinutes: 1,
      talkingStonePassedTo: ['otter-1'],
    });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });
    // 静默探测：锚点后无新消息 → 1 分钟静默窗后判死
    (convRepo.getMessagesAfter as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      dispatchChainEngine: dispatchChainEngine as unknown as DispatchChainEngine,
    });

    vi.useFakeTimers();
    try {
      const triggerPromise = service.trigger('task-silence');
      const errPromise = triggerPromise.catch(e => e);
      // 推进 1 分钟静默窗（timeoutMinutes=1）→ 探测无新消息 → 判死
      await vi.advanceTimersByTimeAsync(61_000);
      const err = await errPromise;

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Agent invocation timeout');
    } finally {
      vi.useRealTimers();
      neverResolve(undefined); // 清理
    }
  });

  it('链活跃（静默窗内有新消息）→ 不误杀，续期等待', async () => {
    vi.useFakeTimers();
    try {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const cronParser = createMockCronParser(new Date());

      // 链在 2 个静默窗后正常 settle（模拟 8-26 现场跑了 16h 的长链）
      let resolveChain: (v: { otterReply?: string }) => void = () => {};
      const dispatchChainEngine = {
        executeChain: vi.fn(() => new Promise(r => { resolveChain = r; })),
      };

      const task = makeTask({ id: 'task-alive', timeoutMinutes: 1 });
      taskRepo._store.set(task.id, task);
      convRepo._addConversation('conv-1', { status: 'active' });

      // 每次探测都返回一条新 entry（链活跃；F20260913ctlv 批2 切 entries）
      const activeEntry = {
        id: 'e-new', senderId: 'otter-1', entryType: 'speak', body: '产出',
        yieldTargets: null, metadata: null,
      };
      (entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mockResolvedValue([activeEntry]);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        dispatchChainEngine: dispatchChainEngine as unknown as DispatchChainEngine,
      });

      const triggerPromise = service.trigger('task-alive');

      // 推进 3 个静默窗（链一直活跃续期），第 3 窗中段链 settle
      await vi.advanceTimersByTimeAsync(60 * 1000 * 3);
      resolveChain({ otterReply: 'done' });

      const result = await triggerPromise;
      expect(result.executionId).toBeTruthy();
      const execution = taskRepo._executions.get(result.executionId);
      expect(execution!.status).toBe('completed');
      // 至少 3 次活性探测都被续期（F20260913ctlv 批2：探测数据源 = entries）
      expect((entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('链在探测期间无消息 settle（DB 异常路径）→ 透传成功而非误抛 timeout（对抗审视发现 1/3）', async () => {
    // 场景：静默窗到，isChainStillActive 查询期间（async 空隙）链恰好 settle 且锚点后无可见消息
    // （消息写入失败的 DB 异常路径）。修复后应透传链成功结果，不误杀。
    vi.useFakeTimers();
    try {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const cronParser = createMockCronParser(new Date());

      let resolveChain: (v: { otterReply?: string }) => void = () => {};
      const dispatchChainEngine = {
        executeChain: vi.fn(() => new Promise(r => { resolveChain = r; })),
      };

      const task = makeTask({ id: 'task-settled-during-probe', timeoutMinutes: 1 });
      taskRepo._store.set(task.id, task);
      convRepo._addConversation('conv-1', { status: 'active' });

      // 链 settle 后活性探测才返回（无新 entry）——模拟探测 async 空隙内链 settle（F20260913ctlv 批2 切 entries）
      (entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mockImplementation(
        async () => await new Promise<Array<never>>(resolve => {
          resolveChain({ otterReply: 'settled while probing' });
          // 微任务清空后再返回探测结果，确保 chainSettled 已赋值
          setTimeout(() => resolve([]), 10);
        }),
      );

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        dispatchChainEngine: dispatchChainEngine as unknown as DispatchChainEngine,
      });

      const triggerPromise = service.trigger('task-settled-during-probe');
      // 推进 1 个静默窗触发探测（探测内部链 settle）+ 探测返回延时
      await vi.advanceTimersByTimeAsync(61_000);
      const result = await triggerPromise;

      // 修复后：链已 settle 且成功 → 透传成功，execution 记 completed
      expect(result.executionId).toBeTruthy();
      const execution = taskRepo._executions.get(result.executionId);
      expect(execution!.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PR4: function executor 执行记账', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 构造 function executor 任务 fixture（executorType='function' 通用形态） */
  function makeFunctionTask(): ScheduledTask {
    return makeTask({
      id: 'task-fn',
      executorType: 'function',
      functionName: 'match_orders',
      body: '{}',
    });
  }

  it('函数执行成功 -> execution 记 completed，messageId/turnId 留 NULL（不走 completeExecution 的 FK 路径）', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    // 副作用记录（repo lint 禁 toHaveBeenCalledWith：用状态断言替代参数断言）
    const fnCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const fnRegistry = {
      execute: vi.fn(async (name: string, params: Record<string, unknown>) => {
        fnCalls.push({ name, params });
        return { success: true, matchedOrders: 1 };
      }),
    };

    const task = makeFunctionTask();
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      functionRegistry: fnRegistry as unknown as import('../../../src/usecases/scheduler/function-registry').FunctionRegistry,
    });

    const result = await service.trigger('task-fn');

    // 函数被执行，函数名与参数（从 body JSON 解析）均正确
    expect(fnCalls).toEqual([{ name: 'match_orders', params: {} }]);
    // execution 落 completed
    const execution = taskRepo._executions.get(result.executionId);
    expect(execution!.status).toBe('completed');
    // 0901 修复核心：不写 messageId=''/turnId（空串非 NULL，FK 不豁免；且 function executor 无消息可关联）
    expect(execution!.messageId ?? null).toBe(null);
    expect(execution!.turnId ?? null).toBe(null);
    // 不发系统消息、不 invoke agent（纯代码执行）
    expect(sendEntry._getEntryCount()).toBe(0);
    expect(agentInvoke.invokeConversation).not.toHaveBeenCalled();
    // 连续失败计数被重置（成功路径）
    expect(taskRepo._getResetCallCount()).toBe(1);
  });

  it('函数抛错 -> execution 记 failed + errorMessage，连续失败计数走起', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    const fnRegistry = {
      execute: vi.fn(async () => {
        throw new Error('fn_task: simulated failure');
      }),
    };

    const task = makeFunctionTask();
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      functionRegistry: fnRegistry as unknown as import('../../../src/usecases/scheduler/function-registry').FunctionRegistry,
    });

    await expect(service.trigger('task-fn')).rejects.toThrow('simulated failure');

    const execs = [...taskRepo._executions.values()];
    expect(execs[execs.length - 1].status).toBe('failed');
    expect(execs[execs.length - 1].errorMessage).toContain('simulated failure');
    expect(taskRepo._getFailureCount()).toBe(1);
  });

  it('functionRegistry 未注入 -> validation 错误（不静默降级）', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    const task = makeFunctionTask();
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      // 不注入 functionRegistry（校验前置失败）
    });

    await expect(service.trigger('task-fn')).rejects.toThrow('Function registry not injected');
  });
});

describe('#517: invoke 失败时 execution 不得记 completed', () => {
  it('链正常 resolve 但 anchor 后存在 failed 的 otter 消息 → execution 记 failed', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    // 链引擎正常 resolve（模拟 orchestrator 内部消化了 agent 异常——8-27 现场）
    const dispatchChainEngine = {
      executeChain: vi.fn(async () => ({ otterReply: undefined })),
    };

    const task = makeTask({ id: 'task-swallow' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    // 锚点后有一条 failed 的 invoke_end entry（invoke 失败现场：锁超时 → invoke failed，但链 resolve；
    // F20260913ctlv 批2 切 entries——invoke 终态记 metadata.invokeStatus）
    const failedEntry = {
      id: 'e-failed', senderId: null, entryType: 'invoke_end', body: '🦦 小獭行动失败：Lock acquire timeout',
      yieldTargets: null, metadata: { invokeStatus: 'failed' },
    };
    (entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mockResolvedValue([failedEntry]);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      dispatchChainEngine: dispatchChainEngine as unknown as DispatchChainEngine,
    });

    const err = await service.trigger('task-swallow').catch(e => e);

    // 记账校验抛错 → execution failed（不再盲目 completed）
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Agent invocation failed');
    expect(err.message).toContain('Lock acquire timeout');
    const execs = [...taskRepo._executions.values()];
    expect(execs[execs.length - 1].status).toBe('failed');
    expect(execs[execs.length - 1].errorMessage).toBeTruthy();
    // 连续失败计数走起（熔断保护恢复生效）
    expect(taskRepo._getFailureCount()).toBe(1);
  });

  it('锚点前（旧轮次）的 failed 消息不牵连本次执行', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());
    const dispatchChainEngine = {
      executeChain: vi.fn(async () => ({ otterReply: 'ok' })),
    };

    const task = makeTask({ id: 'task-oldfail' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    // 锚点后无消息（旧 failed 在锚点前，getMessagesAfter 查不到）
    (convRepo.getMessagesAfter as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      dispatchChainEngine: dispatchChainEngine as unknown as DispatchChainEngine,
    });

    const result = await service.trigger('task-oldfail');
    expect(result.executionId).toBeTruthy();
    const execution = taskRepo._executions.get(result.executionId);
    expect(execution!.status).toBe('completed');
  });

  it('非链降级路径同样记账校验：invoke 后 anchor 有 failed 消息 → failed', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    const task = makeTask({ id: 'task-direct' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    const failedEntry2 = {
      id: 'e-failed-2', senderId: null, entryType: 'invoke_end', body: '🦦 小獭行动失败',
      yieldTargets: null, metadata: { invokeStatus: 'failed' },
    };
    (entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mockResolvedValue([failedEntry2]);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    const err = await service.trigger('task-direct').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    const execs = [...taskRepo._executions.values()];
    expect(execs[execs.length - 1].status).toBe('failed');
  });

  it('消息量超过 100 条分页拉取：failed 在 100 条之后 → 仍被检出（对抗审视发现 2）', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());
    const dispatchChainEngine = {
      executeChain: vi.fn(async () => ({ otterReply: 'ok' })),
    };

    const task = makeTask({ id: 'task-deepfail' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    // 第 1 页 100 条全部正常产出，第 2 页第 101 条是 failed 的 invoke_end entry
    // 旧实现单页 limit=100 会漏检，分页修复后应检出（F20260913ctlv 批2 切 entries）
    const okEntries = Array.from({ length: 100 }, (_, i) => ({
      id: `e-ok-${i}`, senderId: 'otter-1', entryType: 'speak', body: '产出',
      yieldTargets: null, metadata: null,
    }));
    const deepFailedEntry = {
      id: 'e-deep-failed', senderId: null, entryType: 'invoke_end', body: '🦦 小獭行动失败：deep failure',
      yieldTargets: null, metadata: { invokeStatus: 'failed' },
    };
    // getEntriesAfter(cursor, count)：第 1 次（锚点=entry-1）返回满页 100 条，第 2 次（游标=末条 id）返回第 101 条 failed，第 3 次返回空
    (entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mockImplementation(
      async (cursor: string) => {
        if (cursor === 'entry-1') return okEntries;
        if (cursor === 'e-ok-99') return [deepFailedEntry];
        return [];
      },
    );

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      dispatchChainEngine: dispatchChainEngine as unknown as DispatchChainEngine,
    });

    const err = await service.trigger('task-deepfail').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('e-deep-failed');
    const execs = [...taskRepo._executions.values()];
    expect(execs[execs.length - 1].status).toBe('failed');
    // 分页推进被触发（至少 3 次查询：满页→failed 页→空页）
    expect((entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('#516: 任务进入 error 状态时落通知（消灭静默死亡）', () => {
  it('第 3 次连续失败 → status=error + 系统消息 + healing event', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    agentInvoke._setShouldFail(true);

    const task = makeTask({ id: 'task-notify' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    const healingEvents: Array<Record<string, unknown>> = [];
    const healingRepo = {
      create: vi.fn(async (e: Record<string, unknown>) => { healingEvents.push(e); }),
      findById: vi.fn(async () => null),
      findOpen: vi.fn(async () => []),
      findAll: vi.fn(async () => []),
      findByConversation: vi.fn(async () => []),
      findRecentByOtter: vi.fn(async () => []),
      updateStatus: vi.fn(async () => {}),
      resolve: vi.fn(async () => {}),
      getStats: vi.fn(async () => ({ open: 0, resolved: 0, dismissed: 0, byType: {}, bySeverity: {} })),
      autoStaleDismiss: vi.fn(async () => 0),
      batchResolveByFilter: vi.fn(async () => ({ matched: 0, resolved: 0, resolvedIds: [] })),
    };

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
      healingRepo: healingRepo as never,
    });

    // 连续触发 3 次（每次都失败）
    for (let i = 0; i < 3; i++) {
      // claimTask 60s 窗口：mock 直接放行
      (taskRepo.claimTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await service.trigger('task-notify').catch(() => {});
    }

    // 第 3 次失败后：status=error
    expect(taskRepo._statusUpdates.some(u => u.status === 'error')).toBe(true);
    // 系统条目已注入任务所属对话（含任务名与停跑提示；F20260913ctlv 批2 切 entries）
    const sysCalls = (sendEntry.createSystemEntry as ReturnType<typeof vi.fn>).mock.calls;
    const notifyCall = sysCalls.find(c => typeof c[0]?.body === 'string' && c[0].body.includes('[定时任务错误]'));
    expect(notifyCall).toBeTruthy();
    expect(notifyCall![0].conversationId).toBe('conv-1');
    expect(notifyCall![0].body).toContain('每日问候');
    // healing event 已落：#754 起单次失败即落 medium + 熔断停跑落 high（共 4 条）
    expect(healingEvents.length).toBe(4);
    const errorEvent = healingEvents.find(e => e.severity === 'high')!;
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.status).toBe('open');
    expect(errorEvent.context).toMatchObject({ taskId: 'task-notify' });
    // #754：单次失败事件（medium，含 executionId 与完整错误文本）
    const singleFailures = healingEvents.filter(e => e.severity === 'medium');
    expect(singleFailures.length).toBe(3);
    expect((singleFailures[0]!.context as Record<string, unknown>).executionError).toBeTruthy();
  });

  it('通知失败（createSystemEntry 抛错）不阻塞 error 状态变更', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    agentInvoke._setShouldFail(true);
    // 系统条目发送失败
    (sendEntry.createSystemEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));

    const task = makeTask({ id: 'task-notify2' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    for (let i = 0; i < 3; i++) {
      (taskRepo.claimTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await service.trigger('task-notify2').catch(() => {});
    }

    // createSystemEntry 抛错不阻塞：status 仍然 error
    expect(taskRepo._statusUpdates.some(u => u.status === 'error')).toBe(true);
  });
});

// ─── #640: 轮询补触发测试 ─────────────────────────────────────

describe('#640: 轮询补触发（tick polling catch-up）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('轮询 tick 检测到 overdue 任务并补触发', async () => {
    // 场景：任务的 cron 预期触发时间为 1 小时前，但未被 setTimeout 触发（模拟 timer 漂移）
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    // cronParser 返回的时间是1小时前 → 任务 overdue
    const overdueTime = new Date('2026-09-01T09:00:00.000Z');
    const cronParser = createMockCronParser(overdueTime);

    taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1', lastTriggeredAt: null }));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    await service.start();
    // start() 内立即执行一次 tick，应检测到 overdue 并补触发
    // 等待异步 tick 完成
    await vi.advanceTimersByTimeAsync(100);

    // 验证：任务被补触发，创建了执行记录
    expect(taskRepo._executions.size).toBeGreaterThanOrEqual(1);
  });

  it('轮询 tick 不重复触发最近已触发的任务', async () => {
    // 场景：cron 预期时间在 1 小时前（overdue），但 lastTriggeredAt 刚刚更新（10 秒前）
    // 期望：tick 跳过（lastTriggeredAt 在 POLL_INTERVAL_MS=5min 窗口内），不补触发
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    // cronParser 返回 1 小时前（overdue）— 但因为 lastTriggeredAt 在窗口内，tick 应跳过
    const overdueTime = new Date('2026-09-01T09:00:00.000Z');
    // 第一次调用返回 1 小时后（让 scheduleNext 的 setTimeout 不立即触发），后续返回 overdue
    let cronCallCount = 0;
    const cronParser = {
      getNextTime: vi.fn(() => {
        cronCallCount++;
        return cronCallCount === 1 ? new Date('2026-09-01T11:00:00.000Z') : overdueTime;
      }),
    } as unknown as CronParser;

    // lastTriggeredAt 设为 10 秒前（在 POLL_INTERVAL_MS=5min 内）
    taskRepo._store.set('task-1', makeTask({
      id: 'task-1', conversationId: 'conv-1',
      lastTriggeredAt: new Date('2026-09-01T09:59:50.000Z').toISOString(),
    }));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser,
      logger: mockLogger,
    });

    await service.start();
    // start() 内立即执行一次 tick：lastTriggeredAt=09:59:50, now=10:00:00, 差10s < POLL_INTERVAL_MS(5min) → 跳过
    await vi.advanceTimersByTimeAsync(100);

    // 验证：tick 跳过，不触发（lastTriggeredAt 在窗口内）
    expect(taskRepo._executions.size).toBe(0);
  });
});

// ─── #641: claim 前检查 running execution 测试 ─────────────────

describe('#641: claim 前检查 running execution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('存在未超时 running execution 时拒绝 claim，记 skipped', async () => {
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date('2026-09-01T09:00:00.000Z'));

    taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    // 模拟存在一个 running execution（5 分钟前触发，未超时）
    (taskRepo.getExecutions as ReturnType<typeof vi.fn>).mockResolvedValue([{
      id: 'exec-running',
      taskId: 'task-1',
      triggeredAt: '2026-09-01T09:55:00.000Z',
      status: 'running',
      completedAt: null,
      errorMessage: null,
      messageId: null,
      turnId: null,
    }]);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    // 手动触发应被跳过（存在 running execution）
    await expect(service.trigger('task-1')).rejects.toThrow('Task already has a running execution');
    // 未创建新 execution
    expect(taskRepo._executions.size).toBe(0);
    // claimTask 未被调用（在检查 running execution 时就已拦截）
    expect(taskRepo.claimTask).not.toHaveBeenCalled();
  });

  it('running execution 超时（>24h）时允许 claim', async () => {
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date('2026-09-01T09:00:00.000Z'));

    taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    // 模拟存在一个超时 running execution（3天前触发）
    (taskRepo.getExecutions as ReturnType<typeof vi.fn>).mockResolvedValue([{
      id: 'exec-stale',
      taskId: 'task-1',
      triggeredAt: '2026-08-29T10:00:00.000Z',
      status: 'running',
      completedAt: null,
      errorMessage: null,
      messageId: null,
      turnId: null,
    }]);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    // 手动触发应成功（超时 execution 不阻塞）
    const result = await service.trigger('task-1');
    expect(result.executionId).toBeDefined();
  });
});

// ─── #642: 链看门狗 429 判死测试 ─────────────────────────────

describe('#642: 链看门狗 429 判死', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('isChainStuckOn429 检测 429 特征消息', async () => {
    // 场景：验证 isChainStuckOn429 私有方法通过反射测试
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date('2026-09-01T11:00:00.000Z'));

    taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    // 模拟锚点后 entries 全部含 429 特征（F20260913ctlv 批2 切 entries：判据 = body 文本）
    const rateLimitEntries = [
      { id: 'e-3', senderId: 'otter-1', entryType: 'invoke_end', body: 'Error 429: Too Many Requests', yieldTargets: null, metadata: null },
      { id: 'e-2', senderId: 'otter-1', entryType: 'invoke_end', body: 'rate limit exceeded, retrying...', yieldTargets: null, metadata: null },
      { id: 'e-1', senderId: 'otter-1', entryType: 'invoke_end', body: 'quota exceeded', yieldTargets: null, metadata: null },
    ];
    (entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mockResolvedValue(rateLimitEntries);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    // 通过反射测试私有方法
    const isStuck = await (service as any).isChainStuckOn429('anchor-msg');
    expect(isStuck).toBe(true);
  });

  it('isChainStuckOn429 对非 429 消息返回 false', async () => {
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date('2026-09-01T11:00:00.000Z'));

    taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    // 模拟锚点后 entries 为正常产出（非 429 特征）
    const normalEntries = [
      { id: 'e-3', senderId: 'otter-1', entryType: 'speak', body: 'Task completed successfully', yieldTargets: null, metadata: null },
    ];
    (entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mockResolvedValue(normalEntries);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    const isStuck = await (service as any).isChainStuckOn429('anchor-msg');
    expect(isStuck).toBe(false);
  });

  it('isChainStuckOn429 用 DESC 检测链尾部 429（ASC 会漏检）', async () => {
    // 场景：链开头几条消息正常，尾部全是429 → ASC 会漏检，DESC 正确检测
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date('2026-09-01T11:00:00.000Z'));

    taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    // F20260913ctlv 批2 切 entries：getEntriesAfter(count=3) 取锚点后最近 entries
    //（实现取 slice(-3) 尾部——语义等同旧 DESC 取最新；本用例构造 >3 条，尾部全 429）
    const mixedEntries = [
      { id: 'e-1', senderId: 'otter-1', entryType: 'speak', body: 'Starting task...', yieldTargets: null, metadata: null },
      { id: 'e-2', senderId: 'otter-1', entryType: 'speak', body: 'Processing...', yieldTargets: null, metadata: null },
      { id: 'e-3', senderId: 'otter-1', entryType: 'invoke_end', body: '配额耗尽', yieldTargets: null, metadata: null },
      { id: 'e-4', senderId: 'otter-1', entryType: 'invoke_end', body: 'rate limit exceeded', yieldTargets: null, metadata: null },
      { id: 'e-5', senderId: 'otter-1', entryType: 'invoke_end', body: '429 Too Many Requests', yieldTargets: null, metadata: null },
    ];
    (entryRepo.getEntriesAfter as ReturnType<typeof vi.fn>).mockResolvedValue(mixedEntries);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    // DESC 检测 → true（链尾部全是429；若实现误用 ASC，earliestNormal 含正常消息会返回 false，
    // 故返回值断言已能区分两种实现，无需断言调用参数）
    const isStuck = await (service as any).isChainStuckOn429('anchor-msg');
    expect(isStuck).toBe(true);
  });
});

// ─── #654: session 锁冲突 → skipped 记账测试 ─────────────────────

describe('#654: session 锁冲突记 skipped（非 failed），不计 consecutiveFailures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 构造锁冲突现场的最小服务（复用状态化 mock 工厂） */
  function setupLockConflict(mockError: Error) {
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date('2026-09-01T11:00:00.000Z'));

    // agent invoke 抛锁冲突错误（模拟 PiSessionFactory.acquire 30s 超时上传）
    (agentInvoke.invokeConversation as ReturnType<typeof vi.fn>).mockRejectedValue(mockError);

    taskRepo._store.set('task-lock', makeTask({ id: 'task-lock', conversationId: 'conv-1' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    return { taskRepo, service };
  }

  it('类型化 SessionLockConflictError：execution 记 skipped，consecutiveFailures 不增', async () => {
    const { taskRepo, service } = setupLockConflict(
      new SessionLockConflictError('Lock acquire timeout for key: session:otter-1'),
    );

    await expect(service.trigger('task-lock')).rejects.toThrow('Lock acquire timeout');

    // execution 记 skipped 而非 failed
    const execution = Array.from(taskRepo._executions.values())[0];
    expect(execution.status).toBe('skipped');
    expect(execution.errorMessage).toContain('Lock acquire timeout');

    // 关键断言：不计失败
    expect(taskRepo._getFailureCount()).toBe(0);
    expect(taskRepo._statusUpdates.some(u => u.status === 'error')).toBe(false);
  });

  it('链路径反推（assertNoFailedMessages 抛含锁前缀的错误）：同样记 skipped', async () => {
    // 链模式的实际形态：锁错误被 failTerminal 写进 failed 消息体，scheduler 从
    // assertNoFailedMessages 的错误字符串反推——message 含锁前缀即命中
    const { taskRepo, service } = setupLockConflict(
      new Error('Agent invocation failed: otter message msg-x terminated as failed ([错误] Lock acquire timeout for key: session:otter-1)'),
    );

    await expect(service.trigger('task-lock')).rejects.toThrow('Lock acquire timeout');

    const execution = Array.from(taskRepo._executions.values())[0];
    expect(execution.status).toBe('skipped');
    expect(taskRepo._getFailureCount()).toBe(0);
    expect(taskRepo._statusUpdates.some(u => u.status === 'error')).toBe(false);
  });

  it('连续 3 次锁冲突不触发 auto_deactivated（3 连败熔断）', async () => {
    const { taskRepo, service } = setupLockConflict(
      new SessionLockConflictError('Lock acquire timeout for key: session:otter-1'),
    );

    // 撞锁 3 次（今早健康检查现场：09:16 补触发连撞）
    for (let i = 0; i < 3; i++) {
      (taskRepo.claimTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await service.trigger('task-lock').catch(() => {});
    }

    // 3 次全是 skipped，无一 failed；任务未被熔断停跑
    const statuses = Array.from(taskRepo._executions.values()).map(e => e.status);
    expect(statuses).toEqual(['skipped', 'skipped', 'skipped']);
    expect(taskRepo._getFailureCount()).toBe(0);
    expect(taskRepo._statusUpdates.some(u => u.status === 'error')).toBe(false);
    // 任务仍 active（对比：真失败 3 次会置 error）
    expect(taskRepo._store.get('task-lock')?.status).toBe('active');
  });

  it('真执行失败（非锁错误）：仍记 failed 且计败（负对照，语义不变）', async () => {
    const now = new Date('2026-09-01T10:00:00.000Z');
    vi.setSystemTime(now);

    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date('2026-09-01T11:00:00.000Z'));

    (agentInvoke.invokeConversation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Agent invocation failed'),
    );

    taskRepo._store.set('task-real-fail', makeTask({ id: 'task-real-fail', conversationId: 'conv-1' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    for (let i = 0; i < 3; i++) {
      (taskRepo.claimTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await service.trigger('task-real-fail').catch(() => {});
    }

    // 真失败路径不受影响：failed + 计败 + 3 连熔断
    const statuses = Array.from(taskRepo._executions.values()).map(e => e.status);
    expect(statuses).toEqual(['failed', 'failed', 'failed']);
    expect(taskRepo._getFailureCount()).toBe(3);
    expect(taskRepo._statusUpdates.some(u => u.status === 'error')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #775 S4a：scheduler 换轨（routeDirectSignal 直投 + 执行级台账看门狗 + 闸门 skipped）
// ─────────────────────────────────────────────────────────────────────────────
describe('#775 S4a: scheduler 换轨', () => {
  function makeSwappedService(opts: {
    taskRepo: ReturnType<typeof createMockTaskRepo>;
    convRepo: ReturnType<typeof createMockConvRepo>;
    sendEntry: ReturnType<typeof createMockSendEntry>;
    entryRepo: ReturnType<typeof createMockEntryRepo>;
    agentInvoke: ReturnType<typeof createMockAgentInvoke>;
    router: { routeDirectSignal: ReturnType<typeof vi.fn>; watchHint?: string };
  }) {
    const nextTime = new Date('2025-06-15T09:00:00.000Z');
    return new SchedulerService({
      taskRepo: opts.taskRepo as unknown as ScheduledTaskRepository,
      convRepo: opts.convRepo as unknown as ConversationRepository,
      sendEntry: opts.sendEntry as unknown as SendEntry,
      entryRepo: opts.entryRepo as unknown as EntryRepository,
      agentInvokePort: opts.agentInvoke as unknown as AgentTurnPort,
      cronParser: createMockCronParser(nextTime) as unknown as CronParser,
      logger: mockLogger,
      signalRouter: opts.router as never,
    });
  }

  function seedReadyTask(taskRepo: ReturnType<typeof createMockTaskRepo>, convRepo: ReturnType<typeof createMockConvRepo>): void {
    taskRepo._store.set('task-1', makeTask());
    convRepo._addConversation('conv-1', { status: 'active' });
  }

  it('A1 换轨生效：trigger 走 routeDirectSignal（不再直连 executeChain/agentInvokePort）', async () => {
    vi.useFakeTimers();
    try {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const routeDirectSignal = vi.fn().mockResolvedValue('invoked');
      seedReadyTask(taskRepo, convRepo);

      const service = makeSwappedService({
        taskRepo, convRepo, sendEntry, entryRepo, agentInvoke,
        router: { routeDirectSignal },
        // 看门狗首轮轮询即判收工（attempt 全终态）
      });

      const triggerPromise = service.trigger('task-1');
      // 推进看门狗首轮 15s 轮询 sleep（watchExecutionByLedger 先 sleep 后查台账）
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await triggerPromise;
      expect(result.executionId).toBeTruthy();
      expect(routeDirectSignal.mock.calls).toHaveLength(1);
      expect(routeDirectSignal.mock.calls[0][0]).toBe('conv-1');
      // 目标 = tsp[0]（第三参数）
      expect(routeDirectSignal.mock.calls[0][2]).toBe('otter-1');
      const execution = taskRepo._executions.get(result.executionId);
      expect(execution?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('A3 启动对账：start() 把僵尸 running 执行翻篇为 failed', async () => {
    const taskRepo = createMockTaskRepo();
    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: createMockConvRepo() as unknown as ConversationRepository,
      sendEntry: createMockSendEntry() as unknown as SendEntry,
      entryRepo: createMockEntryRepo() as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')) as unknown as CronParser,
      logger: mockLogger,
    });
    await service.start();
    expect(taskRepo.failAllRunningExecutions.mock.calls).toHaveLength(1);
  });
});

describe('#823: 运行时定期对账（tick 循环死亡时错过窗口仍可见）', () => {
  function makeHealingRepo823() {
    const events: Array<Record<string, unknown>> = [];
    return {
      _events: events,
      create: vi.fn(async (e: Record<string, unknown>) => { events.push(e); }),
      findOpen: vi.fn(async () => events.map(e => ({ errorType: e.errorType, context: e.context }))),
      autoStaleDismiss: vi.fn(async () => 0),
    };
  }

  it('#949：reconcileMissedWindowsNow（巡检单轮）→ 错过窗口任务落 healing（不依赖轮询 tick）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T08:00:00.000Z')); // #823: 固定系统时间（负延迟 → setTimeout(1) 风暴根因）
    try {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      // 应触发时间 = 今天 09:00；任务 lastTriggeredAt = 前天（错过窗口）
      // 关键：构造「轮询 tick 补触发不覆盖」的场景——lastTriggeredAt 在 POLL_INTERVAL 内不会变，
      // 这里模拟 tick 循环从未运行（服务在线但 tick 死亡的 9/6 形态），只有对账定时器在跑
      const prevDue = new Date('2026-09-06T01:00:00.000Z'); // 09:00 CST
      const cronParser = createMockCronParser(new Date('2026-09-07T01:00:00.000Z'), prevDue);
      const healingRepo = makeHealingRepo823();

      taskRepo._store.set('task-runtime-missed', makeTask({
        id: 'task-runtime-missed',
        scheduleType: 'cron',
        cron: '0 9 * * *',
        // lastTriggeredAt 在 prevDue 之前且远超 5s 容差 → 真错过
        // 同时 now - lastTriggeredAt > POLL_INTERVAL_MS → 若 tick 活着会补触发；
        // 本用例不推进轮询（5min），只推进 1h 对账 → 落账必然来自对账定时器
        lastTriggeredAt: '2026-09-05T01:00:00.000Z',
      } as never));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        healingRepo: healingRepo as never,
        tickImpl: async () => {}, // #823：隔离轮询补触发，只验证对账定时器
      });
      await service.start();
      // 启动对账已落 1 条；清空模拟「该窗口已处置/已是旧账」，看巡检单轮是否独立工作：
      // 用新窗口（prevDue 更新）模拟时间推进后再次错过
      healingRepo._events.length = 0;
      (cronParser as unknown as { prevDue: Date | null }).prevDue = new Date('2026-09-07T01:00:00.000Z'); // 新错过窗口
      // #949：定时器已并入 PatrolWorker——直接调公共方法等价「巡检 tick 触发」
      await service.reconcileMissedWindowsNow();
      await service.stop();

      const runtimeEvents = healingRepo._events.filter(
        e => (e.context as Record<string, unknown>).missedWindowAt === '2026-09-07T01:00:00.000Z',
      );
      expect(runtimeEvents).toHaveLength(1);
      expect(runtimeEvents[0]!.errorType).toBe('other');
      expect(runtimeEvents[0]!.severity).toBe('low');
    } finally {
      vi.useRealTimers();
    }
  });

  it('运行时对账去重：同一错过窗口已被启动对账落账 → 运行时不重复落', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T08:00:00.000Z')); // #823: 固定系统时间——getNextTime mock 返回固定值，不定住 Date.now 会让 setTimeout 拿到负延迟
    try {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const prevDue = new Date('2026-09-06T01:00:00.000Z');
      const cronParser = createMockCronParser(new Date('2026-09-07T01:00:00.000Z'), prevDue);
      const healingRepo = makeHealingRepo823();

      taskRepo._store.set('task-dedup', makeTask({
        id: 'task-dedup',
        scheduleType: 'cron',
        cron: '0 9 * * *',
        lastTriggeredAt: '2026-09-05T01:00:00.000Z',
      } as never));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        healingRepo: healingRepo as never,
        tickImpl: async () => {}, // #823：隔离轮询补触发，只验证对账定时器
      });
      await service.start();
      const afterStartup = healingRepo._events.length; // 启动对账落 1 条
      expect(afterStartup).toBe(1);
      // #949：调三次巡检单轮等价原「3h 三次对账 tick」
      await service.reconcileMissedWindowsNow();
      await service.reconcileMissedWindowsNow();
      await service.reconcileMissedWindowsNow();
      await service.stop();

      // 同一窗口（prevDue 未变）3 次运行时对账后仍只有 1 条——findOpen 去重生效
      expect(healingRepo._events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('#949：运行时对账定时器已并入 PatrolWorker——service 不再自持对账定时器（reconcileTimer 字段移除）', async () => {
    // 合并后 service 侧无 reconcileTimer/startRuntimeReconcile——对账由 PatrolWorker 驱动。
    // 本用例锁死「service 不再注册任何 1h 对账定时器」的契约（防未来有人把定时器加回来造成双驱动）。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T08:00:00.000Z'));
    try {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const prevDue = new Date('2026-09-06T01:00:00.000Z');
      const cronParser = createMockCronParser(new Date('2026-09-07T01:00:00.000Z'), prevDue);
      const healingRepo = makeHealingRepo823();

      taskRepo._store.set('task-stop', makeTask({
        id: 'task-stop',
        scheduleType: 'cron',
        cron: '0 9 * * *',
        lastTriggeredAt: '2026-09-05T01:00:00.000Z',
      } as never));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        healingRepo: healingRepo as never,
        tickImpl: async () => {},
      });
      await service.start();
      const afterStartup = healingRepo._events.length; // 启动对账落 1 条
      (cronParser as unknown as { prevDue: Date | null }).prevDue = new Date('2026-09-07T01:00:00.000Z');
      await vi.advanceTimersByTimeAsync(3_600_000 * 2); // 推进 2h——若 service 自持 1h 对账定时器会再落账
      await service.stop();

      // 无自持定时器 → 推进时间不产生新落账（启动对账的 1 条之外）
      expect(healingRepo._events).toHaveLength(afterStartup);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#823 根修：skip 吞 claim 导致任务饿死（9/6 生产现场）', () => {
  function makeHealingRepoNullBody(openEvents: Array<Record<string, unknown>>) {
    return {
      _events: [] as Array<Record<string, unknown>>,
      create: vi.fn(async () => { /* 对账事件 */ }),
      findOpen: vi.fn(async () => openEvents),
      autoStaleDismiss: vi.fn(async () => 0),
    };
  }

  it('resolveEffectiveBody 返回 null（动态 skip）→ 不消耗 claim：下个窗口照常可触发', async () => {
    // 9/6 现场还原：self-healing-analysis 无 open events → skip
    // 根修前：claim 已吞（last_triggered_at 更新）→ 下个窗口 claimTask 60s 内被拒 / Polling 不重算 expected → 饿死
    // 根修后：resolve 先于 claim → skip 不碰 last_triggered_at → 后续窗口正常
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T01:59:58.000Z'));
    try {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const prevDue = new Date('2026-09-06T01:00:00.000Z');
      const cronParser = createMockCronParser(new Date('2026-09-06T02:00:00.000Z'), prevDue);
      const healingRepo = makeHealingRepoNullBody([]); // 无 open events → buildHealingAnalysisBody 返 null

      taskRepo._store.set('task-heal', makeTask({
        id: 'task-heal',
        scheduleType: 'cron',
        cron: '0 10 * * *',
        body: '[self-healing-analysis]',
        lastTriggeredAt: '2026-09-05T02:00:00.000Z',
      } as never));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        healingRepo: healingRepo as never,
        tickImpl: async () => {},
      });
      await service.start();

      const before = taskRepo._store.get('task-heal')!.lastTriggeredAt;
      // 手动触发（等价 setTimeout 快路径到点）
      await service.trigger('task-heal').catch(() => undefined);
      const after = taskRepo._store.get('task-heal')!.lastTriggeredAt;

      // 关键断言：skip 不得消耗 claim（last_triggered_at 不变）
      expect(after).toBe(before);
      // 且无 execution 建立
      expect(taskRepo._executions.size).toBe(0);
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Polling tick：expected 已过但 lastTriggeredAt 新近被刷新（无 execution）→ 重算 expected，不静默放过', async () => {
    // 9/6 饿死机制还原：expected 缓存停在旧窗口，lastTriggeredAt 已被「无 execution 的 trigger」刷新
    // → tick 必须重算 expected（而不是静默 continue），否则任务永远不再补触发
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T02:00:30.000Z'));
    try {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendEntry = createMockSendEntry();
      const entryRepo = createMockEntryRepo();
      const agentInvoke = createMockAgentInvoke();
      const prevDue = new Date('2026-09-06T01:00:00.000Z');
      // getNextTime 返 03:00（重算后的下一窗口）
      const cronParser = createMockCronParser(new Date('2026-09-06T03:00:00.000Z'), prevDue);
      const healingRepo = {
        _events: [] as Array<Record<string, unknown>>,
        create: vi.fn(async (e: Record<string, unknown>) => { healingRepo._events.push(e); }),
        findOpen: vi.fn(async () => []),
        autoStaleDismiss: vi.fn(async () => 0),
      };

      taskRepo._store.set('task-starve', makeTask({
        id: 'task-starve',
        scheduleType: 'cron',
        cron: '0 10 * * *',
        // lastTriggeredAt 刚刚被刷新（30 秒前，在 POLL_INTERVAL_MS 内）——模拟被无 execution 的 trigger 吞了 claim
        lastTriggeredAt: new Date(Date.now() - 15_000).toISOString(),
      } as never));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendEntry: sendEntry as unknown as SendEntry,
        entryRepo: entryRepo as unknown as EntryRepository,
        agentInvokePort: agentInvoke as unknown as AgentTurnPort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
        healingRepo: healingRepo as never,
      });
      await service.start();
      // start() 时 scheduleNext 把 expected 缓存设为 getNextTime=03:00——但我们需要模拟「expected 停在旧窗口」
      // 直接把缓存打回旧窗口（模拟 start 前缓存/上轮残留）
      (service as unknown as { nextExpectedTrigger: Map<string, Date> }).nextExpectedTrigger
        .set('task-starve', new Date('2026-09-06T02:00:00.000Z'));

      // 跑一轮 tick（startPolling 的 initial tick 已跑过；手动调 tickReal 语义）
      await (service as unknown as { tickReal: () => Promise<void> }).tickReal();

      // 断言：expected 被重算推进到 03:00（不是停在 02:00 静默放过）
      const expected = (service as unknown as { nextExpectedTrigger: Map<string, Date> }).nextExpectedTrigger
        .get('task-starve');
      expect(expected?.toISOString()).toBe('2026-09-06T03:00:00.000Z');
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#1068: quota-exhausted 自动降级（定时任务模型绑定默认模型无逃生）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 构造注入 modelPool + manageSession 的 service；invoke 错误消息可编程 */
  function buildFallbackService(opts: {
    invokeErrors: Array<string | null>; // 每次 invokeConversation 调用消费一个；null=成功
    modelAliases?: string[];
    defaultAlias?: string;
  }) {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    taskRepo._store.set('task-1', makeTask());
    convRepo._addConversation('conv-1', { status: 'active' });
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    let callIdx = 0;
    agentInvoke.invokeConversation.mockImplementation(async () => {
      const err = opts.invokeErrors[Math.min(callIdx, opts.invokeErrors.length - 1)];
      callIdx++;
      if (err) throw new Error(err);
      return { messageId: 'msg-1', duration: 0 };
    });
    /** 状态读取：invoke 实际执行次数（副作用计数，非 mock 调用断言） */
    const getInvokeCount = () => callIdx;

    /** 副作用状态：restart 收到的 modelAlias 序列（长度=降级次数，内容=换的模型） */
    const restartModelAliases: Array<string | undefined> = [];
    const mockManageSession = {
      restartSession: vi.fn(async (_otterId: string, _summary?: string, modelAlias?: string) => {
        restartModelAliases.push(modelAlias);
        return { id: 'new-session' };
      }),
    };
    const aliases = opts.modelAliases ?? ['kimi', 'glm'];
    const mockModelPool = {
      getDefaultAlias: () => opts.defaultAlias ?? 'kimi',
      setDefaultAlias: vi.fn(),
      hasModel: (a: string) => aliases.includes(a),
      getModelInfos: () => aliases.map(a => ({ alias: a, provider: 'p', model: a })),
      describeModels: () => aliases.map(a => ({ alias: a })),
    };

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: { getNextTime: () => new Date('2025-06-15T09:00:00.000Z') } as unknown as CronParser,
      logger: mockLogger,
      manageSession: mockManageSession as unknown as ManageSession,
      modelPool: mockModelPool as never,
    });
    return { service, taskRepo, agentInvoke, mockManageSession, mockModelPool, getInvokeCount, restartModelAliases };
  }

  const KIMI_QUOTA_ERROR = "LLM API error: 403 access_terminated_error: You've reached your weekly (7-day) usage limit";

  it('quota-exhausted 失败 -> restart 换 fallback 模型重试一次，成功则 execution 记 completed', async () => {
    const { service, taskRepo, restartModelAliases, getInvokeCount } = buildFallbackService({
      invokeErrors: [KIMI_QUOTA_ERROR, null],
    });

    const result = await service.trigger('task-1');

    // 降级 restart 发生且模型换为非默认的 glm（副作用状态断言）
    expect(restartModelAliases).toEqual(['glm']);
    // invoke 副作用序列：原始失败 + 降级重试成功
    expect(getInvokeCount()).toBe(2);
    // execution 最终 completed（重试成功）
    expect(taskRepo._executions.get(result.executionId)!.status).toBe('completed');
    expect(taskRepo._getResetCallCount()).toBe(1);
  });

  it('降级重试再失败 -> execution 记 failed，不再二次降级（预算 1 次）', async () => {
    const { service, taskRepo, restartModelAliases, getInvokeCount } = buildFallbackService({
      invokeErrors: [KIMI_QUOTA_ERROR, KIMI_QUOTA_ERROR],
    });

    const err = await service.trigger('task-1').catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    // restart 副作用仅一次（无二次降级循环）
    expect(restartModelAliases).toEqual(['glm']);
    expect(getInvokeCount()).toBe(2);
    expect(taskRepo._executions.get(err ? Object.keys(Object.fromEntries(taskRepo._executions))[0] : '')?.status ?? taskRepo._executions.values().next().value!.status).toBe('failed');
  });

  it('瞬时限流（非 exhausted）-> 不降级，直接走原失败路径', async () => {
    const { service, restartModelAliases, getInvokeCount } = buildFallbackService({
      invokeErrors: ['LLM API error: 429 rate limit exceeded, retry later'],
    });

    await service.trigger('task-1').catch(() => {});

    expect(restartModelAliases).toEqual([]);
    expect(getInvokeCount()).toBe(1);
  });

  it('非限流错误 -> 不降级', async () => {
    const { service, restartModelAliases } = buildFallbackService({
      invokeErrors: ['Agent invocation failed: entry xyz indicates failure'],
    });

    await service.trigger('task-1').catch(() => {});

    expect(restartModelAliases).toEqual([]);
  });

  it('modelPool 只有一个模型 -> 无 fallback 可用，不降级走原失败路径', async () => {
    const { service, restartModelAliases } = buildFallbackService({
      invokeErrors: [KIMI_QUOTA_ERROR],
      modelAliases: ['kimi'],
    });

    await service.trigger('task-1').catch(() => {});

    expect(restartModelAliases).toEqual([]);
  });

  it('manageSession 未注入 -> 降级路径整体跳过，走原失败路径', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    taskRepo._store.set('task-1', makeTask());
    convRepo._addConversation('conv-1', { status: 'active' });
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();
    const agentInvoke = createMockAgentInvoke();
    agentInvoke.invokeConversation.mockRejectedValue(new Error(KIMI_QUOTA_ERROR));
    const mockModelPool = {
      getDefaultAlias: () => 'kimi',
      getModelInfos: () => [{ alias: 'kimi' }, { alias: 'glm' }],
    };

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: { getNextTime: () => new Date('2025-06-15T09:00:00.000Z') } as unknown as CronParser,
      logger: mockLogger,
      modelPool: mockModelPool as never,
      // manageSession 未注入
    });

    const err = await service.trigger('task-1').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // 未崩、原失败路径（invoke 副作用仅一次，无降级重试）
    expect(agentInvoke.invokeConversation.mock.results.length).toBe(1);
  });
});

describe('#1068 换轨路径: quota-exhausted 降级（signalRouter 生产形态，PR #1117 检视严重发现②补覆盖）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const KIMI_QUOTA_ERROR = "[错误] LLM API error: 403 access_terminated_error: You've reached your weekly (7-day) usage limit";

  /** 构造换轨形态 service：signalRouter 注入，isMessageSettled 由 entryRepo._entries 驱动 */
  function buildSwappedFallbackService(opts: {
    failFirstInvoke: boolean; // 第一次 invoke 后锚点后出现 quota failed entry；false=两次都成功
    modelAliases?: string[];
  }) {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    taskRepo._store.set('task-1', makeTask());
    convRepo._addConversation('conv-1', { status: 'active' });
    const sendEntry = createMockSendEntry();
    const entryRepo = createMockEntryRepo();

    /** 副作用状态：routeDirectSignal 调用序号驱动的场景编排。
     *  mock 结构注意：sendEntry（锚点创建）与 entryRepo（看门狗/记账数据源）是分离 mock，
     *  锚点 entry-N 不在 entryRepo Map 中——isMessageSettled 锚点缺失判 settled（无需等待），
     *  assertNoFailedInvokes 的 fetchEntriesAfterPaged 锚点缺失返回空（无 failed 证据）。
     *  因此失败证据预置在「锚点之前可见」：锚点缺失时 after=空 → assert 通过——此路不通。
     *  正道：把锚点 entry-N 同步登记进 entryRepo（与生产同形态：entry 单一真相源），
     *  失败/成功产出 entry 排在其后。 */
    let routeCallCount = 0;
    const routeDirectSignal = vi.fn().mockImplementation(async () => {
      routeCallCount++;
      const anchorId = `entry-${routeCallCount}`;
      entryRepo._addEntry({ id: anchorId, entryType: 'system', body: '触发', yieldTargets: ['otter-1'] });
      if (routeCallCount === 1 && opts.failFirstInvoke) {
        // 第一次：模拟 invoke 失败——目标獭产出 invoke_end failed entry（orchestrator failTerminal 写），
        // 置于锚点之后：isMessageSettled 见产出（senderId 命中）判 settled，
        // assertNoFailedInvokes 见 invoke_end failed 抛 quota 错。
        entryRepo._addEntry({
          id: 'failed-invoke-end-1',
          senderId: 'otter-1',
          entryType: 'invoke_end',
          body: KIMI_QUOTA_ERROR,
          metadata: { invokeStatus: 'failed' },
        });
      } else {
        // 成功路径：目标产出 speak（锚点后 isMessageSettled 判 settled；assertNoFailedInvokes 无 failed）
        entryRepo._addEntry({ id: `speak-${routeCallCount}`, senderId: 'otter-1', entryType: 'speak', body: '完成' });
      }
      return 'invoked';
    });

    const restartModelAliases: Array<string | undefined> = [];
    const mockManageSession = {
      restartSession: vi.fn(async (_o: string, _s?: string, modelAlias?: string) => {
        restartModelAliases.push(modelAlias);
        return { id: 'new-session' };
      }),
    };
    const aliases = opts.modelAliases ?? ['kimi', 'glm'];
    const mockModelPool = {
      getDefaultAlias: () => 'kimi',
      getModelInfos: () => aliases.map(a => ({ alias: a, provider: 'p', model: a })),
    };

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendEntry: sendEntry as unknown as SendEntry,
      entryRepo: entryRepo as unknown as EntryRepository,
      agentInvokePort: createMockAgentInvoke() as unknown as AgentTurnPort,
      cronParser: { getNextTime: () => new Date('2025-06-15T09:00:00.000Z') } as unknown as CronParser,
      logger: mockLogger,
      signalRouter: { routeDirectSignal } as never,
      manageSession: mockManageSession as unknown as ManageSession,
      modelPool: mockModelPool as never,
    });
    return { service, taskRepo, routeDirectSignal, restartModelAliases, getRouteCallCount: () => routeCallCount };
  }

  it('换轨形态：第一次 invoke quota 失败（invoke_end failed entry）-> assertNoFailedInvokes 抛错 -> 降级 restart -> 重投新信号成功 -> completed', async () => {
    const { service, taskRepo, routeDirectSignal, restartModelAliases, getRouteCallCount } =
      buildSwappedFallbackService({ failFirstInvoke: true });

    const triggerPromise = service.trigger('task-1');
    // 三轮看门狗轮询推进（15s × 3）：第一轮 settled → assert 抛 quota 错 → 降级 → 重投 → 第二轮 settled → 成功。
    // 多推进一轮保底：async 函数内 promise 链在 fake timer 间的微任务推进需冗余窗口。
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await triggerPromise;

    // 降级发生且换 glm（副作用状态）
    expect(restartModelAliases).toEqual(['glm']);
    // 信号投了两次（原锚点 + 降级重试新锚点）
    expect(getRouteCallCount()).toBe(2);
    expect(routeDirectSignal.mock.calls[0][0]).toBe('conv-1');
    // execution 终态 completed
    expect(taskRepo._executions.get(result.executionId)!.status).toBe('completed');
  }, 20_000);

  it('换轨形态：quota 失败但单模型池无 fallback -> 不降级，execution failed', async () => {
    const { service, taskRepo, restartModelAliases, getRouteCallCount } =
      buildSwappedFallbackService({ failFirstInvoke: true, modelAliases: ['kimi'] });

    const triggerPromise = service.trigger('task-1').catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await triggerPromise;

    expect(err).toBeInstanceOf(Error);
    expect(restartModelAliases).toEqual([]);
    expect(getRouteCallCount()).toBe(1);
    const executions = [...taskRepo._executions.values()];
    expect(executions[0]!.status).toBe('failed');
  }, 20_000);
});
