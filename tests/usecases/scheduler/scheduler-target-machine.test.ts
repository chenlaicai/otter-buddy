import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchedulerService, TargetMachineUnavailableError, type CronParser } from '@usecases/scheduler/scheduler-service';
import { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendEntry } from '@usecases/conversation/send-entry';
import type { EntryRepository } from '@usecases/conversation/entry-repository';
import type { AgentTurnPort } from '@usecases/ports/agent-turn-port';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import { DomainError } from '@entities/errors';
import type { Logger } from '@usecases/ports/logger';
import { createTestDb } from '../../helpers/db';
import { SqliteScheduledTaskRepository } from '@frameworks/db/scheduled-task/sqlite-scheduled-task-repository';
import { migrateDatabase } from '@frameworks/db/migration';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

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
    executorRole: '大獭',
    talkingStonePassedTo: ['otter-1'],
    senderId: 'system',
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

/** 触发守卫测试的最小 taskRepo（executions 可观测 + claim/失败计数可断言） */
function createMockTaskRepo(task: ScheduledTask) {
  const executions = new Map<string, Record<string, unknown>>();
  let failureCount = 0;
  return {
    _executions: executions,
    _getFailureCount: () => failureCount,
    create: vi.fn(),
    getById: vi.fn(async () => task),
    getByConversationId: vi.fn(async () => [task]),
    getAllActive: vi.fn(async () => [task]),
    getAll: vi.fn(async () => [task]),
    update: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
    getRunningExecutions: vi.fn(async () => []),
    incrementConsecutiveFailures: vi.fn(async () => { failureCount += 1; return failureCount; }),
    resetConsecutiveFailures: vi.fn(),
    claimTask: vi.fn(async (id: string, lastTriggeredAt: string) => {
      task.lastTriggeredAt = lastTriggeredAt; // 触发即消费本轮（skip 也不盲重放的前提）
      return true;
    }),
    createExecution: vi.fn(async (execution: Record<string, unknown>) => {
      executions.set(execution.id as string, { ...execution });
    }),
    updateExecutionStatus: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const existing = executions.get(id);
      if (existing) Object.assign(existing, updates);
    }),
    getExecutions: vi.fn(async () => []),
    getExecutionCount: vi.fn(async () => 0),
    failAllRunningExecutions: vi.fn(async () => 0),
    getReconciliationFailedExecutions: vi.fn(async () => []),
  };
}

function createMockConvRepo(overrides: { boundMachineId?: string | null } = {}) {
  return {
    _boundMachineId: overrides.boundMachineId ?? null,
    getById: vi.fn(async () => ({ id: 'conv-1', status: 'active' })),
    getExecutionMachineId: vi.fn(async () => overrides.boundMachineId ?? null),
  };
}

function createMockSendEntry() {
  return {
    createSystemEntry: vi.fn(async () => ({ entry: { id: 'entry-1', body: 'x', description: null, sequenceNum: 1, senderName: 'system' } })),
  };
}

function createMockEntryRepo() {
  return {
    getEntries: vi.fn(async () => []),
    getUnreadEntries: vi.fn(async () => []),
  };
}

function createMockAgentInvoke() {
  const state = { invocations: 0 };
  return {
    _state: state,
    invokeConversation: vi.fn(async () => { state.invocations += 1; return { messageId: 'msg-1' }; }),
  };
}

function createCronParser(): CronParser {
  return { getNextTime: () => new Date(Date.now() + 60 * 60 * 1000) };
}

interface HarnessOptions {
  task?: ScheduledTask;
  boundMachineId?: string | null;
  deviceStatus?: () => Promise<Array<{ deviceId: string; name: string; online: boolean; lastSeenAt: string | null }>>;
}

function buildService(opts: HarnessOptions) {
  const task = opts.task ?? makeTask();
  const taskRepo = createMockTaskRepo(task);
  const convRepo = createMockConvRepo({ boundMachineId: opts.boundMachineId });
  const sendEntry = createMockSendEntry();
  const entryRepo = createMockEntryRepo();
  const agentInvoke = createMockAgentInvoke();
  const service = new SchedulerService({
    taskRepo: taskRepo as unknown as ScheduledTaskRepository,
    convRepo: convRepo as unknown as ConversationRepository,
    sendEntry: sendEntry as unknown as SendEntry,
    entryRepo: entryRepo as unknown as EntryRepository,
    agentInvokePort: agentInvoke as unknown as AgentTurnPort,
    cronParser: createCronParser(),
    logger: mockLogger,
    ...(opts.deviceStatus ? { deviceStatus: opts.deviceStatus } : {}),
  });
  return { service, taskRepo, convRepo, agentInvoke, task };
}

