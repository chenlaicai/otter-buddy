/**
 * F20260824ax376: PR 评估体系 - intent 字段校验测试
 * F20260825evgl: 扩展软代码域三值 + 联动可判定检查
 *
 * 检视发现 1 修复：测试 import lint-intent.mjs 的真实现（validateIntent），不再重写副本——
 * 之前测试验证的是自己的副本逻辑（且 warning 字符串与实现分叉），实现裸奔。
 * 真实现是 .mjs 脚本，经 isMain 守卫后 import 时只取纯函数、不触发 dist 依赖与文件遍历。
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error 真实现是 .mjs 脚本（无类型声明），运行时 import 纯函数
import { validateIntent } from '../../scripts/lint-intent.mjs';

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

describe('lint:intent', () => {
  it('should require intent for feature', () => {
    const fm = createBaseFm('feature');
    const result = validateIntent(fm);
    // 真实现：缺 intent 的 feature 给 warning 不阻断（存量宽容策略，脚本注释「存量文档只产生警告」）
    expect(result.warnings).toContain('Missing intent field for feature');
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
    expect(result.errors[0]).toMatch(/^Invalid intent\.verify_by\.type: invalid_type\. Must be one of: /);
    expect(result.errors[0]).toContain('capability_test');
    expect(result.errors[0]).toContain('golden_replay');
    expect(result.errors[0]).toContain('static_only');
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
    expect(result.warnings.some((w: string) => w.startsWith('Recommended intent.verify_by field for soft-code change'))).toBe(true);
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
    expect(result.warnings.some((w: string) => w.startsWith('Recommended intent.verify_by field for soft-code change'))).toBe(true);
  });

  it('should reject fuzzy expected_effect when verify_by.type=capability_test', () => {
    const fm = createBaseFm('feature', {
      problem: 'prompt 改动无评估机制',
      expected_effect: '提升召唤前的检索效果',
      verify_by: { type: 'capability_test' },
    });
    const result = validateIntent(fm);
    expect(result.errors[0]).toMatch(/^intent\.expected_effect must be measurable when verify_by\.type=capability_test/);
  });

  it('should reject fuzzy expected_effect when verify_by.type=golden_replay', () => {
    const fm = createBaseFm('feature', {
      problem: 'prompt 改动无评估机制',
      expected_effect: '优化路由行为',
      verify_by: { type: 'golden_replay' },
    });
    const result = validateIntent(fm);
    expect(result.errors[0]).toMatch(/^intent\.expected_effect must be measurable when verify_by\.type=golden_replay/);
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
