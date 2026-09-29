/**
 * F20260922pmgd：merge_pr 工具（PR 合入搭档授权闸）单测。
 *
 * 事故锚：2026-09-22 大獭在搭档未显式授权时自行 gh pr merge 合入 #1095（流水线惯性）。
 * 机制定位：v1 提醒 + 审计 → F20260929mpav v2 物理闸——partnerApproval 逐字命中搭档消息；
 * 授权原话落 linked_resources（对话内查询面）+ warn 日志（跨对话兜底）双通道。
 *
 * F20260929mpav：v2 升级真伪校验（物理闸）。事故锚：2026-09-29 大獭在 PR #1201
 * 合入时把自我推理文本塞进 partnerApproval，零校验照单全收落了审计——触发 v1 文档
 * U1 预留的升级条件（「出现伪造授权原话事故即升级真伪校验」）。
 * partnerApproval 必须逐字命中搭档（user）历史消息（容忍空白/引号形态差异；
 * 短引用<4字须整条等值防否定句断章；html-card-reply 围栏 JSON 剔除匹配面），
 * 未命中拒绝执行；查询失败/畸形返回 fail-closed。
 *
 * 执行路径 mock：工具内 execFileAsync（gh CLI）经 vi.mock child_process 替换，
 * 验证「参数校验 → PR 状态门 → 原话校验 → 审计双通道 → 合入执行」全链路。
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

/** 默认搭档消息集：覆盖既有用例的授权文本（原话校验闸 v2 起必须命中才放行） */
const DEFAULT_USER_ENTRIES = [
  { id: 'ue-1', entryType: 'user', senderType: 'user', senderId: 'user', body: 'CI 绿了就 1095合入，你更新下', sequenceNum: 101, createdAt: '2026-09-22T03:00:00.000Z' },
  { id: 'ue-2', entryType: 'user', senderType: 'user', senderId: 'user', body: '这个可以合了，合吧', sequenceNum: 102, createdAt: '2026-09-22T03:05:00.000Z' },
];