describe('scheduler 目标执行机触发守卫', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2025-06-15T08:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('目标在线且绑定一致 → 正常执行（invoke 被调用，execution completed）', async () => {
    const task = makeTask({ targetMachineId: 'device-b' });
    const { service, taskRepo, agentInvoke } = buildService({
      task,
      boundMachineId: 'device-b',
      deviceStatus: async () => [{ deviceId: 'device-b', name: 'B 机', online: true, lastSeenAt: null }],
    });

    await service.trigger('task-1');

    expect(agentInvoke._state.invocations).toBe(1);
    const executions = Array.from(taskRepo._executions.values());
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe('completed');
    expect(taskRepo._getFailureCount()).toBe(0);
  });

  it('目标离线 → skipped 留痕：不 invoke、不计熔断、errorMessage 显式、rethrow', async () => {
    const task = makeTask({ targetMachineId: 'device-b' });
    const { service, taskRepo, agentInvoke } = buildService({
      task,
      boundMachineId: 'device-b',
      deviceStatus: async () => [{ deviceId: 'device-b', name: 'B 机', online: false, lastSeenAt: '2025-06-14T00:00:00.000Z' }],
    });

    const err = await service.trigger('task-1').catch(e => e);
    expect(err).toBeInstanceOf(TargetMachineUnavailableError);

    expect(agentInvoke.invokeConversation).not.toHaveBeenCalled();
    const executions = Array.from(taskRepo._executions.values());
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe('skipped');
    expect(String(executions[0].errorMessage)).toContain('离线');
    expect(String(executions[0].errorMessage)).toContain('device-b');
    expect(taskRepo._getFailureCount()).toBe(0); // 非任务失败——不 increment、不熔断
  });

  it('设备未注册（已撤销配对）→ skipped 留痕', async () => {
    const task = makeTask({ targetMachineId: 'device-gone' });
    const { service, taskRepo, agentInvoke } = buildService({
      task,
      boundMachineId: 'device-gone',
      deviceStatus: async () => [], // 注册中心无此设备
    });

    await expect(service.trigger('task-1')).rejects.toBeInstanceOf(TargetMachineUnavailableError);
    expect(agentInvoke.invokeConversation).not.toHaveBeenCalled();
    const executions = Array.from(taskRepo._executions.values());
    expect(executions[0].status).toBe('skipped');
    expect(String(executions[0].errorMessage)).toContain('未注册');
  });

  it('绑定漂移（对话已改绑别的机器）→ skipped 留痕——绝不静默在别处跑', async () => {
    const task = makeTask({ targetMachineId: 'device-b' });
    const { service, taskRepo, agentInvoke } = buildService({
      task,
      boundMachineId: 'device-c', // 对话绑定已漂移到 C
      deviceStatus: async () => [{ deviceId: 'device-b', name: 'B 机', online: true, lastSeenAt: null }],
    });

    await expect(service.trigger('task-1')).rejects.toBeInstanceOf(TargetMachineUnavailableError);
    // 绑定漂移已被守卫识别（skip 原因写明两机），且未静默在 C 机执行
    expect(agentInvoke.invokeConversation).not.toHaveBeenCalled();
    const executions = Array.from(taskRepo._executions.values());
    expect(executions[0].status).toBe('skipped');
    expect(String(executions[0].errorMessage)).toContain('漂移');
  });

  it('deviceStatus 端口缺失（旧装配/降级）而任务带 target → fail-closed skipped', async () => {
    const task = makeTask({ targetMachineId: 'device-b' });
    // 不传 deviceStatus——模拟旧装配
    const { service, taskRepo, agentInvoke } = buildService({ task, boundMachineId: 'device-b' });

    await expect(service.trigger('task-1')).rejects.toBeInstanceOf(TargetMachineUnavailableError);
    expect(agentInvoke.invokeConversation).not.toHaveBeenCalled();
    const executions = Array.from(taskRepo._executions.values());
    expect(executions[0].status).toBe('skipped');
    expect(String(executions[0].errorMessage)).toContain('未装配');
  });

  it('未声明 target 的任务零变化：守卫不查绑定也不查设备状态', async () => {
    const deviceStatus = vi.fn();
    const { service, taskRepo, agentInvoke, convRepo } = buildService({
      deviceStatus: deviceStatus as never,
    });

    await service.trigger('task-1');

    expect(convRepo.getExecutionMachineId).not.toHaveBeenCalled();
    expect(deviceStatus).not.toHaveBeenCalled();
    expect(agentInvoke._state.invocations).toBe(1);
    const executions = Array.from(taskRepo._executions.values());
    expect(executions[0].status).toBe('completed');
  });

  it('skip 也消费本轮触发（claim 刷新 last_triggered_at）——重新上线不盲重放旧触发', async () => {
    const task = makeTask({ targetMachineId: 'device-b' });
    const { service, taskRepo } = buildService({
      task,
      boundMachineId: 'device-b',
      deviceStatus: async () => [{ deviceId: 'device-b', name: 'B 机', online: false, lastSeenAt: null }],
    });

    await expect(service.trigger('task-1')).rejects.toBeInstanceOf(TargetMachineUnavailableError);

    expect(taskRepo.claimTask).toHaveBeenCalled();
    expect(task.lastTriggeredAt).toBeTruthy(); // 本轮已消费——恢复由下一次正常 tick 的 claim 路径承接
    expect(taskRepo._getFailureCount()).toBe(0);
  });
});

