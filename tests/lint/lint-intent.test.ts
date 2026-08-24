/**
 * F20260824ax376: PR 评估体系 - intent 字段校验测试
 */
import { describe, it, expect } from 'vitest';

describe('lint:intent', () => {
  // Intent 字段校验规则
  const INTENT_REQUIRED_CHANGE_TYPES = new Set(['feature']);
  const INTENT_RECOMMENDED_CHANGE_TYPES = new Set(['bugfix', 'refactor']);
  const VALID_VERIFY_BY_TYPES = new Set(['metric_probe', 'behavior_check', 'human_judge']);

  function validateIntent(fm: Record<string, unknown>) {
    const errors: string[] = [];
    const warnings: string[] = [];

    const changeType = fm.change_type as string;

    // 检查 intent 字段是否存在
    if (!fm.intent || typeof fm.intent !== 'object') {
      if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
        errors.push(`Missing intent field for ${changeType}`);
      } else if (INTENT_RECOMMENDED_CHANGE_TYPES.has(changeType)) {
        warnings.push(`Recommended intent field for ${changeType}`);
      }
      return { errors, warnings };
    }

    const intent = fm.intent as Record<string, unknown>;

    // 检查 problem 字段
    validateProblemField(intent, changeType, errors, warnings);

    // 检查 expected_effect 字段
    validateExpectedEffectField(intent, changeType, errors, warnings);

    // 检查 verify_by 字段
    validateVerifyByField(intent, changeType, errors, warnings);

    // 检查 effect_window 字段
    validateEffectWindowField(intent, errors);

    return { errors, warnings };
  }

  function validateProblemField(
    intent: Record<string, unknown>,
    changeType: string,
    errors: string[],
    warnings: string[]
  ) {
    if (!intent.problem || typeof intent.problem !== 'string') {
      if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
        errors.push('Missing intent.problem field');
      } else if (INTENT_RECOMMENDED_CHANGE_TYPES.has(changeType)) {
        warnings.push('Recommended intent.problem field');
      }
    } else if (intent.problem.trim().length === 0) {
      errors.push('intent.problem field is empty');
    }
  }

  function validateExpectedEffectField(
    intent: Record<string, unknown>,
    changeType: string,
    errors: string[],
    warnings: string[]
  ) {
    if (!intent.expected_effect || typeof intent.expected_effect !== 'string') {
      if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
        errors.push('Missing intent.expected_effect field');
      }
      return;
    }

    const fuzzyWords = ['提升', '优化', '改善', '更好', '更优', '增强'];
    const hasFuzzyWord = fuzzyWords.some(word => (intent.expected_effect as string).includes(word));
    if (hasFuzzyWord) {
      warnings.push('intent.expected_effect contains fuzzy words (提升/优化/改善等)');
    }
  }

  function validateVerifyByField(
    intent: Record<string, unknown>,
    changeType: string,
    errors: string[],
    warnings: string[]
  ) {
    if (!intent.verify_by) {
      if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
        warnings.push('Recommended intent.verify_by field for feature');
      }
      return;
    }

    if (typeof intent.verify_by !== 'object') {
      errors.push('intent.verify_by must be an object');
      return;
    }

    const verifyBy = intent.verify_by as Record<string, unknown>;
    if (!verifyBy.type || !VALID_VERIFY_BY_TYPES.has(verifyBy.type as string)) {
      errors.push(`Invalid intent.verify_by.type: ${verifyBy.type}. Must be one of: ${Array.from(VALID_VERIFY_BY_TYPES).join(', ')}`);
    }
  }

  function validateEffectWindowField(
    intent: Record<string, unknown>,
    errors: string[]
  ) {
    if (!intent.effect_window) {
      return;
    }

    if (typeof intent.effect_window !== 'string') {
      errors.push('intent.effect_window must be a string (e.g., "72h", "1w")');
      return;
    }

    if (!/^\d+[hdw]$/.test(intent.effect_window)) {
      errors.push(`Invalid intent.effect_window format: ${intent.effect_window}. Must be like '72h', '1d', '1w'`);
    }
  }

  // Helper function to create a base feature frontmatter
  function createBaseFm(changeType: string, intent?: Record<string, unknown>) {
    return {
      id: 'F20260824test',
      title: 'Test',
      summary: 'Test summary',
      change_type: changeType,
      ...(intent ? { intent } : {}),
    };
  }

  it('should require intent for feature', () => {
    const fm = createBaseFm('feature');
    const result = validateIntent(fm);
    expect(result.errors).toContain('Missing intent field for feature');
  });

  it('should recommend intent for bugfix', () => {
    const fm = createBaseFm('bugfix');
    const result = validateIntent(fm);
    expect(result.warnings).toContain('Recommended intent field for bugfix');
  });

  it('should require problem for feature', () => {
    const fm = createBaseFm('feature', {
      expected_effect: 'Something works',
      verify_by: { type: 'behavior_check' },
    });
    const result = validateIntent(fm);
    expect(result.errors).toContain('Missing intent.problem field');
  });

  it('should require expected_effect for feature', () => {
    const fm = createBaseFm('feature', {
      problem: 'Something is broken',
      verify_by: { type: 'behavior_check' },
    });
    const result = validateIntent(fm);
    expect(result.errors).toContain('Missing intent.expected_effect field');
  });

  it('should accept valid intent for feature', () => {
    const fm = createBaseFm('feature', {
      problem: 'Something is broken',
      expected_effect: 'Something returns 400',
      verify_by: { type: 'behavior_check' },
      effect_window: '72h',
    });
    const result = validateIntent(fm);
    expect(result.errors).toHaveLength(0);
  });

  it('should warn about fuzzy words in expected_effect', () => {
    const fm = createBaseFm('feature', {
      problem: 'Something is broken',
      expected_effect: '提升用户体验',
      verify_by: { type: 'human_judge' },
    });
    const result = validateIntent(fm);
    expect(result.warnings).toContain('intent.expected_effect contains fuzzy words (提升/优化/改善等)');
  });

  it('should reject invalid verify_by.type', () => {
    const fm = createBaseFm('feature', {
      problem: 'Something is broken',
      expected_effect: 'Something returns 400',
      verify_by: { type: 'invalid_type' },
    });
    const result = validateIntent(fm);
    expect(result.errors).toContain('Invalid intent.verify_by.type: invalid_type. Must be one of: metric_probe, behavior_check, human_judge');
  });

  it('should reject invalid effect_window format', () => {
    const fm = createBaseFm('feature', {
      problem: 'Something is broken',
      expected_effect: 'Something returns 400',
      verify_by: { type: 'behavior_check' },
      effect_window: 'invalid',
    });
    const result = validateIntent(fm);
    expect(result.errors).toContain('Invalid intent.effect_window format: invalid. Must be like \'72h\', \'1d\', \'1w\'');
  });

  it('should accept valid effect_window formats', () => {
    const validFormats = ['24h', '72h', '1d', '1w'];
    for (const format of validFormats) {
      const fm = createBaseFm('feature', {
        problem: 'Something is broken',
        expected_effect: 'Something returns 400',
        verify_by: { type: 'behavior_check' },
        effect_window: format,
      });
      const result = validateIntent(fm);
      expect(result.errors).toHaveLength(0);
    }
  });
});
