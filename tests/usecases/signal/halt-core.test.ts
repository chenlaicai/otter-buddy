/**
 * F20260826mwrd C1：halt 核心机制单测。
 *
 * 覆盖：haltRegistry 状态机（mark → takeForBlock → 持续 block → endInvoke）、
 * haltToolCallGuard（ALS fail-open + block 语义）、buildHaltBlockReason（LLM 注入文本）。
 * 集成链路（SDK tool_call 事件 → block → isError tool result）由 capability 测试验收
 * （tests/capability/magic-words-signal.capability.test.ts 剧本 A）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { haltRegistry, type HaltDirective } from '@usecases/signal/halt-registry';
import { haltToolCallGuard } from '@frameworks/agent/model-runtime-registry';
import { otterInvokeStorage } from '@frameworks/agent/model-runtime-registry';
import { buildHaltBlockReason } from '@usecases/signal/halt-block-reason';

function makeDirective(overrides: Partial<HaltDirective> = {}): HaltDirective {
  return {
    id: 'sig-001',
    targetOtterId: 'otter-small-1',
    fromOtterId: 'otter-big',
    fromOtterName: '大獭',
    conversationId: 'conv-1',
    reason: '方向理解反了，停手等我改派',
    issuedAt: '2026-08-26T10:00:00.000Z',
    ...overrides,
  };
}

describe('haltRegistry 状态机', () => {
  beforeEach(() => haltRegistry.resetForTest());

  it('mark 后 takeForBlock 返回指令并触发首次回调', () => {
    const seen: string[] = [];
    haltRegistry.onFirstBlock(d => seen.push(d.id));
    haltRegistry.mark(makeDirective());

    const directives = haltRegistry.takeForBlock('otter-small-1');
    expect(directives).toHaveLength(1);
    expect(directives[0].reason).toContain('方向理解反了');
    expect(seen).toEqual(['sig-001']);
  });

  it('同一 invoke 内后续 takeForBlock 持续返回（防 LLM 无视指令继续调工具）', () => {
    haltRegistry.mark(makeDirective());
    const first = haltRegistry.takeForBlock('otter-small-1');
    expect(first).toHaveLength(1);

    // LLM 尝试下一个工具调用——仍然 block（指令在 active）
    const second = haltRegistry.takeForBlock('otter-small-1');
    expect(second).toHaveLength(1);
    expect(haltRegistry.isHalted('otter-small-1')).toBe(true);
  });

  it('endInvoke 后新 invoke 不再受旧 halt 影响（改派续干语义）', () => {
    haltRegistry.mark(makeDirective());
    haltRegistry.takeForBlock('otter-small-1');
    haltRegistry.endInvoke('otter-small-1');

    expect(haltRegistry.takeForBlock('otter-small-1')).toHaveLength(0);
    expect(haltRegistry.isHalted('otter-small-1')).toBe(false);
  });

  it('未打标的目标不受影响（无 halt 放行）', () => {
    haltRegistry.mark(makeDirective({ targetOtterId: 'otter-other' }));
    expect(haltRegistry.takeForBlock('otter-small-1')).toHaveLength(0);
  });

  it('多条指令累积：一次 block 注入全部', () => {
    haltRegistry.mark(makeDirective({ id: 'sig-1' }));
    haltRegistry.mark(makeDirective({ id: 'sig-2', reason: '需求变更' }));
    const directives = haltRegistry.takeForBlock('otter-small-1');
    expect(directives.map(d => d.id)).toEqual(['sig-1', 'sig-2']);
  });

  it('首次回调抛错不影响 block 本身', () => {
    haltRegistry.onFirstBlock(() => { throw new Error('callback boom'); });
    haltRegistry.mark(makeDirective());
    const directives = haltRegistry.takeForBlock('otter-small-1');
    expect(directives).toHaveLength(1);
  });
});

describe('haltToolCallGuard（ALS 集成）', () => {
  beforeEach(() => haltRegistry.resetForTest());

  it('ALS scope 内：halt 打标时返回 block + reason', async () => {
    haltRegistry.mark(makeDirective());
    const result = await otterInvokeStorage.run({ otterPromptConfig: undefined, identityPrefix: '', otterId: 'otter-small-1' }, async () => {
      return haltToolCallGuard(otterInvokeStorage.getStore(), haltRegistry);
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('halt 指令');
    expect(result?.reason).toContain('方向理解反了');
    expect(result?.reason).toContain('大獭');
  });

  it('ALS store 读不到时 fail-open（放行，不误伤）', () => {
    haltRegistry.mark(makeDirective());
    const result = haltToolCallGuard(undefined, haltRegistry);
    expect(result).toBeUndefined();
  });

  it('无 halt 打标时放行', async () => {
    const result = await otterInvokeStorage.run({ otterPromptConfig: undefined, identityPrefix: '', otterId: 'otter-clean' }, async () => {
      return haltToolCallGuard(otterInvokeStorage.getStore(), haltRegistry);
    });
    expect(result).toBeUndefined();
  });

  it('并发 invoke 互不串扰：A 打标不影响 B', async () => {
    haltRegistry.mark(makeDirective({ targetOtterId: 'otter-A' }));
    const resultB = await otterInvokeStorage.run({ otterPromptConfig: undefined, identityPrefix: '', otterId: 'otter-B' }, async () => {
      return haltToolCallGuard(otterInvokeStorage.getStore(), haltRegistry);
    });
    expect(resultB).toBeUndefined();
  });
});

describe('buildHaltBlockReason（注入文本）', () => {
  it('包含行为义务三要素：不重试/报告进度/yield', () => {
    const reason = buildHaltBlockReason([makeDirective()])!;
    expect(reason).toContain('不重试');
    expect(reason).toContain('进度快照');
    expect(reason).toContain('yield');
    expect(reason).toContain('上下文完整保留');
  });

  it('空指令返回 undefined（调用方据此放行）', () => {
    expect(buildHaltBlockReason([])).toBeUndefined();
  });

  it('超长多指令截断到上限内', () => {
    const many = Array.from({ length: 20 }, (_, i) => makeDirective({ id: `sig-${i}`, reason: 'x'.repeat(300) }));
    const reason = buildHaltBlockReason(many)!;
    expect(reason.length).toBeLessThanOrEqual(2100);
    expect(reason).toContain('多指令已截断');
  });
});
