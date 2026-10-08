/**
 * F20261006mlp2 P2 严重1：register_matter 工具单测（「+」登记入口的执行载体）。
 *
 * 死链背景：P1 只把 RegisterMatter 接在 yield 打标路径（准入路径 1），工具面没注册
 * 登记工具——板上「+」合成登记回执让獭去登记，獭无工具可达 = 登记必丢。本文件锁
 * register_matter 工具的登记语义：title 必填、登记即 OPEN、owner 缺省=登记獭自己。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMatterRepository } from '@frameworks/db/matter/sqlite-matter-repository';
import { createRegisterMatterTool } from '@interface-adapters/agent-runtime/tools/matter-tools';
import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { MatterRepository } from '@usecases/matter/matter-repository';

const OTTER = 'otter-register-1';

function makeCtx(matterRepo?: MatterRepository): ToolContext {
  return {
    client: {} as never,
    otterId: OTTER,
    conversationId: 'conv-reg',
    currentMessageId: 'msg-1',
    currentInvokeId: 'invoke-1',
    lastSpeakMessageId: undefined,
    matterRepo,
  };
}

describe('register_matter 工具（F20261006mlp2 严重1——「+」登记入口）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
  });

  it('登记成功：title → matters 表新增 OPEN 行，owner 缺省=登记獭（认领）', async () => {
    const tool = createRegisterMatterTool(makeCtx(repo), repo);
    const res = await tool.execute('call-1', { title: '回头再看的重构项' });
    expect(res.isError).toBeFalsy();

    const rows = await repo.findByConversation('conv-reg', undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('回头再看的重构项');
    expect(rows[0].state).toBe('OPEN'); // 准入路径 2：搭档手动登记 initialState=OPEN
    expect(rows[0].ownerOtterId).toBe(OTTER); // 登记獭认领
    expect(rows[0].waitingOn).toBeNull(); // OPEN 不挂等待方
  });

  it('title 必填：空/缺省报错（validation 守卫）', async () => {
    const tool = createRegisterMatterTool(makeCtx(repo), repo);
    const empty = await tool.execute('call-2', { title: '   ' });
    expect(empty.isError).toBeTruthy();
    const missing = await tool.execute('call-3', {});
    expect(missing.isError).toBeTruthy();
    expect(await repo.findByConversation('conv-reg', undefined, 10)).toHaveLength(0);
  });

  it('owner_otter_id 显式指定时覆盖缺省认领', async () => {
    const tool = createRegisterMatterTool(makeCtx(repo), repo);
    await tool.execute('call-4', { title: '指定 owner 事项', owner_otter_id: 'otter-other-9' });
    const rows = await repo.findByConversation('conv-reg', undefined, 10);
    expect(rows[0].ownerOtterId).toBe('otter-other-9');
  });

  it('tool-factory 装配：matterRepo 注入时 register_matter 进工具面（严重1 死链的正面锁）', () => {
    const tools = createTools(makeCtx(repo));
    const names = tools.map(t => t.name);
    expect(names).toContain('register_matter');
    expect(names).toContain('list_matters');
    expect(names).toContain('transition_matter');
  });
});
