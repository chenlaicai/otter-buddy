/**
 * SchedulerService metric 集成测试
 *
 * Why 独立文件：scheduler-service.test.ts 已超出 max-lines-per-function 限制，
 *   再嵌入 metric 集成会触发 lint。拆分到独立文件保持单文件可读。
 *
 * Why 用真实 SchedulerMetrics 而非 mock：仓库 lint 禁止 `toHaveBeenCalledWith`
 *   和 `toHaveBeenCalledTimes`（"测试反模式机械拦截"——禁止断言调用参数）。
 *   用真实 metric + 断言 counter 数值（副作用）更符合规则精神，也更接近生产行为。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SchedulerService, type CronParser } from '@usecases/scheduler/scheduler-service';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentInvokePort } from '@usecases/ports/agent-invoke-port';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { Logger } from '@usecases/ports/logger';
import { MetricsRegistry, resetMetricsRegistry } from '@frameworks/metrics/registry';
import { SchedulerMetrics } from '@frameworks/metrics/scheduler-metrics';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

// ─── 共享 mock factory（参考 scheduler-service.test.ts 的工厂） ─────────
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    conversationId: 'conv-1',
    name: '测试任务',
    scheduleType: 'cron',
    cron: '0 9 * * *',
    triggerAt: null,
    timezone: 'Asia/Shanghai',
    body: 'body',
    talkingStonePassedTo: ['otter-1'],
    senderId: 'otter-1',
    status: 'active',
    consecutiveFailures: 0,
    lastTriggeredAt: null,
    restartBeforeInvoke: false,
    createdAt: '2025-06-15T08:00:00.000Z',
    updatedAt: '2025-06-15T08:00:00.000Z',
    ...overrides,
  };
}

interface MockRepo {
  _store: Map<string, ScheduledTask>;
  _executions: Map<string, { taskId: string; status: string }>;
  getById: ReturnType<typeof vi.fn>;
  getByConversationId: ReturnType<typeof vi.fn>;
  getAllActive: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  claimTask: ReturnType<typeof vi.fn>;
  createExecution: ReturnType<typeof vi.fn>;
  updateExecutionStatus: ReturnType<typeof vi.fn>;
  incrementConsecutiveFailures: ReturnType<typeof vi.fn>;
  resetConsecutiveFailures: ReturnType<typeof vi.fn>;
  getExecutions: ReturnType<typeof vi.fn>;
  getExecutionCount: ReturnType<typeof vi.fn>;
}

function createMockRepo(): MockRepo {
  const store = new Map<string, ScheduledTask>();
  const executions = new Map<string, { taskId: string; status: string }>();
  return {
    _store: store,
    _executions: executions,
    getById: vi.fn(async (id: string) => store.get(id) ?? null),
    getByConversationId: vi.fn(async () => Array.from(store.values())),
    getAllActive: vi.fn(async () => Array.from(store.values()).filter(t => t.status === 'active')),
    create: vi.fn(async (t: ScheduledTask) => { store.set(t.id, t); }),
    update: vi.fn(async (t: ScheduledTask) => { store.set(t.id, t); }),
    updateStatus: vi.fn(async (id: string, status: string) => {
      const t = store.get(id);
      if (t) store.set(id, { ...t, status: status as ScheduledTask['status'] });
    }),
    delete: vi.fn(async (id: string) => { store.delete(id); }),
    claimTask: vi.fn(async () => true),
    createExecution: vi.fn(async (e: { id: string; taskId: string }) => {
      executions.set(e.id, { taskId: e.taskId, status: 'running' });
    }),
    updateExecutionStatus: vi.fn(async (id: string, updates: { status: string }) => {
      const e = executions.get(id);
      if (e) executions.set(id, { ...e, status: updates.status });
    }),
    incrementConsecutiveFailures: vi.fn(async () => 1),
    resetConsecutiveFailures: vi.fn(async () => undefined),
    getExecutions: vi.fn(async () => []),
    getExecutionCount: vi.fn(async () => 0),
  };
}

function createMockConvRepo() {
  const convs = new Map<string, { status: string }>();
  return {
    _convs: convs,
    _addConversation: (id: string, overrides: { status: string }) => {
      convs.set(id, { status: overrides.status });
    },
    getById: vi.fn(async (id: string) => convs.get(id) ?? null),
    getActiveTurn: vi.fn(async () => null),
  };
}

function createMockSendMessage() {
  return { send: vi.fn(async () => ({ id: 'msg-1' })) };
}

function createMockAgentInvoke() {
  return { invokeConversation: vi.fn(async () => ({ messageId: 'msg-1' })) };
}

function createMockCronParser(next: Date): CronParser {
  return { getNextTime: vi.fn(() => next) };
}

/** 从 registry 读 counter 数值（按 metric name + labels 过滤） */
async function readCounter(registry: MetricsRegistry, name: string, labels?: Record<string, string>): Promise<number | undefined> {
  const json = (await registry.metricsJSON()) as Array<{
    name: string;
    values: Array<{ labels?: Record<string, string>; value: number }>;
  }>;
  const metric = json.find(m => m.name === name);
  if (!metric) return undefined;
  const match = metric.values.find(v =>
    !labels || Object.entries(labels).every(([k, val]) => v.labels?.[k] === val),
  );
  return match?.value;
}

