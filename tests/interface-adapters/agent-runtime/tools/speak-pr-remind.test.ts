/**
 * PR 呈递三件套机械守卫测试（挂接层端到端 + 纯函数）。
 *
 * 判别力锚：检测点在 yield 边界（回合自然完成点）——speak 时刻登记必然尚未
 * 发生（正确顺序 speak→登记→yield），故 speak 侧只记录；复核覆盖任意 URL 形态
 * （原事故现场=句中夹带/仅摘要卡，独占段-only 口径会沉默）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';
import { extractPrUrls, recordTurnPrUrls, verifyTurnPrsOnYield } from '@interface-adapters/agent-runtime/tools/speak-pr-remind';
import type { ToolContext } from '@usecases/ports/agent-tools';

const PR_URL = 'https://github.com/chenlaicai/otter-buddy/pull/1947';

/** 端到端 ctx：speak 落库 + yield 交棒 + 台账查询全 mock。 */
function makeCtx(opts: { registeredPrUrls?: string[] } = {}): ToolContext {
  return {
    client: {
      conversation: {
        entry: {
          createSpeakEntry: vi.fn(async () => ({
            id: 'entry-1', entryType: 'speak', body: '', sequenceNum: 1, createdAt: '2026-11-19T00:00:00Z',
          })),
          createYieldEntry: vi.fn(async () => ({
            yieldEntry: { id: 'yield-1', sequenceNum: 2, createdAt: '2026-11-19T00:00:01Z' },
            invoke: { metadata: {} },
          })),
        },
        participant: {
          getActive: vi.fn(async () => [{ otterId: 'user', otterName: 'chen', status: 'active' }]),
        },
      },
      resource: {
        list: vi.fn(async () => (opts.registeredPrUrls ?? []).map((url, i) => ({
          id: `res-${i}`, conversationId: 'conv', resourceType: 'pr', url,
          title: null, content: null, category: null, linkedBy: 'big',
          createdAt: '2026-11-19T00:00:00Z', status: 'active',
        }))),
      },
      dispatch: {
        markDispatched: vi.fn(async () => ({ updated: 0 })),
      },
      otter: {
        getById: vi.fn(async () => null),
      },
    },
    otterId: 'big',
    conversationId: 'conv',
    currentMessageId: 'message-1',
    currentInvokeId: 'invoke-1',
    getTurnAssistantText: () => '',
  } as unknown as ToolContext;
}

function findTool(ctx: ToolContext, name: string) {
  const tool = createTools(ctx).find((t) => t.name === name)!;
  expect(tool, `${name} 应注册`).toBeDefined();
  return tool;
}

async function speak(ctx: ToolContext, body: string) {
  return findTool(ctx, 'speak').execute('call-speak', { body });
}

async function yieldTo(ctx: ToolContext) {
  return findTool(ctx, 'yield').execute('call-yield', { to: ['user'] });
}

describe('纯函数：extractPrUrls 强弱信号分层', () => {
  it('独占段 = 强信号（unfurl 口径，尾标点容忍由 scanBareUrls 承担）', () => {
    const { strong, weak } = extractPrUrls(`呈递：\n${PR_URL}。`);
    expect(strong).toEqual([PR_URL]);
    expect(weak).toEqual([]);
  });

  it('句中夹带 = 弱信号（原事故形态，独占段-only 口径会沉默）', () => {
    const { strong, weak } = extractPrUrls(`PR 已交付：${PR_URL} 请审阅`);
    expect(strong).toEqual([]);
    expect(weak).toEqual([PR_URL]);
  });

  it('markdown 链接 = 弱信号；非 GitHub 非 pull 不触发', () => {
    const { weak } = extractPrUrls(`[PR](${PR_URL}) 与 https://gitlab.com/a/b/pull/1`);
    expect(weak).toEqual([PR_URL]);
  });

  it('同 URL 两种形态并存归强信号', () => {
    const { strong } = extractPrUrls(`${PR_URL}\n再提 ${PR_URL}`);
    expect(strong).toEqual([PR_URL]);
  });
});

describe('纯函数：recordTurnPrUrls / verifyTurnPrsOnYield', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('同 URL 先弱后强出现，归并后从弱侧移除（独占段是更强证据）', async () => {
    const ctx = makeCtx();
    recordTurnPrUrls(ctx, `提及 ${PR_URL}`);
    recordTurnPrUrls(ctx, `呈递：\n${PR_URL}`);
    expect(ctx.turnPrUrls).toEqual({ strong: [PR_URL], weak: [] });
  });

  it('跨仓库同号不吞提醒（完整路径归一比对）', async () => {
    const ctx = makeCtx({ registeredPrUrls: ['https://github.com/a/one/pull/7'] });
    recordTurnPrUrls(ctx, 'https://github.com/Chenlaicai/Otter-Buddy/pull/7');
    const verdict = await verifyTurnPrsOnYield(ctx);
    expect(verdict.pass).toBe(false);
  });

  it('owner/repo 大小写归一：已登记不误报', async () => {
    const ctx = makeCtx({ registeredPrUrls: [PR_URL] });
    recordTurnPrUrls(ctx, 'https://github.com/Chenlaicai/Otter-Buddy/pull/1947');
    const verdict = await verifyTurnPrsOnYield(ctx);
    expect(verdict.pass).toBe(true);
  });
});

describe('挂接层端到端：speak 记录 → yield 复核', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('正确流程（speak 独占段→已登记→yield）：静默放行，无误报', async () => {
    const ctx = makeCtx({ registeredPrUrls: [PR_URL] });
    const sp = await speak(ctx, `修复完成：\n${PR_URL}`);
    expect(sp.isError).toBeFalsy();
    const y = await yieldTo(ctx);
    expect(y.isError).toBeFalsy();
  });

  it('漏登记流程（独占段强信号）：yield 首次拒绝顶回；补登记后再 yield 放行', async () => {
    const ctx = makeCtx();
    await speak(ctx, `修复完成：\n${PR_URL}`);
    const rejected = await yieldTo(ctx);
    expect(rejected.isError).toBe(true);
    expect(String((rejected as { content: Array<{ text: string }> }).content[0].text)).toContain('三件套未齐');
    // 补登记（台账出现）→ 同回合二次 yield 复核通过
    (ctx.client.resource.list as ReturnType<typeof vi.fn>).mockImplementation(async () => [
      { id: 'res-1', conversationId: 'conv', resourceType: 'pr', url: PR_URL,
        title: null, content: null, category: null, linkedBy: 'big',
        createdAt: '2026-11-19T00:00:00Z', status: 'active' },
    ]);
    const pass = await yieldTo(ctx);
    expect(pass.isError).toBeFalsy();
  });

  it('原事故形态（句中夹带弱信号）：yield 拒绝不再沉默；确认仅提及后二次放行', async () => {
    const ctx = makeCtx();
    await speak(ctx, `PR 已交付：${PR_URL} 请审阅`);
    const rejected = await yieldTo(ctx);
    expect(rejected.isError).toBe(true);
    const text = String((rejected as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('非独占段');
    expect(text).toContain('重新 yield');
    const pass = await yieldTo(ctx);
    expect(pass.isError).toBeFalsy();
  });

  it('普通发言回合（无 PR URL）：yield 直接放行，台账零查询', async () => {
    const ctx = makeCtx();
    await speak(ctx, '进展顺利，继续。');
    const y = await yieldTo(ctx);
    expect(y.isError).toBeFalsy();
    expect((ctx.client.resource.list as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
