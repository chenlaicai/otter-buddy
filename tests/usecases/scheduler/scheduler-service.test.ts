import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchedulerService, type CronParser } from '@usecases/scheduler/scheduler-service';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentTurnPort } from '@usecases/ports/agent-turn-port';
import type { ManageScheduledTask, TaskChangeCallback } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { ManageSession } from '@usecases/otter/manage-session';
import { DomainError } from '@entities/errors';
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
    talkingStonePassedTo: ['otter-1'],
    senderId: 'otter-1',
    status: 'active',
    consecutiveFailures: 0,
    lastTriggeredAt: null,
    restartBeforeInvoke: false,
    timeoutMinutes: null,
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
    claimTask: vi.fn(async () => {
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

/** 创建 SendMessage 的状态化 mock */
function createMockSendMessage() {
  /** 已发送消息计数 */
  let messageCount = 0;

  return {
    /** 获取已发送消息数 */
    _getMessageCount: () => messageCount,
    send: vi.fn(async () => {
      messageCount += 1;
      return { message: { id: `msg-${messageCount}`, body: '早上好！' } };
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
function createMockCronParser(nextTime: Date) {
  const callCount = { value: 0 };
  return {
    _callCount: callCount,
    getNextTime: vi.fn(() => {
      callCount.value++;
      return nextTime;
    }),
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();

      // 下次触发时间设为 72 小时后（远超 24h 限制）
      const nextTime = new Date('2025-06-18T08:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();

      // 下次触发时间设为 72 小时后
      const nextTime = new Date('2025-06-18T08:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask({ id: 'task-1', conversationId: 'conv-1' }));
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      // 注册 active 任务和 active 对话
      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      expect(sendMessage._getMessageCount()).toBe(1);

      // 验证连续失败计数被重置（说明成功流程执行了 resetConsecutiveFailures）
      expect(taskRepo._getResetCallCount()).toBe(1);
    });

    it('任务不存在 -> 抛出 DomainError（kind=not_found）', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      // 注册 disabled 状态的任务
      taskRepo._store.set('task-1', makeTask({ status: 'disabled' }));

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      expect(sendMessage._getMessageCount()).toBe(0);
    });
  });

  describe('对话校验', () => {
    it('对话不存在 -> 自动禁用任务并抛出 validation 错误', async () => {
      const taskRepo = createMockTaskRepo();
      const convRepo = createMockConvRepo();
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      // 不注册对话 -> getById 返回 null

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);

      taskRepo._store.set('task-1', makeTask());
      // 对话状态为 archived
      convRepo._addConversation('conv-1', { status: 'archived' });

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
      const agentInvoke = createMockAgentInvoke();
      const nextTime = new Date('2025-06-15T09:00:00.000Z');
      const cronParser = createMockCronParser(nextTime);
      const manageScheduledTask = createMockManageScheduledTask();

      taskRepo._store.set('task-1', makeTask());
      convRepo._addConversation('conv-1', { status: 'active' });

      new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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
        sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
      const sendMessage = createMockSendMessage();
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

      // 每次探测都返回一条新消息（链活跃）
      const activeMsg = {
        id: 'm-new', conversationId: 'conv-1', turnId: 't1', senderType: 'otter',
        senderId: 'otter-1', talkingStonePassedTo: null, status: 'completed',
        segments: [], sequenceNum: 2, contextTokens: null, contextTokensMax: null,
        source: 'web', senderName: '', createdAt: '2025-01-01T00:00:00Z', completedAt: null,
      };
      (convRepo.getMessagesAfter as ReturnType<typeof vi.fn>).mockResolvedValue([activeMsg]);

      const service = new SchedulerService({
        taskRepo: taskRepo as unknown as ScheduledTaskRepository,
        convRepo: convRepo as unknown as ConversationRepository,
        sendMessage: sendMessage as unknown as SendMessage,
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
      // 至少 3 次活性探测都被续期
      expect((convRepo.getMessagesAfter as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#517: invoke 失败时 execution 不得记 completed', () => {
  it('链正常 resolve 但 anchor 后存在 failed 的 otter 消息 → execution 记 failed', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    // 链引擎正常 resolve（模拟 orchestrator 内部消化了 agent 异常——8-27 现场）
    const dispatchChainEngine = {
      executeChain: vi.fn(async () => ({ otterReply: undefined })),
    };

    const task = makeTask({ id: 'task-swallow' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    // 锚点后有一条 failed 的 otter 消息（invoke 失败现场：锁超时 → 消息 failed，但链 resolve）
    const failedMsg = {
      id: 'm-failed', conversationId: 'conv-1', turnId: 't1', senderType: 'otter',
      senderId: 'otter-1', talkingStonePassedTo: null, status: 'failed',
      segments: [{ id: 's1', messageId: 'm-failed', body: 'Lock acquire timeout', sequenceNum: 1, createdAt: '2025-01-01T00:00:00Z' }],
      sequenceNum: 2, contextTokens: null, contextTokensMax: null,
      source: 'web', senderName: '', createdAt: '2025-01-01T00:00:00Z', completedAt: null,
    };
    (convRepo.getMessagesAfter as ReturnType<typeof vi.fn>).mockResolvedValue([failedMsg]);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    const task = makeTask({ id: 'task-direct' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    const failedMsg = {
      id: 'm-failed-2', conversationId: 'conv-1', turnId: 't1', senderType: 'otter',
      senderId: 'otter-1', talkingStonePassedTo: null, status: 'failed',
      segments: [], sequenceNum: 2, contextTokens: null, contextTokensMax: null,
      source: 'web', senderName: '', createdAt: '2025-01-01T00:00:00Z', completedAt: null,
    };
    (convRepo.getMessagesAfter as ReturnType<typeof vi.fn>).mockResolvedValue([failedMsg]);

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    const err = await service.trigger('task-direct').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    const execs = [...taskRepo._executions.values()];
    expect(execs[execs.length - 1].status).toBe('failed');
  });
});

describe('#516: 任务进入 error 状态时落通知（消灭静默死亡）', () => {
  it('第 3 次连续失败 → status=error + 系统消息 + healing event', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
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
      sendMessage: sendMessage as unknown as SendMessage,
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
    // 系统消息已注入任务所属对话（含任务名与停跑提示）
    const sysCalls = (sendMessage.send as ReturnType<typeof vi.fn>).mock.calls;
    const notifyCall = sysCalls.find(c => typeof c[0]?.body === 'string' && c[0].body.includes('[定时任务错误]'));
    expect(notifyCall).toBeTruthy();
    expect(notifyCall![0].conversationId).toBe('conv-1');
    expect(notifyCall![0].body).toContain('每日问候');
    // healing event 已落（open、high、含 taskId）
    expect(healingEvents.length).toBe(1);
    expect(healingEvents[0].status).toBe('open');
    expect(healingEvents[0].severity).toBe('high');
    expect(healingEvents[0].context).toMatchObject({ taskId: 'task-notify' });
  });

  it('通知失败（sendMessage 抛错）不阻塞 error 状态变更', async () => {
    const taskRepo = createMockTaskRepo();
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();
    const cronParser = createMockCronParser(new Date());

    agentInvoke._setShouldFail(true);
    // 系统消息发送失败
    (sendMessage.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));

    const task = makeTask({ id: 'task-notify2' });
    taskRepo._store.set(task.id, task);
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentTurnPort,
      cronParser: cronParser as unknown as CronParser,
      logger: mockLogger,
    });

    for (let i = 0; i < 3; i++) {
      (taskRepo.claimTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await service.trigger('task-notify2').catch(() => {});
    }

    // sendMessage.send 抛错不阻塞：status 仍然 error
    expect(taskRepo._statusUpdates.some(u => u.status === 'error')).toBe(true);
  });
});
