/**
 * ModelPool 单元测试
 */
import { describe, it, expect } from 'vitest';
import { buildModelPool } from '@frameworks/llm/model-pool';
import type { ModelConfig } from '@frameworks/config';

function makeConfig(alias: string, overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    alias,
    provider: 'openai',
    model: 'gpt-4o',
    ...overrides,
  };
}

function makeModel(alias: string) {
  return { id: `model-${alias}`, provider: alias };
}

describe('ModelPool', () => {
  describe('getModel', () => {
    it('returns model by alias', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default'), model: makeModel('default') },
        { config: makeConfig('fast'), model: makeModel('fast') },
      ]);

      expect(pool.getModel('fast')).toEqual(makeModel('fast'));
    });

    it('returns default model when alias not found', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default'), model: makeModel('default') },
      ]);

      expect(pool.getModel('nonexistent')).toEqual(makeModel('default'));
    });

    it('returns default model when alias is null/undefined', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default'), model: makeModel('default') },
      ]);

      expect(pool.getModel(null)).toEqual(makeModel('default'));
      expect(pool.getModel(undefined)).toEqual(makeModel('default'));
    });
  });

  describe('getDefaultModel', () => {
    it('returns the default model', () => {
      const pool = buildModelPool('fast', [
        { config: makeConfig('default'), model: makeModel('default') },
        { config: makeConfig('fast'), model: makeModel('fast') },
      ]);

      expect(pool.getDefaultModel()).toEqual(makeModel('fast'));
    });
  });

  describe('getDefaultAlias', () => {
    it('returns the default alias', () => {
      const pool = buildModelPool('fast', [
        { config: makeConfig('default'), model: makeModel('default') },
        { config: makeConfig('fast'), model: makeModel('fast') },
      ]);

      expect(pool.getDefaultAlias()).toBe('fast');
    });
  });

  describe('hasModel', () => {
    it('returns true for existing alias', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default'), model: makeModel('default') },
        { config: makeConfig('fast'), model: makeModel('fast') },
      ]);

      expect(pool.hasModel('fast')).toBe(true);
    });

    it('returns false for non-existing alias', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default'), model: makeModel('default') },
      ]);

      expect(pool.hasModel('nonexistent')).toBe(false);
    });
  });

  describe('getContextWindow', () => {
    it('returns contextWindow for existing alias', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default', { contextWindow: 128000 }), model: makeModel('default') },
        { config: makeConfig('fast', { contextWindow: 64000 }), model: makeModel('fast') },
      ]);

      expect(pool.getContextWindow('fast')).toBe(64000);
    });

    it('returns undefined when alias not found', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default', { contextWindow: 128000 }), model: makeModel('default') },
      ]);

      expect(pool.getContextWindow('nonexistent')).toBeUndefined();
    });

    it('returns undefined when no contextWindow configured', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default'), model: makeModel('default') },
      ]);

      expect(pool.getContextWindow('default')).toBeUndefined();
    });
  });

  describe('describeModels', () => {
    it('returns all model descriptors', () => {
      const pool = buildModelPool('default', [
        { config: makeConfig('default', { description: 'Default model', strengths: ['fast'] }), model: makeModel('default') },
        { config: makeConfig('powerful', { description: 'Powerful model', weaknesses: ['expensive'] }), model: makeModel('powerful') },
      ]);

      const descriptors = pool.describeModels();
      expect(descriptors).toHaveLength(2);
      expect(descriptors[0]).toEqual({
        alias: 'default',
        description: 'Default model',
        strengths: ['fast'],
        weaknesses: undefined,
        contextWindow: undefined,
      });
      expect(descriptors[1]).toEqual({
        alias: 'powerful',
        description: 'Powerful model',
        strengths: undefined,
        weaknesses: ['expensive'],
        contextWindow: undefined,
      });
    });
  });

  describe('getAllEntries', () => {
    it('returns all entries with alias and config', () => {
      const config1 = makeConfig('default');
      const config2 = makeConfig('fast');
      const pool = buildModelPool('default', [
        { config: config1, model: makeModel('default') },
        { config: config2, model: makeModel('fast') },
      ]);

      const entries = pool.getAllEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ alias: 'default', config: config1 });
      expect(entries[1]).toEqual({ alias: 'fast', config: config2 });
    });
  });

  describe('buildModelPool', () => {
    it('throws when default alias not in entries', () => {
      expect(() => {
        buildModelPool('nonexistent', [
          { config: makeConfig('default'), model: makeModel('default') },
        ]);
      }).toThrow('default alias "nonexistent" not found');
    });
  });
});
