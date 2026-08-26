import { describe, it, expect } from 'vitest';
import { resolveDisplayName } from './display-name';

describe('resolveDisplayName（F20260826fuid: user 快照名优先）', () => {
  it('user 消息带快照名时返回快照名', () => {
    expect(resolveDisplayName({ sn: '张三', si: 'ou_zhangsan', st: 'user' }, [])).toBe('张三');
  });

  it('user 消息无快照名时返回空串（调用方 fallback 全局名）', () => {
    expect(resolveDisplayName({ si: 'ou_x', st: 'user' }, [])).toBe('');
    expect(resolveDisplayName({ sn: '  ', si: 'ou_x', st: 'user' }, [])).toBe('');
  });

  it('system 消息带快照名时返回快照名', () => {
    expect(resolveDisplayName({ sn: '系统', si: 'system', st: 'system' }, [])).toBe('系统');
  });

  it('otter 消息行为不变：快照名优先，无则查缓存，终点 senderId', () => {
    expect(resolveDisplayName({ sn: '大獭', si: 'o1', st: 'otter' }, [])).toBe('大獭');
    expect(resolveDisplayName({ si: 'o1', st: 'otter' }, [{ id: 'o1', name: '缓存獭' }])).toBe('缓存獭');
    expect(resolveDisplayName({ si: 'o1', st: 'otter' }, [])).toBe('o1');
  });
});
