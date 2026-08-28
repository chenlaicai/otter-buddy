/**
 * F20260826mwrd C4：signal_events → MessageSignalDTO 映射单测。
 *
 * 覆盖：三态透传（pending/resolved/dismissed）、可空字段省略语义
 * （targetOtterId/resolution/resolvedBy 仅非空携带——DTO 瘦身）、halt 的 target 透传。
 */
import { describe, it, expect } from 'vitest';
import { toMessageSignalDTO } from '@interface-adapters/http/dto/message-dto';
import type { SignalEvent } from '@entities/signal/signal-event';

function makeEvent(overrides: Partial<SignalEvent> = {}): SignalEvent {
  return {
    id: 'sig-001',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    fromOtterId: 'otter-small-1',
    targetOtterId: null,
    type: 'objection',
    severity: 'medium',
    payload: '与 F20260826mwrd Part 2 的锚点校验规则冲突（docs/features/2026/08/26/F20260826mwrd.md:86）',
    status: 'pending',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: '2026-08-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('toMessageSignalDTO（C4 徽章数据源）', () => {
  it('pending objection：可空字段全部省略', () => {
    const dto = toMessageSignalDTO(makeEvent());
    expect(dto.type).toBe('objection');
    expect(dto.severity).toBe('medium');
    expect(dto.status).toBe('pending');
    expect(dto.payload).toContain('F20260826mwrd');
    expect(dto.fromOtterId).toBe('otter-small-1');
    expect(dto).not.toHaveProperty('targetOtterId');
    expect(dto).not.toHaveProperty('resolution');
    expect(dto).not.toHaveProperty('resolvedBy');
  });

  it('resolved：resolution + resolvedBy 透传（徽章显示裁决摘要）', () => {
    const dto = toMessageSignalDTO(makeEvent({
      status: 'resolved',
      resolution: '锚点核实成立，已改派',
      resolvedBy: 'otter-big',
      resolvedAt: '2026-08-27T10:05:00.000Z',
    }));
    expect(dto.status).toBe('resolved');
    expect(dto.resolution).toBe('锚点核实成立，已改派');
    expect(dto.resolvedBy).toBe('otter-big');
  });

  it('halt：targetOtterId 透传（「谁停了谁」一等查询维度）', () => {
    const dto = toMessageSignalDTO(makeEvent({
      type: 'halt',
      targetOtterId: 'otter-small-2',
      status: 'resolved',
      resolvedBy: 'system',
      resolution: 'halt 指令已在目标獭下一个工具调用边界注入',
    }));
    expect(dto.type).toBe('halt');
    expect(dto.targetOtterId).toBe('otter-small-2');
    expect(dto.resolvedBy).toBe('system');
  });

  it('dismissed：状态透传（灰徽章 + 理由）', () => {
    const dto = toMessageSignalDTO(makeEvent({
      status: 'dismissed',
      resolution: '锚点无法核实，可疑异议驳回',
      resolvedBy: 'otter-big',
    }));
    expect(dto.status).toBe('dismissed');
    expect(dto.resolution).toContain('驳回');
  });
});
