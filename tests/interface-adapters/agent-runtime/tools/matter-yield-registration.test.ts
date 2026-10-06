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
      // 简报内容单源（§1）：payload 存 reason 全文
      payload: JSON.stringify({ brief: '方案 A 还是 B，请拍板' }),
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

describe('transition_matter 代执行（§3.5 通道 A 工具面——S1 修复锁定）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
  });

  async function seedWaitingPartner(): Promise<string> {
    const id = crypto.randomUUID();
    await repo.create({
      id,
      conversationId: 'conv-1',
      title: '拍板事项',
      originMessageId: null,
      ownerOtterId: 'otter-owner',
      level: 'L2',
      state: 'WAITING_PARTNER',
      waitingOn: 'partner',
      waitingFor: '选 A/B',
      payload: null,
      resolution: null,
      resolvedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
    });
    return id;
  }

  it('无代执行声明：獭以自己身份执行 partner 专属迁移被拒（S1 断路修复前行为）', async () => {
    const id = await seedWaitingPartner();
    const ctx = makeCtx(repo).ctx;
    const tool = createTools(ctx).find(t => t.name === 'transition_matter')!;
    const result = await tool.execute('c1', {
      matter_id: id, to: 'DONE_PENDING_CONFIRM', resolution: '批准',
    });
    expect(result.content[0].text).toContain('非法迁移触发者');
  });

  it('on_behalf_of=partner：代执行声明放行 partner 专属迁移 + resolution 留痕', async () => {
    const id = await seedWaitingPartner();
    const ctx = makeCtx(repo).ctx;
    const tool = createTools(ctx).find(t => t.name === 'transition_matter')!;
    const result = await tool.execute('c1', {
      matter_id: id, to: 'DONE_PENDING_CONFIRM',
      resolution: '代搭档执行：批准按方案A', on_behalf_of: 'partner',
    });
    expect(result.content[0].text).toContain('→ DONE_PENDING_CONFIRM');
    const after = await repo.findById(id);
    expect(after!.resolution).toBe('代搭档执行：批准按方案A');
  });

  it('代执行 partner 专属迁移缺 resolution：参数校验拒绝（留痕强制）', async () => {
    const id = await seedWaitingPartner();
    const ctx = makeCtx(repo).ctx;
    const tool = createTools(ctx).find(t => t.name === 'transition_matter')!;
    const result = await tool.execute('c1', {
      matter_id: id, to: 'DONE_PENDING_CONFIRM', on_behalf_of: 'partner',
    });
    expect(result.content[0].text).toContain('必须填 resolution');
  });

  it('payload 参数可写入（§1 简报内容单源——R5 修复锁定）', async () => {
    const id = await seedWaitingPartner();
    const ctx = makeCtx(repo).ctx;
    const tool = createTools(ctx).find(t => t.name === 'transition_matter')!;
    await tool.execute('c1', {
      matter_id: id, to: 'WAITING_OTTER',
      waiting_on: 'otter:x', waiting_for: '续办',
      payload: '{"brief":"三层简报 JSON"}',
      resolution: '打回再改', on_behalf_of: 'partner',
    });
    const after = await repo.findById(id);
    expect(after!.payload).toBe('{"brief":"三层简报 JSON"}');
  });
});
