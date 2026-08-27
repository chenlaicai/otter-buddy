/**
 * Healing 高危路由单测（F20260826mwrd C3，母方案 Part 4）。
 *
 * 三层覆盖：
 * 1. registry 纯逻辑：enqueue/takeAll/上限/滞留语义
 * 2. interceptHealingReport 集成：high 事件登记 + 台账照落 + low 不登记
 * 3. renderHealingAlerts：提醒文本形态与截断
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { healingAlertRegistry, renderHealingAlerts } from '@usecases/healing/healing-alert-registry';
import { interceptHealingReport } from '@interface-adapters/agent-runtime/tools/healing-tools';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';

function makeCtx(): ToolContext {
  return {
    otterId: 'otter-small-1',
    conversationId: 'conv-1',
    currentMessageId: 'msg-1',
  } as unknown as ToolContext;
}

function makeRepo(): { repo: HealingEventRepository; creates: Array<{ severity: string }> } {
  const creates: Array<{ severity: string }> = [];
  const repo = {
    create: vi.fn(async (e: { severity: string }) => { creates.push(e); }),
    findAll: vi.fn(async () => []),
    findOpen: vi.fn(async () => []),
  } as unknown as HealingEventRepository;
  return { repo, creates };
}

describe('healingAlertRegistry 纯逻辑', () => {
  beforeEach(() => healingAlertRegistry.resetForTest());

  it('enqueue 后 takeAll 取走全部且清空（送达即删）', () => {
    healingAlertRegistry.enqueue('conv-1', { eventId: 'e1', conversationId: 'conv-1', otterId: 'o1', errorType: '工具故障', description: 'd1', createdAt: 't1' });
    healingAlertRegistry.enqueue('conv-1', { eventId: 'e2', conversationId: 'conv-1', otterId: 'o1', errorType: '格式异常', description: 'd2', createdAt: 't2' });
    const got = healingAlertRegistry.takeAll('conv-1');
    expect(got).toHaveLength(2);
    expect(healingAlertRegistry.takeAll('conv-1')).toHaveLength(0);
  });

  it('不同对话队列互不干扰', () => {
    healingAlertRegistry.enqueue('conv-1', { eventId: 'e1', conversationId: 'conv-1', otterId: 'o1', errorType: 't', description: 'd', createdAt: 't' });
    healingAlertRegistry.enqueue('conv-2', { eventId: 'e2', conversationId: 'conv-2', otterId: 'o2', errorType: 't', description: 'd', createdAt: 't' });
    expect(healingAlertRegistry.takeAll('conv-1')).toHaveLength(1);
    expect(healingAlertRegistry.takeAll('conv-2')).toHaveLength(1);
  });

  it('大獭不在场（无人取）：队列滞留，下一轮补提醒', () => {
    healingAlertRegistry.enqueue('conv-1', { eventId: 'e1', conversationId: 'conv-1', otterId: 'o1', errorType: 't', description: 'd', createdAt: 't' });
    // 没人 takeAll——滞留
    expect(healingAlertRegistry.peek('conv-1')).toHaveLength(1);
    // 下一轮大獭 invoke 取走
    expect(healingAlertRegistry.takeAll('conv-1')).toHaveLength(1);
  });

  it('单对话积压上限 20：超限丢弃最旧（台账仍有全量）', () => {
    for (let i = 0; i < 25; i++) {
      healingAlertRegistry.enqueue('conv-1', { eventId: `e${i}`, conversationId: 'conv-1', otterId: 'o1', errorType: 't', description: `d${i}`, createdAt: 't' });
    }
    const got = healingAlertRegistry.takeAll('conv-1');
    expect(got).toHaveLength(20);
    expect(got[0].eventId).toBe('e5'); // 最旧的 e0-e4 被丢弃
    expect(got[19].eventId).toBe('e24');
  });
});

describe('interceptHealingReport C3 高危路由', () => {
  beforeEach(() => healingAlertRegistry.resetForTest());

  it('severity:high 事件：登记提醒 + 台账照落 + body 剥离不变', () => {
    const { repo, creates } = makeRepo();
    const body = '工作完成\n<healing>[issues]\n- type: tool_failure\n  severity: high\n  description: 某工具连续失败\n  suggestion: 修复\n[/issues]</healing>';
    const clean = interceptHealingReport(body, makeCtx(), repo);
    expect(healingAlertRegistry.peek('conv-1')).toHaveLength(1);
    const alert = healingAlertRegistry.peek('conv-1')[0];
    expect(alert.errorType).toBe('tool_failure');
    expect(alert.conversationId).toBe('conv-1');
    expect(alert.otterId).toBe('otter-small-1');
    expect(creates).toHaveLength(1);
    expect(creates[0].severity).toBe('high');
    expect(clean).not.toContain('<healing>');
  });

  it('severity:low 事件：台账落但登记不路由（高危路由只针对 high）', () => {
    const { repo, creates } = makeRepo();
    const body = '<healing>[issues]\n- type: format_violation\n  severity: low\n  description: d\n[/issues]</healing>';
    interceptHealingReport(body, makeCtx(), repo);
    expect(healingAlertRegistry.peek('conv-1')).toHaveLength(0);
    expect(creates).toHaveLength(1);
  });

  it('多条 high 同消息：逐条登记', () => {
    const { repo } = makeRepo();
    const body = '<healing>[issues]\n- type: tool_failure\n  severity: high\n  description: a\n  suggestion: s\n- type: missing_context\n  severity: high\n  description: b\n[/issues]</healing>';
    interceptHealingReport(body, makeCtx(), repo);
    expect(healingAlertRegistry.peek('conv-1')).toHaveLength(2);
  });
});

describe('renderHealingAlerts', () => {
  it('渲染含处置引导与台账查询指引', () => {
    const text = renderHealingAlerts([
      { eventId: 'e1', conversationId: 'conv-1', otterId: 'otter-small-1', errorType: 'tool_failure', description: 'bash 连续失败', createdAt: '2026-08-27T10:00:00Z' },
    ]);
    expect(text).toContain('高危 healing 事件提醒');
    expect(text).toContain('tool_failure');
    expect(text).toContain('bash 连续失败');
    expect(text).toContain('manage_healing_events');
    expect(text).toContain('1 条');
  });

  it('description 超 120 字符截断', () => {
    const long = 'x'.repeat(200);
    const text = renderHealingAlerts([
      { eventId: 'e1', conversationId: 'c', otterId: 'o', errorType: 't', description: long, createdAt: 't' },
    ]);
    expect(text).not.toContain('x'.repeat(121));
    expect(text).toContain('…');
  });
});
