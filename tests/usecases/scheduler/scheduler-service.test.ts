import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchedulerService, type CronParser } from '@usecases/scheduler/scheduler-service';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentInvokePort } from '@usecases/scheduler/agent-invoke-port';
import type { ManageScheduledTask, TaskChangeCallback } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import { DomainError } from '@entities/errors';
import type { Logger } from '@usecases/ports/logger';

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
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    body: '早上好！',
    talkingStonePassedTo: ['otter-1'],
    senderId: 'otter-1',
    status: 'active',
    consecutiveFailures: 0,
    lastTriggeredAt: null,
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
      return { id: `msg-${messageCount}`, body: '早上好！' };
    }),
  };
}

/** 创建 AgentInvokePort 的状态化 mock */
function createMockAgentInvoke() {
  /** agent 调用是否应该失败 */
  let shouldFail = false;

  return {
    _setShouldFail: (fail: boolean) => { shouldFail = fail; },
    invokeConversation: vi.fn(async () => {
      if (shouldFail) {
        throw new Error('Agent invocation failed');
      }
      return { messageId: 'agent-msg-1' };
    }),
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
        cronParser: cronParser as unknown as CronParser,
        logger: mockLogger,
      });

      await service.start();

      // 推进 23 小时：不应触发（delay 被 cap 到 24h）
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      expect(taskRepo._executions.size).toBe(0);

      // 再推进 1 小时（总计 24h）：应触发任务
      await vi.advanceTimersByTimeAsync(1 * 60 * 60 * 1000);
      expect(taskRepo._executions.size).toBe(1);
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
        agentInvokePort: agentInvoke as unknown as AgentInvokePort,
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
});
