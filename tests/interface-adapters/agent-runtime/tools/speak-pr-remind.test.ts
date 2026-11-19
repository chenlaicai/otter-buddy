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
        // 登记侧端到端——create_linked_resource 真实工具路径依赖 link；
        // 按入参回显资源（断开 prRemindGuardNoteOnLink 挂接时相关用例变红）
        link: vi.fn(async (input: Record<string, unknown>) => ({
          id: `res-${input.resourceType}`, conversationId: 'conv',
          resourceType: input.resourceType, url: input.url ?? null,
          title: input.title ?? null, content: input.content ?? null,
          category: input.category ?? null, linkedBy: 'big',
          createdAt: '2026-11-19T00:00:00Z', status: 'active',
          groupId: input.groupId ?? null,
        })),
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
    expect(ctx.turnPrUrls).toEqual({ strong: [PR_URL], weak: [], registered: [] });
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

  it('原事故形态（句中夹带弱信号，未登记）：yield 拒绝不再沉默；确认仅提及后二次放行', async () => {
    const ctx = makeCtx();
    await speak(ctx, `PR 已交付：${PR_URL} 请审阅`);
    const rejected = await yieldTo(ctx);
    expect(rejected.isError).toBe(true);
    const text = String((rejected as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('非独占段形态');
    expect(text).toContain('重新 yield');
    const pass = await yieldTo(ctx);
    expect(pass.isError).toBeFalsy();
  });

  it('原事故形态一（句中夹带 + 台账已登记）：不变量二拒绝——无裸链独占段则无 unfurl 卡', async () => {
    const ctx = makeCtx({ registeredPrUrls: [PR_URL] });
    await speak(ctx, `PR 已交付：${PR_URL} 请审阅`);
    const rejected = await yieldTo(ctx);
    expect(rejected.isError).toBe(true);
    const text = String((rejected as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('无裸链独占段');
    expect(text).toContain('裸写独占一段');
    const pass = await yieldTo(ctx);
    expect(pass.isError).toBeFalsy();
  });

  it('原事故形态二（create_linked_resource pr 登记 + 正文无裸链）：不变量二拒绝补裸链（登记侧真实工具路径）', async () => {
    const ctx = makeCtx();
    await speak(ctx, 'PR 已交付，摘要卡已登记。');
    const link = await findTool(ctx, 'create_linked_resource').execute('call-link', {
      resourceType: 'pr', url: PR_URL, groupId: 'F20261119prset',
    });
    expect(link.isError).toBeFalsy();
    const rejected = await yieldTo(ctx);
    expect(rejected.isError).toBe(true);
    const text = String((rejected as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('无裸链独占段');
    expect(text).toContain('unfurl');
  });

  it('登记引导（fact 含 PR URL）：创建回执附引导改 pr 类型但不阻断 fact 创建（真实工具路径）', async () => {
    const ctx = makeCtx();
    const link = await findTool(ctx, 'create_linked_resource').execute('call-link', {
      resourceType: 'fact', content: `PR ${PR_URL} 已交付`,
    });
    expect(link.isError).toBeFalsy();
    const text = String((link as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('Linked resource created');
    expect(text).toContain('resourceType=pr');
    // 对照：不含 PR URL 的 fact 回执无引导
    const plain = await findTool(ctx, 'create_linked_resource').execute('call-link-2', {
      resourceType: 'fact', content: '普通事实记录',
    });
    expect(String((plain as { content: Array<{ text: string }> }).content[0].text)).not.toContain('resourceType=pr');
  });

  it('普通发言回合（无 PR URL）：yield 直接放行，台账零查询', async () => {
    const ctx = makeCtx();
    await speak(ctx, '进展顺利，继续。');
    const y = await yieldTo(ctx);
    expect(y.isError).toBeFalsy();
    expect((ctx.client.resource.list as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('delta 2：多 PR 混合缺口与部分修复（缺口快照比对）', () => {
  const URL_A = 'https://github.com/chenlaicai/otter-buddy/pull/1962';
  const URL_B = 'https://github.com/chenlaicai/otter-buddy/pull/1964';

  function mockRegistered(ctx: ToolContext, urls: string[]) {
    (ctx.client.resource.list as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      urls.map((url, i) => ({
        id: `res-${i}`, conversationId: 'conv', resourceType: 'pr', url,
        title: null, content: null, category: null, linkedBy: 'big',
        createdAt: '2026-11-19T00:00:00Z', status: 'active',
      })),
    );
  }

  it('混合缺口首次拒绝：回执同时列出 A 登记缺口与 B 裸链缺口（不吞类）', async () => {
    const ctx = makeCtx({ registeredPrUrls: [URL_B] });
    await speak(ctx, `修复 A：\n${URL_A}`);         // A 强信号未登记 → 不变量一
    await speak(ctx, `另 B 已交付：${URL_B} 请审阅`); // B 弱信号已登记 → 不变量二
    const rejected = await yieldTo(ctx);
    expect(rejected.isError).toBe(true);
    const text = String((rejected as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('第三步缺席');
    expect(text).toContain('无裸链独占段');
    expect(text).toContain('otter-buddy/pull/1962');
    expect(text).toContain('otter-buddy/pull/1964');
  });

  it('部分修复不再假闭环：补 A 登记后二次 yield 仍拒绝，回执只剩 B 裸链缺口', async () => {
    const ctx = makeCtx({ registeredPrUrls: [URL_B] });
    await speak(ctx, `修复 A：\n${URL_A}`);
    await speak(ctx, `另 B 已交付：${URL_B} 请审阅`);
    const first = await yieldTo(ctx);
    expect(first.isError).toBe(true);
    mockRegistered(ctx, [URL_A, URL_B]); // 按回执补 A 登记（台账出现）
    const second = await yieldTo(ctx);
    expect(second.isError).toBe(true); // 缺口减少 ≠ 零进展 → 继续拒绝
    const text = String((second as { content: Array<{ text: string }> }).content[0].text);
    expect(text).not.toContain('第三步缺席');
    expect(text).toContain('无裸链独占段');
    expect(text).toContain('otter-buddy/pull/1964');
  });

  it('完全修复放行：补 A 登记 + B 补裸链独占段 → yield 通过', async () => {
    const ctx = makeCtx({ registeredPrUrls: [URL_B] });
    await speak(ctx, `修复 A：\n${URL_A}`);
    await speak(ctx, `另 B：${URL_B}`);
    await yieldTo(ctx); // 首次拒绝（快照 m:[A] p:[B]）
    mockRegistered(ctx, [URL_A, URL_B]); // 补 A 登记
    await speak(ctx, `呈递 B：\n${URL_B}`); // B 升强信号（裸链独占段）
    const pass = await yieldTo(ctx);
    expect(pass.isError).toBeFalsy();
  });

  it('零进展二次 yield 放行（防死循环出口保留）且交棒回执留声', async () => {
    const ctx = makeCtx();
    await speak(ctx, `修复完成：\n${PR_URL}`);
    const first = await yieldTo(ctx);
    expect(first.isError).toBe(true);
    const pass = await yieldTo(ctx); // 未做任何修复 → 缺口与快照相同
    expect(pass.isError).toBeFalsy();
    const text = String((pass as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('交棒成功');
    expect(text).toContain('视为确认放行');
    expect(text).toContain('第三步缺席');
  });

  it('新违反再拒：首次拒绝后 speak 新增未登记独占段 → 二次 yield 拒绝', async () => {
    const ctx = makeCtx();
    await speak(ctx, `提及 ${PR_URL}`);
    await yieldTo(ctx); // 首次拒绝（快照 w:[1947]）
    await speak(ctx, '新呈递：\nhttps://github.com/chenlaicai/otter-buddy/pull/1990');
    const second = await yieldTo(ctx); // 缺口新增 m:[1990] ≠ 快照 → 再拒
    expect(second.isError).toBe(true);
    const text = String((second as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('第三步缺席');
    expect(text).toContain('pull/1990');
  });
});