describe('ManageScheduledTask 目标执行机声明校验', () => {
  const baseInput = {
    conversationId: 'conv-1',
    name: '任务',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    body: '干活',
  };

  it('声明未注册设备 → DomainError validation', async () => {
    const repo = { create: vi.fn(), getById: vi.fn(async () => null) } as unknown as ScheduledTaskRepository;
    const manage = new ManageScheduledTask(repo, async (_c, machineId) =>
      machineId === 'device-x' ? null : `目标执行机未注册或已撤销配对: ${machineId}`,
    );
    await expect(
      manage.create({ ...baseInput, targetMachineId: 'device-unknown' }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('声明与对话绑定不一致 → DomainError validation', async () => {
    const repo = { create: vi.fn(), getById: vi.fn(async () => null) } as unknown as ScheduledTaskRepository;
    const manage = new ManageScheduledTask(repo, async () => '对话当前执行机（hub 本地）与目标执行机（device-b）不一致');
    await expect(
      manage.create({ ...baseInput, targetMachineId: 'device-b' }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('校验通过 → 落库 targetMachineId', async () => {
    const created: Array<{ targetMachineId?: string | null }> = [];
    const repo = {
      create: vi.fn(async (t: { targetMachineId?: string | null }) => { created.push(t); }),
      getById: vi.fn(async () => null),
      update: vi.fn(),
    } as never;
    const manage = new ManageScheduledTask(repo, async () => null);
    const task = await manage.create({ ...baseInput, targetMachineId: 'device-b' });
    expect(task.targetMachineId).toBe('device-b');
    expect(created[0].targetMachineId).toBe('device-b');
  });

  it('校验器未装配而声明 target → fail-closed 拒绝（不 silently 放行）', async () => {
    const repo = { create: vi.fn(), getById: vi.fn(async () => null) } as unknown as ScheduledTaskRepository;
    const manage = new ManageScheduledTask(repo); // 无校验器
    await expect(
      manage.create({ ...baseInput, targetMachineId: 'device-b' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('未声明 / 传 null 清除 → 不触发校验', async () => {
    const repo = {
      create: vi.fn(async () => undefined),
      getById: vi.fn(async () => null),
      update: vi.fn(),
    } as never;
    const validator = vi.fn(async () => 'should not be called');
    const manage = new ManageScheduledTask(repo, validator);
    const t1 = await manage.create(baseInput);
    expect(t1.targetMachineId).toBeNull();
    expect(validator).not.toHaveBeenCalled();
  });
});

describe('scheduled_tasks.target_machine_id 持久层', () => {
  function createDbWithConversation() {
    const db = createTestDb();
    migrateDatabase(db, mockLogger);
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
    return db;
  }

  it('mapper roundtrip：targetMachineId 落库读出', async () => {
    const db = createDbWithConversation();
    const repo = new SqliteScheduledTaskRepository(db);
    const task = makeTask({ targetMachineId: 'device-b' });
    await repo.create(task);
    const loaded = await repo.getById('task-1');
    expect(loaded?.targetMachineId).toBe('device-b');
    db.close();
  });

  it('存量行缺列语义 = null（老库迁移幂等补列）', () => {
    const db = createTestDb();
    migrateDatabase(db, mockLogger);
    // 模拟「列已存在」重复迁移——幂等不炸
    migrateDatabase(db, mockLogger);
    const row = db.prepare('SELECT target_machine_id FROM scheduled_tasks LIMIT 1').all();
    expect(row).toEqual([]);
    db.close();
  });

  it('update 可清除声明（回退对话绑定解析）', async () => {
    const db = createDbWithConversation();
    const repo = new SqliteScheduledTaskRepository(db);
    const task = makeTask({ targetMachineId: 'device-b' });
    await repo.create(task);
    await repo.update({ ...task, targetMachineId: null });
    const loaded = await repo.getById('task-1');
    expect(loaded?.targetMachineId).toBeNull();
    db.close();
  });
});
