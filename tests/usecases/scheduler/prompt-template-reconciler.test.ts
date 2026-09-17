import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { reconcilePromptTemplates } from '@usecases/scheduler/prompt-template-reconciler';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { Logger } from '@usecases/ports/logger';

// ─── #784：定时任务 prompt 启动对账 ──────
// prompts/scheduled/*.md 是真相源（PR #428 git 化），DB body 是运行时副本。
// 本文件验证对账核心语义：
// 1. 漂移同步：DB body ≠ 模板 → 更新（含 disabled 任务）
// 2. 已同步跳过；dynamic 模板跳过；无匹配任务只记 unmatched 不视为错误
// 3. 匹配规则：frontmatter task_name 精确匹配 / 无 task_name 时 kebab(任务名)=文件名
// 4. JSON 包装形态（paper-trading）：只替换内层 prompt，watchlist 等运行时字段保留
// 5. 对账失败（目录不可读）不抛——失败不阻塞启动

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    conversationId: 'conv-1',
    name: '测试任务',
    scheduleType: 'cron',
    cron: '0 9 * * *',
    triggerAt: null,
    timezone: 'Asia/Shanghai',
    body: 'old body',
    description: null,
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

function createMockRepo(tasks: ScheduledTask[]) {
  const store = new Map(tasks.map(t => [t.id, { ...t }]));
  return {
    store,
    getAll: vi.fn(async () => Array.from(store.values()).map(t => ({ ...t }))),
    update: vi.fn(async (task: ScheduledTask) => {
      store.set(task.id, { ...task });
    }),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-reconcile-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('#784 prompt 启动对账', () => {
  it('漂移同步：DB body ≠ 模板 → 更新 body', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daily-x.md'), `---\ntask_name: 每日X\n---\n新模板内容`);
    const repo = createMockRepo([makeTask({ name: '每日X', body: '旧内容' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(1);
    expect(repo.store.get('task-1')?.body).toBe('新模板内容');
    expect(result.unmatched).toEqual([]);
  });

  it('已同步：trim 相等即跳过（frontmatter 前后空白容忍）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daily-x.md'), `---\ntask_name: 每日X\n---\n\n内容\n\n`);
    const repo = createMockRepo([makeTask({ name: '每日X', body: '内容' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(0);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('disabled 任务同样对账（重新启用时该跑新 prompt）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daily-x.md'), `---\ntask_name: 每日X\n---\n新版`);
    const repo = createMockRepo([makeTask({ name: '每日X', body: '旧版', status: 'disabled' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(1);
    expect(repo.store.get('task-1')?.body).toBe('新版');
  });

  it('dynamic 模板跳过（body 由调度器运行时填充占位符，issue #416）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dyn.md'), `---\ntask_name: 动态任务\ndynamic: true\n---\n占位 {{DATA}}`);
    const repo = createMockRepo([makeTask({ id: 'task-1', name: '动态任务', body: '[动态任务]' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.skippedDynamic).toBe(1);
    expect(result.checked).toBe(0);
    expect(result.updated).toBe(0);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('匹配规则：无 task_name 时 kebab(任务名) = 文件名', async () => {
    fs.writeFileSync(path.join(tmpDir, 'paper-trading-daily.md'), `# 操盘每日\n内容`);
    const repo = createMockRepo([makeTask({ name: 'Paper Trading Daily', body: '旧' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(1);
    expect(result.unmatched).toEqual([]);
  });

  it('无匹配任务：记 unmatched，不报错不更新', async () => {
    fs.writeFileSync(path.join(tmpDir, 'orphan.md'), `---\ntask_name: 不存在的任务\n---\n内容`);
    const repo = createMockRepo([makeTask({ name: '每日X', body: '旧' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(0);
    expect(result.unmatched).toEqual(['orphan']);
  });

  it('task_name 优先且不 fallback：模板带 task_name 时即使 kebab 能匹配也不走文件名匹配（检视建议 1）', async () => {
    // 模板文件名 daily-x 可 kebab 匹配任务「Daily X」，但模板 task_name 指向另一个不存在
    // 的名字——精确键优先，不应 fallback 到文件名匹配误碰该任务
    fs.writeFileSync(path.join(tmpDir, 'daily-x.md'), `---\ntask_name: 别的任务\n---\n新内容`);
    const repo = createMockRepo([makeTask({ name: 'Daily X', body: '旧' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(0);
    expect(result.unmatched).toEqual(['daily-x']);
    expect(repo.store.get('task-1')?.body).toBe('旧');
  });

  it('单任务 DB 写入失败：不阻塞其余模板对账（检视建议 2）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a-1.md'), `---\ntask_name: 任务A\n---\nA 新`);
    fs.writeFileSync(path.join(tmpDir, 'b-2.md'), `---\ntask_name: 任务B\n---\nB 新`);
    const repo = createMockRepo([
      makeTask({ id: 'task-a', name: '任务A', body: 'A 旧' }),
      makeTask({ id: 'task-b', name: '任务B', body: 'B 旧' }),
    ]);
    // 首个 update 失败，第二个应继续成功
    repo.update.mockRejectedValueOnce(new Error('db write boom'));

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(1);
    expect(repo.store.get('task-a')?.body).toBe('A 旧');
    expect(repo.store.get('task-b')?.body).toBe('B 新');
  });

  it('JSON 包装形态：只替换内层 prompt，watchlist 保留（#610 对偶面）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'paper-trading-daily.md'), `---\ntask_name: paper-trading-daily-trading\n---\n操盘新 prompt`);
    const wrapped = JSON.stringify({ prompt: '操盘旧 prompt', watchlist: ['600519', '000001'] });
    const repo = createMockRepo([makeTask({ name: 'paper-trading-daily-trading', body: wrapped })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(1);
    const updated = JSON.parse(repo.store.get('task-1')!.body);
    expect(updated.prompt).toBe('操盘新 prompt');
    expect(updated.watchlist).toEqual(['600519', '000001']);
  });

  it('JSON 包装形态：内层已同步则跳过', async () => {
    fs.writeFileSync(path.join(tmpDir, 'paper-trading-daily.md'), `---\ntask_name: paper-trading-daily-trading\n---\n操盘 prompt`);
    const wrapped = JSON.stringify({ prompt: '操盘 prompt', watchlist: ['600519'] });
    const repo = createMockRepo([makeTask({ name: 'paper-trading-daily-trading', body: wrapped })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(0);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('非 prompt 字段的 JSON（如 match-orders 的 {}）：不误伤，走 unmatched/跳过路径', async () => {
    fs.writeFileSync(path.join(tmpDir, 'x.md'), `---\ntask_name: 其他任务\n---\n内容`);
    const repo = createMockRepo([makeTask({ name: 'paper-trading-match-orders', body: '{}' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.updated).toBe(0);
    expect(result.unmatched).toEqual(['x']);
    expect(repo.store.get('task-1')?.body).toBe('{}');
  });

  it('模板目录不可读：warn 不抛（对账失败不阻塞启动）', async () => {
    const repo = createMockRepo([makeTask({ name: '每日X' })]);

    const result = await reconcilePromptTemplates({
      taskRepo: repo,
      logger: mockLogger,
      templateDir: path.join(tmpDir, 'not-exists'),
    });

    expect(result.updated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('更新时保持任务其余字段不变，updatedAt 刷新', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daily-x.md'), `---\ntask_name: 每日X\n---\n新版`);
    const task = makeTask({ name: '每日X', body: '旧版', cron: '0 10 * * *', talkingStonePassedTo: ['otter-9'] });
    const repo = createMockRepo([task]);

    await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    const updated = repo.store.get('task-1')!;
    expect(updated.body).toBe('新版');
    expect(updated.cron).toBe('0 10 * * *');
    expect(updated.talkingStonePassedTo).toEqual(['otter-9']);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(task.updatedAt).getTime());
  });
});

// ─── issue #429：默认 templateDir 不依赖 cwd ──────
describe('默认 templateDir（#429）', () => {
  beforeEach(() => {
    // Why: mockLogger 全文件共享，历史用例的「目录不可读」告警会串台——只看本轮调用
    vi.clearAllMocks();
  });

  it('不传 templateDir 且 cwd 非项目根时：仍基于代码位置找到 prompts/scheduled 并完成对账', async () => {
    // 验证默认路径收口到 getRepoRoot()：cwd 切到临时目录（模拟 systemd WorkingDirectory），
    // 对账仍能读到真实模板目录而非走「目录不可读跳过」降级分支。
    const origCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-cwd-test-'));
    process.chdir(tmpDir);
    try {
      const repo = createMockRepo([]);
      const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger });
      // 真模板目录可读：不会落入「目录不可读跳过」分支（checked=0 且 warn 打出）。
      // 真目录模板与空 repo 全不匹配 → 全部进 unmatched，证明确实逐文件读到了真模板。
      expect(result.unmatched.length).toBeGreaterThan(0);
      expect(result.checked).toBe(0); // 无匹配任务，无 body 同步
      // 关键：本轮新增过「目录不可读」告警 = 默认目录解析失败（读到了不存在的路径）
      const dirWarnedNow = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        (args: unknown[]) => String(args[0]).includes('模板目录不可读'),
      );
      expect(dirWarnedNow).toBe(false);
    } finally {
      process.chdir(origCwd);
    }
  });
});

// ─── issue #1030：对账失败不得静默（降级不哑）──────
describe('#1030 同步失败显式暴露', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // mockLogger 全文件共享，防历史用例串台（同 #429 块惯例）
  });

  it('DB 写入失败：warn 降级跳过，但 failed 明细累计且 error 级汇总打日志', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daily-x.md'), `---\ntask_name: 每日X\n---\n新版`);
    const base = createMockRepo([makeTask({ name: '每日X', body: '旧版' })]);
    // 模拟 CHECK 约束类写入失败（#1030 现场：SqliteError CHECK constraint failed）
    const failingRepo = { ...base, update: vi.fn(async () => { throw new Error('SqliteError: CHECK constraint failed'); }) };

    const result = await reconcilePromptTemplates({ taskRepo: failingRepo as unknown as typeof base, logger: mockLogger, templateDir: tmpDir });

    // 降级：单任务失败不抛、不阻塞
    expect(result.updated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalled();
    // 不哑：失败明细进 result.failed，error 级汇总暴露「DB 将跑旧版」
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]).toContain('每日X');
    expect(result.failed[0]).toContain('CHECK constraint failed');
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) => String(args[0]));
    expect(errorCalls.some(c => c.includes('同步失败') && c.includes('旧版'))).toBe(true);
  });

  it('全部同步成功：无 failed、不打 error（不制造噪音）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daily-x.md'), `---\ntask_name: 每日X\n---\n新版`);
    const repo = createMockRepo([makeTask({ name: '每日X', body: '旧版' })]);

    const result = await reconcilePromptTemplates({ taskRepo: repo, logger: mockLogger, templateDir: tmpDir });

    expect(result.failed).toEqual([]);
    expect(result.updated).toBe(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
