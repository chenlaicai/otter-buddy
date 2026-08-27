import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { SchedulerService, HEALING_FALLBACK_PROMPT, type CronParser } from '@usecases/scheduler/scheduler-service';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentTurnPort } from '@usecases/ports/agent-turn-port';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
import type { Logger } from '@usecases/ports/logger';

// ─── issue #416：self-healing-analysis prompt git 化 ──────
// 静态文案的真相源移到 prompts/scheduled/self-healing-analysis.md，
// 调度器运行时读模板 + 填充 {{HEALING_DATA}}。本文件验证：
// 1. 模板生效：触发的 body = 模板静态文案 + 动态 healing 数据
// 2. 无待处理事件：跳过触发（status=skipped，不发消息）
// 3. 模板文件缺失：回退到内置文案，系统仍可用

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeHealingTask(): ScheduledTask {
  return {
    id: 'task-healing',
    conversationId: 'conv-1',
    name: 'self-healing-analysis',
    scheduleType: 'cron',
    cron: '0 10 * * *',
    triggerAt: null,
    timezone: 'Asia/Shanghai',
    body: '[self-healing-analysis]',
    talkingStonePassedTo: ['otter-1'],
    senderId: 'system',
    status: 'active',
    consecutiveFailures: 0,
    lastTriggeredAt: null,
    restartBeforeInvoke: false,
    timeoutMinutes: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

/** healingRepo mock：返回 1 条 open event */
function createMockHealingRepo(openCount = 1) {
  const events = Array.from({ length: openCount }, (_, i) => ({
    id: `healing-${i}`,
    conversationId: 'conv-1',
    otterId: 'otter-1',
    messageId: `msg-${i}`,
    turnId: `turn-${i}`,
    errorType: '工具故障',
    severity: 'low',
    description: `mock healing event ${i}`,
    suggestion: null,
    status: 'open',
    resolutionAction: null,
    resolutionNotes: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }));
  return {
    autoStaleDismiss: vi.fn(async () => 0),
    getStats: vi.fn(async () => ({
      open: openCount, resolved: 0, dismissed: 0,
      byType: { 工具故障: openCount }, bySeverity: { low: openCount },
    })),
    findOpen: vi.fn(async () => events),
    // 以下是接口其余成员的 stub（trigger 路径未使用）
    findById: vi.fn(), findByMessageId: vi.fn(),
    resolve: vi.fn(), dismiss: vi.fn(), create: vi.fn(),
    getByConversationId: vi.fn(),
  } as unknown as HealingEventRepository;
}

function createMockTaskRepo(task: ScheduledTask) {
  return {
    getById: vi.fn(async () => task),
    getAllActive: vi.fn(async () => [task]),
    claimTask: vi.fn(async () => true),
    createExecution: vi.fn(async (executionId: string) => executionId),
    completeExecution: vi.fn(async () => ({})),
    updateExecutionStatus: vi.fn(async () => ({})),
    incrementConsecutiveFailures: vi.fn(async () => ({})),
    resetConsecutiveFailures: vi.fn(async () => ({})),
    updateStatus: vi.fn(async () => ({})),
  } as unknown as ScheduledTaskRepository;
}

/** 状态化捕获：sendMessage.send 发送过的 body 列表（副作用断言，避免 mock 调用断言） */
function createCapturingSendMessage() {
  const sentBodies: string[] = [];
  const send = vi.fn(async ({ body }: { body: string }) => {
    sentBodies.push(body);
    return { message: { id: `msg-${sentBodies.length}`, body } };
  });
  return { send, sentBodies };
}

const baseDeps = {
  convRepo: {
    getById: vi.fn(async () => ({ id: 'conv-1', status: 'active' })),
    getActiveTurn: vi.fn(async () => ({ id: 'turn-1' })),
  } as unknown as ConversationRepository,
  sendMessage: { send: vi.fn(async ({ body }: { body: string }) => ({ message: { id: 'msg-1', body } })) } as unknown as SendMessage,
  agentInvokePort: { invokeConversation: vi.fn(async () => ({ messageId: 'agent-msg-1', duration: 0 })), abort: vi.fn() } as unknown as AgentTurnPort,
  cronParser: { getNextTime: vi.fn(() => new Date(Date.now() + 3600_000)) } as unknown as CronParser,
  logger: mockLogger,
  manageScheduledTask: { onChange: vi.fn() } as unknown as ManageScheduledTask,
};

/** 模板 frontmatter 之后的静态文案（运行时 loadHealingTemplate 同逻辑读取） */
function readTemplateBody(): string {
  const content = fs.readFileSync('prompts/scheduled/self-healing-analysis.md', 'utf8');
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? content.slice(m[0].length) : content;
}

describe('守卫：回退文案与模板静态部分同步（#428 审视发现 1）', () => {
  it('HEALING_FALLBACK_PROMPT ≡ 模板静态部分（去占位符后逐字节一致）', () => {
    // 双源维护：模板是 git 真相源，回退文案是代码内副本。本测试锁定两者同步——
    // 改任一处不同步另一处，这里会失败。
    const templateBody = readTemplateBody();
    expect(HEALING_FALLBACK_PROMPT.trim()).toBe(templateBody.trim());
  });

  it('模板含 {{HEALING_DATA}} 占位符且仅一处', () => {
    const templateBody = readTemplateBody();
    expect(templateBody.match(/\{\{HEALING_DATA\}\}/g)).toHaveLength(1);
    expect(HEALING_FALLBACK_PROMPT.match(/\{\{HEALING_DATA\}\}/g)).toHaveLength(1);
  });
});

describe('SchedulerService - self-healing-analysis 模板化（issue #416）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('任务 body 含占位符时：触发 body = 模板静态文案 + 动态 healing 数据', async () => {
    const capturing = createCapturingSendMessage();
    const service = new SchedulerService({
      ...baseDeps,
      sendMessage: capturing as unknown as SendMessage,
      taskRepo: createMockTaskRepo(makeHealingTask()),
      healingRepo: createMockHealingRepo(2),
    });

    const result = await service.trigger('task-healing');

    expect(result.executionId).toBeTruthy();
    expect(capturing.sentBodies).toHaveLength(1);
    const effectiveBody = capturing.sentBodies[0];

    // 动态数据部分
    expect(effectiveBody).toContain('mock healing event 0');
    expect(effectiveBody).toContain('### 工具故障 (2 条)');
    expect(effectiveBody).toContain('当前系统健康概况');
    // 静态文案来自模板文件（而非硬编码重复）
    const templateBody = readTemplateBody();
    expect(effectiveBody).toContain(templateBody.replace('{{HEALING_DATA}}', '').trim().split('\n').slice(-2).join('\n'));
    // 占位符已被数据替换
    expect(effectiveBody).not.toContain('{{HEALING_DATA}}');
  });

  it('无待处理 healing events 时：跳过触发，不发送消息', async () => {
    const capturing = createCapturingSendMessage();
    const healingRepo = createMockHealingRepo(0);
    (healingRepo.findOpen as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const service = new SchedulerService({
      ...baseDeps,
      sendMessage: capturing as unknown as SendMessage,
      taskRepo: createMockTaskRepo(makeHealingTask()),
      healingRepo,
    });

    const result = await service.trigger('task-healing');

    // 副作用断言：未发送消息 + 日志记录跳过原因（状态化捕获，非 mock 调用断言）
    expect(result.executionId).toBe('');
    expect(capturing.sentBodies).toHaveLength(0);
    const skipLogged = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (args: unknown[]) => args[0] === 'Healing analysis skipped: no open events',
    );
    expect(skipLogged).toBe(true);
  });

  it('模板文件缺失时：回退到内置文案，系统仍可用', async () => {
    // 直接覆盖 loadHealingTemplate 的读取路径不可行（fs 命名空间导入不可 spy），
    // 改为修改 process.cwd 指向不存在模板的目录，让 readFileSync ENOENT
    const origCwd = process.cwd();
    process.chdir('/tmp');
    try {
    const capturing = createCapturingSendMessage();
    const service = new SchedulerService({
      ...baseDeps,
      sendMessage: capturing as unknown as SendMessage,
      taskRepo: createMockTaskRepo(makeHealingTask()),
      healingRepo: createMockHealingRepo(1),
    });

    await service.trigger('task-healing');

    expect(capturing.sentBodies).toHaveLength(1);
    const effectiveBody = capturing.sentBodies[0];
    // 回退文案包含核心指令
    expect(effectiveBody).toContain('## Self-Healing 定期分析任务');
    expect(effectiveBody).toContain('与搭档讨论，达成共识后记录决策');
    expect(effectiveBody).toContain('mock healing event 0');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('普通任务（不含占位符）：body 原样透传，不读模板', async () => {
    const capturing = createCapturingSendMessage();
    const task = makeHealingTask();
    task.name = '每日问候';
    task.body = '早上好！';
    const service = new SchedulerService({
      ...baseDeps,
      sendMessage: capturing as unknown as SendMessage,
      taskRepo: createMockTaskRepo(task),
      healingRepo: createMockHealingRepo(1),
    });

    await service.trigger('task-healing');

    expect(capturing.sentBodies).toEqual(['早上好！']);
  });
});