function makeCtx(
  linkMock = vi.fn().mockResolvedValue({ id: 'res-1' }),
  getEntriesMock: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(DEFAULT_USER_ENTRIES),
): ToolContext {
  return {
    client: {
      resource: { link: linkMock },
      conversation: { entry: { getEntries: getEntriesMock } },
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

  it('正常路径：审计 linked_resource（category=merge-authorization，v2 起附命中锚点）+ warn 日志带原话全文 + gh merge 执行', async () => {
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
    expect(linkArg.content).toContain('ue-1'); // F20260929mpav：审计附命中锚点（entryId），事后可回查语境
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
    const result = await tool.execute('t5', { prNumber: 1095, partnerApproval: '这个可以合了，合吧' });
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

describe('F20260929mpav 原话校验闸（无原话不允许合入）', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  /** 事故重放：2026-09-29 PR #1201 合入，partnerApproval 塞的是自我推理文本 */
  const INCIDENT_TEXT = '已合入——不对，搭档在 #1201 的授权不是这句，此处授权不明确，应先确认';

  it('事故重放：推理/拼接文本非搭档消息子串 → 拒绝执行，不落审计不执行 merge', async () => {
    stubGh('OPEN');
    const linkMock = vi.fn().mockResolvedValue({ id: 'res-1' });
    const logger = makeLogger();
    const tool = findMergePr(makeCtx(linkMock), logger);
    const result = await tool.execute('v1', { prNumber: 1201, partnerApproval: INCIDENT_TEXT });
    expect(JSON.stringify(result)).toContain('未在搭档历史消息中命中');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
    expect(linkMock).not.toHaveBeenCalled();
  });

  it('拼接绕过固化：「1095」与「合入」分属两条消息，拼接串 → 拒绝', async () => {
    stubGh('OPEN');
    const entries = [
      { id: 'ue-a', entryType: 'user', senderType: 'user', senderId: 'user', body: '看下 1095 这个 PR', sequenceNum: 201, createdAt: '2026-09-29T03:00:00.000Z' },
      { id: 'ue-b', entryType: 'user', senderType: 'user', senderId: 'user', body: '另外记得把文档补齐，合入前检查', sequenceNum: 202, createdAt: '2026-09-29T03:01:00.000Z' },
    ];
    const getEntriesMock = vi.fn().mockResolvedValue(entries);
    const linkMock = vi.fn().mockResolvedValue({ id: 'res-1' });
    const tool = findMergePr(makeCtx(linkMock, getEntriesMock));
    const result = await tool.execute('v2', { prNumber: 1095, partnerApproval: '1095 合入' });
    expect(JSON.stringify(result)).toContain('未在搭档历史消息中命中');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
  });

  it('getEntries 查询失败 → fail-closed 拒绝（不执行 merge 不落审计）', async () => {
    stubGh('OPEN');
    const getEntriesMock = vi.fn().mockRejectedValue(new Error('db locked'));
    const linkMock = vi.fn().mockResolvedValue({ id: 'res-1' });
    const tool = findMergePr(makeCtx(linkMock, getEntriesMock));
    const result = await tool.execute('v3', { prNumber: 1095, partnerApproval: '1095合入，你更新下' });
    expect(JSON.stringify(result)).toContain('fail-closed');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
    expect(linkMock).not.toHaveBeenCalled();
  });

  it('user entries 为空 → 拒绝（无原话不允许使用）', async () => {
    stubGh('OPEN');
    const getEntriesMock = vi.fn().mockResolvedValue([]);
    const tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    const result = await tool.execute('v4', { prNumber: 1095, partnerApproval: '合吧' });
    expect(JSON.stringify(result)).toContain('未在搭档历史消息中命中');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
  });

  it('引号形态差异：搭档说「这个可以合了」，引用加中英引号包裹 → 放行', async () => {
    stubGh('OPEN');
    const entries = [
      { id: 'ue-q', entryType: 'user', senderType: 'user', senderId: 'user', body: 'CI 绿了，这个可以合了', sequenceNum: 301, createdAt: '2026-09-29T04:00:00.000Z' },
    ];
    const makeTool = () => {
      const getEntriesMock = vi.fn().mockResolvedValue(entries);
      return findMergePr(makeCtx(vi.fn(), getEntriesMock));
    };
    for (const quoted of ['“这个可以合了”', '"这个可以合了"', "'这个可以合了'", '「这个可以合了」', '『这个可以合了』', '『『这个可以合了』』']) {
      const result = await makeTool().execute('v5', { prNumber: 1095, partnerApproval: quoted });
      expect(JSON.stringify(result)).toContain('已合入');
    }
  });

  it('跨空白变形：搭档消息「1095 可以合入了」，引用丢空格成「1095可以合入了」→ 命中（真锁：删去空白比对逻辑则红）', async () => {
    stubGh('OPEN');
    const entries = [
      { id: 'ue-w', entryType: 'user', senderType: 'user', senderId: 'user', body: '1095 可以合入了\n另外标题记得改', sequenceNum: 311, createdAt: '2026-09-29T04:10:00.000Z' },
    ];
    const getEntriesMock = vi.fn().mockResolvedValue(entries);
    const tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    const result = await tool.execute('v6', { prNumber: 1095, partnerApproval: '1095可以合入了' });
    expect(JSON.stringify(result)).toContain('已合入');
  });

  it('命中锚点落在 audit 日志与 fact：entryId + seq 可回查', async () => {
    stubGh('OPEN');
    const linkMock = vi.fn().mockResolvedValue({ id: 'res-1' });
    const logger = makeLogger();
    const tool = findMergePr(makeCtx(linkMock), logger);
    await tool.execute('v7', { prNumber: 1095, partnerApproval: '这个可以合了，合吧' });
    expect(linkMock).toHaveBeenCalledOnce();
    const content = linkMock.mock.calls[0]![0].content as string;
    expect(content).toContain('ue-2');
    expect(content).toContain('102');
    expect(content).toContain('这个可以合了'); // SG1：审计附命中片段文本，断章核对一眼化
  });

  it('校验查询限定 user 类型（entryType 参数断言，防止未来实现漂移拉全量）', async () => {
    stubGh('OPEN');
    const getEntriesMock = vi.fn().mockResolvedValue(DEFAULT_USER_ENTRIES);
    const tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    await tool.execute('v8', { prNumber: 1095, partnerApproval: '1095合入，你更新下' });
    expect(getEntriesMock).toHaveBeenCalled();
    const arg = getEntriesMock.mock.calls[0]![1] as { entryType?: string };
    expect(arg.entryType).toBe('user');
  });

  it('仅纯标点的引用 → 拒绝（真锁：句号/逗号/角括号/叹号在纯标点放行实现下会过闸）', async () => {
    stubGh('OPEN');
    for (const punct of ['。', '，', '「」', '!!!']) {
      const tool = findMergePr(makeCtx());
      const result = await tool.execute('v9', { prNumber: 1095, partnerApproval: punct });
      expect(JSON.stringify(result)).toContain('无实义内容');
      expect(JSON.stringify(result)).not.toContain('已合入');
    }
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
  });

  it('S1 否定句断章：搭档说「这个 PR 先不合入」，从否定句里抠「合入」二字 → 拒绝', async () => {
    stubGh('OPEN');
    const entries = [
      { id: 'ue-neg', entryType: 'user', senderType: 'user', senderId: 'user', body: '这个 PR 先不合入，等 CI 全绿再说', sequenceNum: 321, createdAt: '2026-09-29T04:20:00.000Z' },
    ];
    const getEntriesMock = vi.fn().mockResolvedValue(entries);
    const tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    const result = await tool.execute('v10', { prNumber: 1095, partnerApproval: '合入' });
    expect(JSON.stringify(result)).toContain('未在搭档历史消息中命中');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
  });

  it('S1 短引用整条等值豁免：搭档独立回「好」/「合吧」（整条就是授权）→ 放行；从长句抠「合吧」→ 拒', async () => {
    stubGh('OPEN');
    // 整条等值：搭档独立成条说「合吧」
    const wholeEntries = [
      { id: 'ue-short', entryType: 'user', senderType: 'user', senderId: 'user', body: '合吧', sequenceNum: 331, createdAt: '2026-09-29T04:30:00.000Z' },
    ];
    let getEntriesMock = vi.fn().mockResolvedValue(wholeEntries);
    let tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    let result = await tool.execute('v11a', { prNumber: 1095, partnerApproval: '合吧' });
    expect(JSON.stringify(result)).toContain('已合入');
    // 从长句抠短片段：搭档说「CI 绿了，先不合吧，等会儿」，抠「合吧」→ 拒
    const longEntries = [
      { id: 'ue-long', entryType: 'user', senderType: 'user', senderId: 'user', body: 'CI 绿了，先不合吧，等会儿', sequenceNum: 332, createdAt: '2026-09-29T04:31:00.000Z' },
    ];
    execFileMock.mockClear();
    stubGh('OPEN');
    getEntriesMock = vi.fn().mockResolvedValue(longEntries);
    tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    result = await tool.execute('v11b', { prNumber: 1095, partnerApproval: '合吧' });
    expect(JSON.stringify(result)).toContain('未在搭档历史消息中命中');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
  });

  it('M3 卡片回执围栏：html-card-reply data JSON 是 agent 构造载荷不可作授权源——从围栏 JSON 抠文本 → 拒；从人类可读摘要抠 → 过', async () => {
    stubGh('OPEN');
    const receiptEntries = [
      {
        id: 'ue-receipt', entryType: 'user', senderType: 'user', senderId: 'user',
        body: '已选择：合入 PR #1095\n\n```html-card-reply card="msg-9:0"\n{"choice":"merge_1095","secret":"975d2c0f8a"}\n```',
        sequenceNum: 341, createdAt: '2026-09-29T04:40:00.000Z',
      },
    ];
    const getEntriesMock = vi.fn().mockResolvedValue(receiptEntries);
    // 从摘要抠（合法：搭档点按钮产生的可读文本）
    let tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    let result = await tool.execute('v12a', { prNumber: 1095, partnerApproval: '合入 PR #1095' });
    expect(JSON.stringify(result)).toContain('已合入');
    // 从围栏 JSON 抠（非法：agent 自构造载荷冒充授权）
    execFileMock.mockClear();
    stubGh('OPEN');
    tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    result = await tool.execute('v12b', { prNumber: 1095, partnerApproval: 'secret":"975d2c0f8a' });
    expect(JSON.stringify(result)).toContain('未在搭档历史消息中命中');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
  });

  it('SG2 畸形返回兜底：getEntries 返回非数组 → fail-closed 拒绝', async () => {
    stubGh('OPEN');
    const getEntriesMock = vi.fn().mockResolvedValue({ not: 'array' });
    const tool = findMergePr(makeCtx(vi.fn(), getEntriesMock));
    const result = await tool.execute('v13', { prNumber: 1095, partnerApproval: '1095合入，你更新下' });
    expect(JSON.stringify(result)).toContain('fail-closed');
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[1] === 'merge')).toHaveLength(0);
  });
});
