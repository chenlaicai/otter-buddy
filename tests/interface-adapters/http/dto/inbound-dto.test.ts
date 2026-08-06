import { describe, it, expect } from 'vitest';
import { parseInboundRequest } from '@interface-adapters/http/dto/inbound-dto';

describe('parseInboundRequest', () => {
  describe('source 校验', () => {
    it('source 缺失 → ok=false', () => {
      const r = parseInboundRequest({ kind: 'recruit' });
      expect(r.ok).toBe(false);
    });

    it('unknown source → ok=false', () => {
      const r = parseInboundRequest({ source: 'github', kind: 'recruit' });
      expect(r.ok).toBe(false);
    });
  });

  describe('kind 校验', () => {
    it('kind 非法 → ok=false', () => {
      const r = parseInboundRequest({ source: 'boss-zhipin-bridge', kind: 'unknown' });
      expect(r.ok).toBe(false);
    });
  });

  describe('recruit payload', () => {
    it('完整合法', () => {
      const r = parseInboundRequest({
        source: 'boss-zhipin-bridge',
        kind: 'recruit',
        payload: {
          messages: [{
            externalId: 'boss:b1:m1', bossId: 'b1',
            hrName: '王', company: '字节', position: '前端',
            content: '你好', time: 1700000000000,
          }],
        },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.payload.kind).toBe('recruit');
        if (r.payload.kind === 'recruit') {
          expect(r.payload.messages[0].hrName).toBe('王');
          expect(r.payload.messages[0].hrTitle).toBeUndefined();
        }
      }
    });

    it('messages 非数组', () => {
      const r = parseInboundRequest({
        source: 'boss-zhipin-bridge', kind: 'recruit',
        payload: { messages: 'not-array' },
      });
      expect(r.ok).toBe(false);
    });

    it('消息缺必填字段 → 错误信息含索引', () => {
      const r = parseInboundRequest({
        source: 'boss-zhipin-bridge', kind: 'recruit',
        payload: { messages: [{ bossId: 'b1', hrName: 'x' }] },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('messages[0]');
        expect(r.error).toContain('externalId');
      }
    });

    it('time 非 number', () => {
      const r = parseInboundRequest({
        source: 'boss-zhipin-bridge', kind: 'recruit',
        payload: { messages: [{
          externalId: 'x', bossId: 'b', hrName: 'h', company: 'c',
          position: 'p', content: 'x', time: '2026-01-01',
        }] },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('time');
    });
  });

  describe('status payload', () => {
    it('severity 合法', () => {
      const r = parseInboundRequest({
        source: 'boss-zhipin-bridge', kind: 'status',
        payload: { events: [{ type: 'anti-bot', severity: 'critical', at: '2026-01-01T00:00:00Z' }] },
      });
      expect(r.ok).toBe(true);
    });

    it('severity=info 被拒（info 不应推到 otter）', () => {
      const r = parseInboundRequest({
        source: 'boss-zhipin-bridge', kind: 'status',
        payload: { events: [{ type: 'scan-ok', severity: 'info', at: '2026-01-01T00:00:00Z' }] },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('severity');
    });

    it('events 非数组', () => {
      const r = parseInboundRequest({
        source: 'boss-zhipin-bridge', kind: 'status',
        payload: {},
      });
      expect(r.ok).toBe(false);
    });
  });
});
