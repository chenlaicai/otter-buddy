import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { bootCapabilityApp, type CapabilityContext } from './helpers/boot';
import { RecordingGateway, speakScript, yieldScript } from './helpers/model-visible';
import {
  createConversation, sendUserMessage, waitForOtterMessage, waitForInvokeSettled,
  listMessages, latestUserSeq, toolCallNamesForExchange, expectSampledBehavior,
} from './helpers/assert-behavior';

function seedPending(ctx: CapabilityContext, conversationId: string, role: string, suffix: string): void {
  const now = new Date().toISOString();
  const taskId = `cap-pending-task-${suffix}`;
  ctx.built.db.prepare(`INSERT INTO scheduled_tasks (
    id, conversation_id, name, schedule_type, cron, timezone, body, description,
    executor_role, talking_stone_passed_to, sender_id, status, consecutive_failures,
    restart_before_invoke, executor_type, created_at, updated_at
  ) VALUES (?, ?, ?, 'cron', '0 9 * * *', 'Asia/Shanghai', '补执行正文', '能力验收任务',
    ?, '[]', 'system', 'active', 0, 0, 'agent', ?, ?)`)
    .run(taskId, conversationId, `待执行-${role}`, role, now, now);
  ctx.built.db.prepare(`INSERT INTO scheduled_task_pending_items (
    id, task_id, conversation_id, role, triggered_at, status
  ) VALUES (?, ?, ?, ?, ?, 'pending')`)
    .run(`cap-pending-${suffix}`, taskId, conversationId, role, now);
}

/** B 类：提醒文案是否真驱动工具行为；A 类仓储/角色过滤断言不能替代此验收。 */
describe('定时任务 pending 提醒驱动 list（真系统 + 真 LLM）', () => {
  let ctx: CapabilityContext;
  beforeAll(async () => { ctx = await bootCapabilityApp(); });
  afterAll(() => ctx?.cleanup());

  it('看到本角色 pending 后实际调用 manage_scheduled_task_pending(list)，3 次 ≥2', async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);
    await expectSampledBehavior('scheduled-task-pending-list', 3, 2, async (index) => {
      const convId = await createConversation(ctx, `pending 提醒 ${index + 1}`);
      const big = ctx.built.db.prepare(`
        SELECT o.id, o.name FROM conversation_participants p JOIN otters o ON o.id = p.otter_id
        WHERE p.conversation_id = ? AND p.status = 'active' AND o.type = 'big' LIMIT 1
      `).get(convId) as { id: string; name: string };
      seedPending(ctx, convId, big.name, `${index}-big`);
      seedPending(ctx, convId, '其他角色', `${index}-other`);
      await sendUserMessage(ctx, convId,
        '请检查是否有需要你查看的定时任务待办；如有就做最小必要的只读查看，不要执行也不要 ack，然后回复已查看。');

      const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 180_000 });
      await waitForInvokeSettled(ctx, convId, big.id, { timeoutMs: 180_000 });
      const messages = await listMessages(ctx, convId);
      const names = toolCallNamesForExchange(messages, latestUserSeq(messages.filter(m => m.st === 'user')));
      const rows = ctx.built.db.prepare(`
        SELECT e.payload FROM invoke_events e JOIN invokes i ON i.id = e.invoke_id
        WHERE i.conversation_id = ? AND e.event_type = 'assistant_toolcall'
      `).all(convId) as Array<{ payload: string }>;
      const calledList = rows.some(row => {
        const payload = JSON.parse(row.payload) as { name?: string; arguments?: { action?: string } };
        return payload.name === 'manage_scheduled_task_pending' && payload.arguments?.action === 'list';
      });
      const pendingLeft = ctx.built.db.prepare(
        `SELECT COUNT(*) AS n FROM scheduled_task_pending_items WHERE conversation_id = ? AND status = 'pending'`,
      ).get(convId) as { n: number };
      return {
        ok: names.includes('manage_scheduled_task_pending') && calledList && pendingLeft.n === 2,
        detail: `answer=${answer.content.slice(0, 60)} tools=${JSON.stringify(names)} calledList=${calledList} pendingLeft=${pendingLeft.n}`,
      };
    }, { budgetMs: 600_000, sampleWorstMs: 200_000 });
  }, 660_000);
});

describe('定时任务 pending 模型可见输入与 tool 装配（录音网关确定性回放）', () => {
  let ctx: CapabilityContext;
  let gateway: RecordingGateway;
  beforeAll(async () => {
    gateway = await RecordingGateway.start();
    gateway.queue([
      { toolCalls: [{ name: 'manage_scheduled_task_pending', input: { action: 'list' } }] },
      speakScript('已查看待执行列表。'),
      yieldScript(),
    ]);
    ctx = await bootCapabilityApp({ recordingGatewayUrl: gateway.url });
  });
  afterAll(async () => {
    ctx?.cleanup();
    await gateway?.stop();
  });

  it('提醒按角色进入 user message，正文不进上下文，pending tool 真实可调用', async () => {
    const convId = await createConversation(ctx, 'pending wire 回放');
    const big = ctx.built.db.prepare(`
      SELECT o.id, o.name FROM conversation_participants p JOIN otters o ON o.id = p.otter_id
      WHERE p.conversation_id = ? AND p.status = 'active' AND o.type = 'big' LIMIT 1
    `).get(convId) as { id: string; name: string };
    seedPending(ctx, convId, big.name, 'wire-big');
    seedPending(ctx, convId, '其他角色', 'wire-other');
    await sendUserMessage(ctx, convId, '检查定时任务待办并只读查看。');
    const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });
    await waitForInvokeSettled(ctx, convId, big.id, { timeoutMs: 120_000 });
    expect(answer.status).toBe('completed');
    expect(gateway.requests.length).toBe(3);
    const first = gateway.requests[0] as { messages?: unknown[]; tools?: Array<{ name: string }> };
    const messageText = JSON.stringify(first.messages);
    expect(messageText).toContain('定时任务待执行列表');
    expect(messageText).toContain('待执行-大獭');
    expect(messageText).not.toContain('待执行-其他角色');
    expect(messageText).not.toContain('补执行正文');
    expect(first.tools?.map(tool => tool.name)).toContain('manage_scheduled_task_pending');
    const remaining = ctx.built.db.prepare(
      `SELECT COUNT(*) AS n FROM scheduled_task_pending_items WHERE conversation_id = ? AND status = 'pending'`,
    ).get(convId) as { n: number };
    expect(remaining.n).toBe(2); // list 不消费，ack 才是唯一状态翻转点
  }, 240_000);
});