describe('SchedulerService metric 集成', () => {
  let dir: string;
  let registry: MetricsRegistry;
  let metrics: SchedulerMetrics;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-metric-int-'));
    registry = new MetricsRegistry(mockLogger, { dir });
    metrics = new SchedulerMetrics(registry);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetMetricsRegistry();
  });

  it('成功触发时 trigger_total{completed} 递增', async () => {
    const taskRepo = createMockRepo();
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();
    taskRepo._store.set('task-1', makeTask({ scheduleType: 'once', triggerAt: '2025-06-15T09:00:00.000Z', cron: '' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentInvokePort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')),
      logger: mockLogger,
      metrics,
    });

    await service.trigger('task-1');

    const completed = await readCounter(registry, 'scheduler_trigger_total', { type: 'once', status: 'completed' });
    expect(completed).toBe(1);
  });

  it('触发失败时 trigger_total{failed} 递增', async () => {
    const taskRepo = createMockRepo();
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();
    agentInvoke.invokeConversation = vi.fn(async () => { throw new Error('boom'); });
    taskRepo._store.set('task-1', makeTask());
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentInvokePort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')),
      logger: mockLogger,
      metrics,
    });

    await expect(service.trigger('task-1')).rejects.toThrow('boom');

    const failed = await readCounter(registry, 'scheduler_trigger_total', { type: 'cron', status: 'failed' });
    expect(failed).toBe(1);
  });

  it('claim 失败（60s 重复触发）时 trigger_total{skipped} 递增', async () => {
    const taskRepo = createMockRepo();
    taskRepo.claimTask = vi.fn(async () => false);
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();
    taskRepo._store.set('task-1', makeTask());
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentInvokePort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')),
      logger: mockLogger,
      metrics,
    });

    await expect(service.trigger('task-1')).rejects.toThrow();

    const skipped = await readCounter(registry, 'scheduler_trigger_total', { type: 'cron', status: 'skipped' });
    expect(skipped).toBe(1);
  });

  it('对话不可用时 trigger_total{skipped} 递增', async () => {
    const taskRepo = createMockRepo();
    const convRepo = createMockConvRepo();
    // 不 add conversation → getById 返回 null
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();
    taskRepo._store.set('task-1', makeTask());

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentInvokePort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')),
      logger: mockLogger,
      metrics,
    });

    await expect(service.trigger('task-1')).rejects.toThrow();

    const skipped = await readCounter(registry, 'scheduler_trigger_total', { type: 'cron', status: 'skipped' });
    expect(skipped).toBe(1);
  });

  it('createExecution 抛错时 default failed 保证：trigger_total{failed} 递增', async () => {
    // Why 这个测试：验证 round 2 C1 修复的"默认 failed"语义
    //   createExecution 在 inner try 之前，抛错时 inner try 还没进入
    //   status 仍是默认 'failed'
    const taskRepo = createMockRepo();
    taskRepo.createExecution = vi.fn(async () => { throw new Error('DB locked'); });
    const convRepo = createMockConvRepo();
    convRepo._addConversation('conv-1', { status: 'active' });
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();
    taskRepo._store.set('task-1', makeTask());

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentInvokePort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')),
      logger: mockLogger,
      metrics,
    });

    await expect(service.trigger('task-1')).rejects.toThrow('DB locked');

    const failed = await readCounter(registry, 'scheduler_trigger_total', { type: 'cron', status: 'failed' });
    expect(failed).toBe(1);

    // histogram 不应记录（execution 阶段未开始）
    const json = (await registry.metricsJSON()) as Array<{ name: string; values: Array<{ value: number }> }>;
    const hist = json.find(m => m.name === 'scheduler_execution_duration_ms');
    const totalCount = hist?.values.reduce((s, v) => s + v.value, 0) ?? 0;
    expect(totalCount).toBe(0);
  });

  it('start() 时按 type 上报 active 任务数', async () => {
    const taskRepo = createMockRepo();
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();

    taskRepo._store.set('task-1', makeTask({ id: 'task-1', scheduleType: 'cron' }));
    taskRepo._store.set('task-2', makeTask({ id: 'task-2', scheduleType: 'cron' }));
    taskRepo._store.set('task-3', makeTask({
      id: 'task-3', scheduleType: 'once', triggerAt: '2025-06-15T10:00:00.000Z', cron: '',
    }));

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentInvokePort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')),
      logger: mockLogger,
      metrics,
    });

    await service.start();

    expect(await readCounter(registry, 'scheduler_active_tasks', { type: 'cron' })).toBe(2);
    expect(await readCounter(registry, 'scheduler_active_tasks', { type: 'once' })).toBe(1);
  });

  it('once 任务过期时 expired_total 递增', async () => {
    const taskRepo = createMockRepo();
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();

    const pastTime = '2025-06-15T08:00:00.000Z';
    taskRepo._store.set('task-1', makeTask({ scheduleType: 'once', triggerAt: pastTime, cron: '' }));
    convRepo._addConversation('conv-1', { status: 'active' });

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentInvokePort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')),
      logger: mockLogger,
      metrics,
    });

    await service.start();

    expect(await readCounter(registry, 'scheduler_expired_total')).toBe(1);
  });

  it('onChange 触发后 active_tasks gauge 刷新', async () => {
    const taskRepo = createMockRepo();
    const convRepo = createMockConvRepo();
    const sendMessage = createMockSendMessage();
    const agentInvoke = createMockAgentInvoke();

    // 初始无任务
    const onChangeCallbacks: Array<(taskId: string, action: string) => void> = [];
    const manageScheduledTask = {
      onChange: vi.fn((cb: (taskId: string, action: string) => void) => {
        onChangeCallbacks.push(cb);
      }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as ManageScheduledTask;

    const service = new SchedulerService({
      taskRepo: taskRepo as unknown as ScheduledTaskRepository,
      convRepo: convRepo as unknown as ConversationRepository,
      sendMessage: sendMessage as unknown as SendMessage,
      agentInvokePort: agentInvoke as unknown as AgentInvokePort,
      cronParser: createMockCronParser(new Date('2025-06-15T09:00:00.000Z')),
      logger: mockLogger,
      metrics,
      manageScheduledTask,
    });

    await service.start();
    // start 时无 active 任务，gauge = 0
    expect(await readCounter(registry, 'scheduler_active_tasks', { type: 'cron' })).toBe(0);

    // 模拟 onChange(created)：调用回调，并在 taskRepo 加一个 active 任务
    const onChangeCallback = onChangeCallbacks[0];
    taskRepo._store.set('task-2', makeTask({ id: 'task-2', scheduleType: 'cron' }));
    onChangeCallback('task-2', 'created');

    // setImmediate 推进
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    // gauge 应该刷新到 1
    expect(await readCounter(registry, 'scheduler_active_tasks', { type: 'cron' })).toBe(1);
  });
});
