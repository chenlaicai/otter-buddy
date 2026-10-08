/**
 * F20261008mlp3 P3：matter_sweep 工具测试（未闭环扫描升格的执行载体）。
 *
 * 锁定项：
 * - 注册面：matterRepo 注入时注册，tool-factory 去重
 * - 执行面：返回停滞 matter 列表 + 候选漏登记 yield 列表
 * - 权限面：small 型白名单不含 matter_sweep（跨对话查询权与编排权对齐）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMatterRepository } from '@frameworks/db/matter/sqlite-matter-repository';
import { createMatterSweepTool } from '@interface-adapters/agent-runtime/tools/matter-tools';
import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';
import { getOtterToolNamesForType } from '@frameworks/agent/session-helpers';
import type { ToolContext } from '@usecases/ports/agent-tools';

const NOW = '2026-10-08T07:30:00Z';

function makeCtx(matterRepo?: SqliteMatterRepository): ToolContext {
  return {
    client: {} as never,
    otterId: 'otter-big-1',
    conversationId: 'conv-sweep',
    currentMessageId: 'msg-1',
    matterRepo,
  };
}

function seedMatter(
  repo: SqliteMatterRepository,
  overrides: Partial<{
    id: string;
    conversationId: string;
    title: string;
    state: string;
    updatedAt: string;
  }>,
): void {
  const db = (repo as unknown as { db: Database.Database }).db;
  db.prepare(`
    INSERT INTO matters (
      id, conversation_id, title, origin_message_id, owner_otter_id,
      level, state, waiting_on, waiting_for, payload, resolution, resolved_by,
      created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
  `).run(
    overrides.id ?? crypto.randomUUID(),
    overrides.conversationId ?? 'conv-1',
    overrides.title ?? '测试事项',
    overrides.state ?? 'OPEN',
    overrides.updatedAt ?? NOW,
    overrides.updatedAt ?? NOW,
  );
}

describe('matter_sweep 工具（F20261008mlp3 P3——未闭环扫描升格）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    db.prepare("INSERT INTO otters (id, name, type) VALUES ('otter-1', '大獭', 'big')").run();
    db.prepare("INSERT INTO conversations (id, title, status) VALUES ('conv-1', '测试对话', 'active')").run();
    repo = new SqliteMatterRepository(db);
  });

  it('注册面：matterRepo 注入时 tool-factory 注册 matter_sweep', () => {
    const tools = createTools(makeCtx(repo), undefined, undefined, undefined, undefined);
    const names = tools.map(t => t.name);
    expect(names).toContain('matter_sweep');
    // 去重：同一工具名不重复出现
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `重复注册: ${dupes.join(', ')}`).toEqual([]);
  });

  it('注册面：matterRepo 缺省时 matter_sweep 不注册', () => {
    const tools = createTools(makeCtx(), undefined, undefined, undefined, undefined);
    expect(tools.map(t => t.name)).not.toContain('matter_sweep');
  });

  it('权限面：small 型白名单不含 matter_sweep（跨对话查询权与编排权对齐）', () => {
    const tools = createTools(makeCtx(repo), undefined, undefined, undefined, undefined);
    const allNames = tools.map(t => t.name);
    const smallNames = getOtterToolNamesForType('small', allNames, undefined, undefined);
    expect(smallNames).not.toContain('matter_sweep');
    const bigNames = getOtterToolNamesForType('big', allNames, undefined, undefined);
    expect(bigNames).toContain('matter_sweep');
  });

  it('执行面：返回停滞 matter 列表（含短锚+等待时长）——OPEN 全捞（积压），WAITING_PARTNER 24h 阈', async () => {
    const twoDaysAgo = new Date(Date.parse(NOW) - 2 * 24 * 3_600_000).toISOString();
    seedMatter(repo, { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: '停滞事项 A', state: 'OPEN', updatedAt: twoDaysAgo });
    seedMatter(repo, { id: 'bbbbbbbb-0000-0000-0000-000000000002', title: '新事项 B', state: 'OPEN', updatedAt: NOW });
    seedMatter(repo, { id: 'cccccccc-0000-0000-0000-000000000003', title: '积压事项 C', state: 'WAITING_PARTNER', updatedAt: twoDaysAgo });
    const tool = createMatterSweepTool(makeCtx(repo), repo);
    const res = await tool.execute('call-1', { now: NOW });
    expect(res.isError).toBeFalsy();
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    // OPEN 全捞（2 件）+ WAITING_PARTNER 积压（1 件）= 3 件
    expect(text).toContain('停滞 matter（3 件）');
    expect(text).toContain('M-aaaaaaaa');
    expect(text).toContain('停滞事项 A');
    expect(text).toContain('48h 未动');
    expect(text).toContain('M-bbbbbbbb');
    expect(text).toContain('新事项 B');
    expect(text).toContain('0h 未动');
    expect(text).toContain('M-cccccccc');
    expect(text).toContain('积压事项 C');
  });

  it('执行面：返回候选漏登记 yield 列表（近 7 天）', async () => {
    const twoDaysAgo = new Date(Date.parse(NOW) - 2 * 24 * 3_600_000).toISOString();
    db.prepare(`
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, status, source, metadata, sender_name,
        context_tokens, context_tokens_max, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'e-sweep-1', 'conv-1', 1, 'yield', 'otter', 'otter-1', '呈拍板：方案', null, '["user"]',
      'completed', null, null, '大獭', null, null, twoDaysAgo, null,
    );
    const tool = createMatterSweepTool(makeCtx(repo), repo);
    const res = await tool.execute('call-2', { now: NOW });
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('候选漏登记 yield（1 条');
    expect(text).toContain('yield:e-sweep-');
    expect(text).toContain('呈拍板');
  });

  it('执行面：空结果返回「无」提示', async () => {
    const tool = createMatterSweepTool(makeCtx(repo), repo);
    const res = await tool.execute('call-3', { now: NOW });
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('停滞 matter：无');
    expect(text).toContain('候选漏登记 yield：无');
  });

  it('参数校验：now 非法时间戳报错', async () => {
    const tool = createMatterSweepTool(makeCtx(repo), repo);
    const res = await tool.execute('call-4', { now: 'not-a-date' });
    expect(res.isError).toBeTruthy();
  });
});
