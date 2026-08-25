/**
 * F20260824ax376: PR 评估体系 - intent 字段校验测试
 * F20260825evgl: 扩展软代码域三值（capability_test/golden_replay/static_only）+ 联动可判定检查
 */
import { describe, it, expect } from 'vitest';

// Intent 字段校验规则
const INTENT_REQUIRED_CHANGE_TYPES = new Set(['feature']);
const INTENT_RECOMMENDED_CHANGE_TYPES = new Set(['bugfix', 'refactor']);
const VALID_VERIFY_BY_TYPES = new Set([
  'metric_probe',
  'behavior_check',
  'human_judge',
  'capability_test',
  'golden_replay',
  'static_only',
]);

// 软代码域 verify_by：capability_test/golden_replay 要求 expected_effect 可判定
const SOFT_CODE_SAMPLE_TYPES = new Set(['capability_test', 'golden_replay']);

function isSoftCodeChange(fm: Record<string, unknown>): boolean {
  const modules = fm.modules;
  if (!Array.isArray(modules)) return false;
  return modules.some(
    (m) => typeof m === 'string' && (m.startsWith('prompts/') || m.startsWith('.pi/')),
  );
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
  fm: Record<string, unknown>,
  intent: Record<string, unknown>,
  changeType: string,
  errors: string[],
  warnings: string[]
) {
  if (!intent.verify_by) {
    if (isSoftCodeChange(fm)) {
      warnings.push('Recommended intent.verify_by field for soft-code change');
    } else if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
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
    return;
  }

  // 联动规则：capability_test/golden_replay 要求 expected_effect 可判定
  if (SOFT_CODE_SAMPLE_TYPES.has(verifyBy.type as string)) {
    const fuzzyWords = ['提升', '优化', '改善', '更好', '更优', '增强'];
    const effect = typeof intent.expected_effect === 'string' ? intent.expected_effect : '';
    if (fuzzyWords.some((w) => effect.includes(w))) {
      errors.push(`intent.expected_effect must be measurable when verify_by.type=${verifyBy.type}`);
    }
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

function validateIntent(fm: Record<string, unknown>) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const changeType = fm.change_type as string;

  if (!fm.intent || typeof fm.intent !== 'object') {
    if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
      errors.push(`Missing intent field for ${changeType}`);
    } else if (INTENT_RECOMMENDED_CHANGE_TYPES.has(changeType)) {
      warnings.push(`Recommended intent field for ${changeType}`);
    }
    return { errors, warnings };
  }

  const intent = fm.intent as Record<string, unknown>;

  validateProblemField(intent, changeType, errors, warnings);
  validateExpectedEffectField(intent, changeType, errors, warnings);
  validateVerifyByField(fm, intent, changeType, errors, warnings);
  validateEffectWindowField(intent, errors);

  return { errors, warnings };
}

describe('lint:intent', () => {
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
    expect(result.errors).toContain('Invalid intent.verify_by.type: invalid_type. Must be one of: metric_probe, behavior_check, human_judge, capability_test, golden_replay, static_only');
  });

  it('should accept new soft-code verify_by types', () => {
    for (const type of ['capability_test', 'golden_replay', 'static_only']) {
      const fm = createBaseFm('feature', {
        problem: 'prompt 改动无评估机制',
        expected_effect: 'R4 场景 search_memory 出现率 ≥ 2/3',
        verify_by: { type },
      });
      const result = validateIntent(fm);
      expect(result.errors, `type=${type} should be accepted`).toHaveLength(0);
    }
  });

  it('should warn verify_by for soft-code change (modules 含 prompts/)', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: 'prompt 改动无评估机制',
        expected_effect: 'R4 场景 search_memory 出现率 ≥ 2/3',
      }),
      modules: ['prompts/identity/BIG_OTTER.md'],
    };
    const result = validateIntent(fm);
    expect(result.warnings).toContain('Recommended intent.verify_by field for soft-code change');
  });

  it('should warn verify_by for soft-code change (modules 含 .pi/)', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: 'skill 改动无评估机制',
        expected_effect: '召唤前 search_memory 出现率 ≥ 2/3',
      }),
      modules: ['.pi/skills/otter-summon/SKILL.md'],
    };
    const result = validateIntent(fm);
    expect(result.warnings).toContain('Recommended intent.verify_by field for soft-code change');
  });

  it('should reject fuzzy expected_effect when verify_by.type=capability_test', () => {
    const fm = createBaseFm('feature', {
      problem: 'prompt 改动无评估机制',
      expected_effect: '提升召唤前的检索效果',
      verify_by: { type: 'capability_test' },
    });
    const result = validateIntent(fm);
    expect(result.errors).toContain('intent.expected_effect must be measurable when verify_by.type=capability_test');
  });

  it('should reject fuzzy expected_effect when verify_by.type=golden_replay', () => {
    const fm = createBaseFm('feature', {
      problem: 'prompt 改动无评估机制',
      expected_effect: '优化路由行为',
      verify_by: { type: 'golden_replay' },
    });
    const result = validateIntent(fm);
    expect(result.errors).toContain('intent.expected_effect must be measurable when verify_by.type=golden_replay');
  });

  it('should allow fuzzy expected_effect when verify_by.type=human_judge (warning only)', () => {
    const fm = createBaseFm('feature', {
      problem: '回答太冗长',
      expected_effect: '提升回答简洁度',
      verify_by: { type: 'human_judge' },
    });
    const result = validateIntent(fm);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toContain('intent.expected_effect contains fuzzy words (提升/优化/改善等)');
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
