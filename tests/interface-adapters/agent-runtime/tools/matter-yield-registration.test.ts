/**
 * F20261005mtlp P1：yield 打标自动登记 matter 集成测试（准入路径 1）。
 *
 * 验证节锁定项「准入白名单（不打标不登记）」：
 * - expects_partner_decision=true + to=['user'] → matters 表自动登记（WAITING_PARTNER/L2/owner=调用獭）
 * - 不打标（缺省 false）→ 不登记（防泛滥=机械）
 * - 打标但 to 不含 'user'（传给其他獭）→ 不登记（L2 拍板项定义 = yield to user）
 * - matterRepo 未注入（旧装配）→ 静默跳过，交棒不受影响
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMatterRepository } from '@frameworks/db/matter/sqlite-matter-repository';
import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { OtterToolClient } from '@usecases/ports/otter-tool-client';
import type { MatterRepository } from '@usecases/matter/matter-repository';

function makeCtx(matterRepo?: MatterRepository): { ctx: ToolContext; yieldEntryId: string } {
  const yieldEntryId = crypto.randomUUID();
  const client = {
    conversation: {
      participant: {
        getActive: async () => [
          { otterId: 'otter-big', otterName: '大獭', status: 'active' },
          { otterId: 'user', otterName: 'user', status: 'active' },
        ],
      },
      entry: {
        createYieldEntry: async () => ({
          yieldEntry: { id: yieldEntryId },
          invokeEndEntry: { id: crypto.randomUUID() },
        }),
      },
    },
    otter: { getById: async () => ({ id: 'otter-big', name: '大獭', type: 'big', color: null }) },
    dispatch: { markDispatched: async () => {} },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = {
    client,
    otterId: 'otter-big',
    conversationId: 'conv-1',
    currentMessageId: 'msg-1',
    currentInvokeId: 'invoke-1',
    lastSpeakMessageId: 'speak-entry-1',
    matterRepo,
  };
  return { ctx, yieldEntryId };
}

async function runYield(ctx: ToolContext, params: Record<string, unknown>) {
  const tools = createTools(ctx);
  const yieldTool = tools.find(t => t.name === 'yield')!;
  return yieldTool.execute('call-1', params);
}

describe('yield expects_partner_decision 自动登记 matter（准入路径 1）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
  });

  it('打标 + to=[user] → 登记 matter（WAITING_PARTNER / L2 / owner=调用獭 / origin=yield entry）', async () => {
    const { ctx, yieldEntryId } = makeCtx(repo);
    const result = await runYield(ctx, {
      to: ['user'], reason: '方案 A 还是 B，请拍板', expects_partner_decision: true,
    });

    expect(result.terminate).toBe(true);
    expect(result.content[0].text).toContain('已登记 M-');

    const matters = await repo.findByConversation('conv-1', { openOnly: true });
    expect(matters).toHaveLength(1);
    expect(matters[0]).toMatchObject({
      conversationId: 'conv-1',
      title: '方案 A 还是 B，请拍板',
      state: 'WAITING_PARTNER',
      level: 'L2',
      ownerOtterId: 'otter-big',
      waitingOn: 'partner',
      waitingFor: '方案 A 还是 B，请拍板',
      originMessageId: yieldEntryId,
    });
  });

  it('不打标（缺省）→ 不登记（防泛滥=机械）', async () => {
    const { ctx } = makeCtx(repo);
    const result = await runYield(ctx, { to: ['user'], reason: '常规汇报' });

    expect(result.terminate).toBe(true);
    expect(result.content[0].text).not.toContain('已登记 M-');
    expect(await repo.findByConversation('conv-1')).toHaveLength(0);
  });

  it('打标但 to 不含 user（传给小獭）→ 不登记（L2 拍板项定义 = yield to user）', async () => {
    const { ctx } = makeCtx(repo);
    const result = await runYield(ctx, {
      to: ['大獭'], expects_partner_decision: true, reason: '派工',
    });

    expect(result.terminate).toBe(true);
    expect(await repo.findByConversation('conv-1')).toHaveLength(0);
  });

  it('matterRepo 未注入（旧装配）→ 交棒不受影响，静默跳过', async () => {
    const { ctx } = makeCtx(undefined);
    const result = await runYield(ctx, {
      to: ['user'], reason: '拍板项', expects_partner_decision: true,
    });

    expect(result.terminate).toBe(true);
    // 不抛错、无登记注记（静默跳过）
    expect(result.content[0].text).not.toContain('已登记 M-');
  });
});

describe('matter 工具注册条件', () => {
  it('matterRepo 注入时 list_matters / transition_matter 注册；缺省不注册', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const repo = new SqliteMatterRepository(db);

    const withMatter = createTools(makeCtx(repo).ctx).map(t => t.name);
    expect(withMatter).toContain('list_matters');
    expect(withMatter).toContain('transition_matter');

    const withoutMatter = createTools(makeCtx(undefined).ctx).map(t => t.name);
    expect(withoutMatter).not.toContain('list_matters');
    expect(withoutMatter).not.toContain('transition_matter');
  });
});
