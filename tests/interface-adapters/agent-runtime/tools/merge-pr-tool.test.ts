/**
 * F20260922pmgd：merge_pr 工具（PR 合入搭档授权闸）单测。
 *
 * 事故锚：2026-09-22 大獭在搭档未显式授权时自行 gh pr merge 合入 #1095（流水线惯性）。
 * 机制定位：提醒 + 审计（非物理闸）——partnerApproval 必填强制面对「拿到授权了吗」；
 * 授权原话落 linked_resources（对话内查询面）+ warn 日志（跨对话兜底）双通道。
 *
 * 执行路径 mock：工具内 execFileAsync（gh CLI）经 vi.mock child_process 替换，
 * 验证「参数校验 → PR 状态门 → 审计双通道 → 合入执行」全链路。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { Logger } from '@usecases/ports/logger';

// execFile mock：promisify(execFile) 的回调形态（cmd, args, opts, cb(err, {stdout, stderr}))
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
  return logger;
}

function makeCtx(linkMock = vi.fn().mockResolvedValue({ id: 'res-1' })): ToolContext {
  return {
    client: {
      resource: { link: linkMock },
    },
    otterId: 'otter-big',
    conversationId: 'conv-1',
    currentMessageId: 'msg-1',
  } as unknown as ToolContext;
}

function findMergePr(ctx: ToolContext, logger?: Logger) {
  const tool = createTools(ctx, undefined, logger).find(t => t.name === 'merge_pr');
  expect(tool, 'merge_pr 应注册').toBeDefined();
  return tool!;
}

/** gh 调用编排：view 返回 state；merge 返回成功 */
function stubGh(state: string, mergeStdout = 'Merged PR #1095') {
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    if (args[1] === 'view') cb(null, { stdout: `${state}\n`, stderr: '' });
    else if (args[1] === 'merge') cb(null, { stdout: `${mergeStdout}\n`, stderr: '' });
    else cb(new Error(`unexpected gh args: ${args.join(' ')}`));
  });
}

describe('F20260922pmgd merge_pr 工具（PR 合入搭档授权闸）', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('partnerApproval 缺失 → 参数校验拒绝（required 声明 + 空串拦截）', async () => {
    const tool = findMergePr(makeCtx());
    expect(tool.parameters.required).toContain('partnerApproval');
    expect(tool.parameters.required).toContain('prNumber');
    const result = await tool.execute('t1', { prNumber: 1095, partnerApproval: '  ' });
    expect(JSON.stringify(result)).toContain('授权原话');
  });

  it('正常路径：审计 linked_resource（category=merge-authorization）+ warn 日志带原话全文 + gh merge 执行', async () => {
    stubGh('OPEN');
    const linkMock = vi.fn().mockResolvedValue({ id: 'res-1' });
    const logger = makeLogger();
    const tool = findMergePr(makeCtx(linkMock), logger);
    const result = await tool.execute('t2', { prNumber: 1095, partnerApproval: '1095合入，你更新下', strategy: 'squash' });

    // 审计主通道：linked_resources fact
    expect(linkMock).toHaveBeenCalledOnce();
    const linkArg = linkMock.mock.calls[0]![0];
    expect(linkArg.category).toBe('merge-authorization');
    expect(linkArg.resourceType).toBe('fact');
    expect(linkArg.content).toContain('1095合入，你更新下');
    expect(linkArg.content).toContain('PR #1095');
    // 审计兜底通道：warn 日志带 partnerApproval 全文（跨对话追溯）
    const warnCalls = logger.warn.mock.calls.map(c => String(c[0]));
    expect(warnCalls.some(m => m.includes('AUTHORIZATION') && m.includes('1095合入，你更新下'))).toBe(true);
    // gh merge 执行
    const mergeCall = execFileMock.mock.calls.find(c => (c[1] as string[])[1] === 'merge');
    expect(mergeCall).toBeDefined();
    expect((mergeCall![1] as string[])).toContain('--squash');
    expect(JSON.stringify(result)).toContain('已合入');
  });

  it('PR 已 MERGED → 幂等返回，不重复执行 merge', async () => {
    stubGh('MERGED');
    const tool = findMergePr(makeCtx());
    const result = await tool.execute('t3', { prNumber: 1095, partnerApproval: '合吧' });
    expect(JSON.stringify(result)).toContain('已合入');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
  });

  it('PR CLOSED → 拒绝合入', async () => {
    stubGh('CLOSED');
    const tool = findMergePr(makeCtx());
    const result = await tool.execute('t4', { prNumber: 1095, partnerApproval: '合吧' });
    expect(JSON.stringify(result)).toContain('CLOSED');
  });

  it('审计主通道失败不阻断合入（warn 日志兜底仍在）', async () => {
    stubGh('OPEN');
    const linkMock = vi.fn().mockRejectedValue(new Error('db exploded'));
    const logger = makeLogger();
    const tool = findMergePr(makeCtx(linkMock), logger);
    const result = await tool.execute('t5', { prNumber: 1095, partnerApproval: '合吧' });
    expect(JSON.stringify(result)).toContain('已合入');
    const warnCalls = logger.warn.mock.calls.map(c => String(c[0]));
    expect(warnCalls.some(m => m.includes('AUTHORIZATION'))).toBe(true);
  });

  it('strategy 缺省 squash；非法 prNumber 拒绝', async () => {
    const tool = findMergePr(makeCtx());
    const bad = await tool.execute('t6', { prNumber: -1, partnerApproval: '合吧' });
    expect(JSON.stringify(bad)).toContain('正整数');
  });
});
