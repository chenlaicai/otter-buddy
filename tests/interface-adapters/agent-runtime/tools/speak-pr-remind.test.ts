/**
 * speak PR 呈递三件套机械守卫单测（检测函数纯逻辑 + 挂接行为）。
 *
 * 判别力锚：完整重做裁决（打补丁 PR 的元教训）——检测口径只认独占段
 * （与 unfurl 同口径）、台账匹配按尾号宽松比对、提醒不代替登记。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractStandalonePrUrls, remindUnregisteredPrs } from '@interface-adapters/agent-runtime/tools/speak-pr-remind';
import type { ToolContext } from '@usecases/ports/agent-tools';

describe('extractStandalonePrUrls 检测口径', () => {
  it('独占一段的 PR URL 被提取（含前后空白容忍）', () => {
    const body = '修复完成，呈递：\n\n  https://github.com/chenlaicai/otter-buddy/pull/1947  \n\n请审阅。';
    expect(extractStandalonePrUrls(body)).toEqual(['https://github.com/chenlaicai/otter-buddy/pull/1947']);
  });

  it('多条独占段去重并保持出现顺序', () => {
    const body = [
      'https://github.com/a/b/pull/1',
      '中间说明',
      'https://github.com/a/b/pull/2',
      'https://github.com/a/b/pull/1',
    ].join('\n');
    expect(extractStandalonePrUrls(body)).toEqual([
      'https://github.com/a/b/pull/1',
      'https://github.com/a/b/pull/2',
    ]);
  });

  it('句中夹带不触发（那是提及不是呈递，与 unfurl 口径一致）', () => {
    const body = '参见 https://github.com/a/b/pull/3 的讨论';
    expect(extractStandalonePrUrls(body)).toEqual([]);
  });

  it('markdown 链接形态不触发（规范本来就要求裸写）', () => {
    const body = '[PR](https://github.com/a/b/pull/4)';
    expect(extractStandalonePrUrls(body)).toEqual([]);
  });

  it('非 GitHub 域名/非 pull 路径不触发', () => {
    const body = 'https://gitlab.com/a/b/pull/5\nhttps://github.com/a/b/issues/6';
    expect(extractStandalonePrUrls(body)).toEqual([]);
  });
});

function makeCtx(prResources: Array<{ url: string | null }>): ToolContext {
  return {
    conversationId: 'conv-1',
    client: {
      resource: {
        list: vi.fn(async () => prResources.map((r, i) => ({
          id: `res-${i}`, conversationId: 'conv-1', resourceType: 'pr',
          url: r.url, title: null, content: null, category: null,
          linkedBy: 'otter-1', createdAt: '2026-11-19T00:00:00Z', status: 'active',
        }))),
      },
    },
  } as unknown as ToolContext;
}

describe('remindUnregisteredPrs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('独占段 PR 未登记台账 → 返回带 PR 号的第三步提醒', async () => {
    const body = '呈递：\nhttps://github.com/chenlaicai/otter-buddy/pull/9999';
    const remind = await remindUnregisteredPrs(makeCtx([]), body);
    expect(remind).toContain('PR #9999');
    expect(remind).toContain('create_linked_resource');
  });

  it('台账已有同尾号登记（URL 形态不同）→ 不提醒', async () => {
    const body = '呈递：\nhttps://github.com/Chenlaicai/Otter-Buddy/pull/1947';
    const ctx = makeCtx([{ url: 'https://github.com/chenlaicai/otter-buddy/pull/1947' }]);
    expect(await remindUnregisteredPrs(ctx, body)).toBeNull();
  });

  it('无独占段（句中夹带）→ 不查询不提醒', async () => {
    const body = '讨论 https://github.com/a/b/pull/1 的事';
    const ctx = makeCtx([]);
    expect(await remindUnregisteredPrs(ctx, body)).toBeNull();
    expect((ctx.client.resource.list as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('部分未登记 → 提醒只列缺席者', async () => {
    const body = 'A：\nhttps://github.com/a/b/pull/1\nB：\nhttps://github.com/a/b/pull/2';
    const ctx = makeCtx([{ url: 'https://github.com/a/b/pull/1' }]);
    const remind = await remindUnregisteredPrs(ctx, body);
    expect(remind).toContain('PR #2');
    expect(remind).not.toContain('PR #1');
  });
});
