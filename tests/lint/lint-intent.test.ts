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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// F20260917sdpl：golden_replay 执行核对读 process.cwd() 下的相对路径（data/metrics/）。
// 测试用临时目录切 cwd，避免读到仓库真实记录干扰断言，测完恢复。
function withTempCwd<T>(fn: () => T): T {
  const orig = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intent-'));
  process.chdir(tmp);
  try { return fn(); } finally { process.chdir(orig); fs.rmSync(tmp, { recursive: true, force: true }); }
}
function writeGoldenResults(records: unknown[]) {
  const dir = path.join(process.cwd(), 'data', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'golden-results.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
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

describe('lint:intent', () => {
  it('should reject frontmatter top-level verify_by (schema unified to intent-nested, #1158)', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: '软代码行为改动',
        expected_effect: '行为可判定',
        verify_by: { type: 'human_judge' },
      }),
      verify_by: { type: 'human_judge' },
      modules: ['prompts/identity/SMALL_OTTER.md'],
      created_at: '2026-09-24',
    };
    const result = validateIntent(fm);
    expect(result.errors.some((e: string) => e.includes('frontmatter 顶层 verify_by 是非法位置'))).toBe(true);
  });

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

// F20260917sdpl 改动 1：软代码 verify_by 声明时间界收口
describe('lint:intent soft-code verify_by enforcement (F20260917sdpl)', () => {
  it('should error on new soft-code doc (created_at ≥ 2026-09-17) missing verify_by', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: 'prompt 改动无评估机制',
        expected_effect: 'R4 场景 search_memory 出现率 ≥ 2/3',
      }),
      modules: ['.pi/skills/otter-summon/SKILL.md'],
      created_at: '2026-09-17',
    };
    const result = validateIntent(fm);
    expect(result.errors.some((e: string) => e.startsWith('Missing intent.verify_by for soft-code change'))).toBe(true);
  });

  it('should keep warning for legacy soft-code doc (created_at < 2026-09-17) missing verify_by', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: 'prompt 改动无评估机制',
        expected_effect: 'R4 场景 search_memory 出现率 ≥ 2/3',
      }),
      modules: ['.pi/skills/otter-summon/SKILL.md'],
      created_at: '2026-09-16',
    };
    const result = validateIntent(fm);
    expect(result.errors.some((e: string) => e.startsWith('Missing intent.verify_by for soft-code change'))).toBe(false);
    expect(result.warnings.some((w: string) => w.startsWith('Recommended intent.verify_by field for soft-code change'))).toBe(true);
  });

  it('should pass when new soft-code doc declares verify_by', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: 'prompt 改动无评估机制',
        expected_effect: 'R4 场景 search_memory 出现率 ≥ 2/3',
        verify_by: { type: 'behavior_check' },
      }),
      modules: ['.pi/skills/otter-summon/SKILL.md'],
      created_at: '2026-09-17',
    };
    const result = validateIntent(fm);
    expect(result.errors).toHaveLength(0);
  });

  it('should treat missing created_at as legacy (warning, not error)', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: 'prompt 改动无评估机制',
        expected_effect: 'R4 场景 search_memory 出现率 ≥ 2/3',
      }),
      modules: ['prompts/identity/BIG_OTTER.md'],
      // created_at 缺失 → 存量宽容（lint 不追诉，完整性由 lint-docs 兜底）
    };
    const result = validateIntent(fm);
    expect(result.errors.some((e: string) => e.startsWith('Missing intent.verify_by for soft-code change'))).toBe(false);
    expect(result.warnings.some((w: string) => w.startsWith('Recommended intent.verify_by field for soft-code change'))).toBe(true);
  });

  // 边界防御（检视建议 1）：created_at 含 ISO 时间后缀时的字符串比较行为锁定。
  // '2026-09-17T…' >= '2026-09-17' 为 true（同日前缀 + 更长字符串）——按界日判定，符合「同日新建一律要求声明」语义。
  it('should treat created_at with time suffix as on/boundary date (error)', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: 'prompt 改动无评估机制',
        expected_effect: 'R4 场景 search_memory 出现率 ≥ 2/3',
      }),
      modules: ['.pi/skills/otter-summon/SKILL.md'],
      created_at: '2026-09-17T08:00:00Z',
    };
    const result = validateIntent(fm);
    expect(result.errors.some((e: string) => e.startsWith('Missing intent.verify_by for soft-code change'))).toBe(true);
  });

  it('should treat future created_at as new (error)', () => {
    const fm = {
      ...createBaseFm('feature', {
        problem: 'prompt 改动无评估机制',
        expected_effect: 'R4 场景 search_memory 出现率 ≥ 2/3',
      }),
      modules: ['.pi/skills/otter-summon/SKILL.md'],
      created_at: '2027-01-01',
    };
    const result = validateIntent(fm);
    expect(result.errors.some((e: string) => e.startsWith('Missing intent.verify_by for soft-code change'))).toBe(true);
  });
});

// F20260917sdpl 改动 2：golden_replay 声明的执行记录核对（分环境）
describe('lint:intent golden_replay record check (F20260917sdpl)', () => {
  const baseGoldenFm = () => ({
    ...createBaseFm('feature', {
      problem: 'skill 行为回归需验证',
      expected_effect: '对应场景采样通过率 ≥ 8/10',
      verify_by: { type: 'golden_replay' },
    }),
    modules: ['.pi/skills/code-implementation/SKILL.md'],
    created_at: '2026-09-17',
  });

  it('should error when golden_replay declared but no record after created_at (file exists)', () => {
    withTempCwd(() => {
      writeGoldenResults([
        { ts: '2026-09-01T00:00:00Z', golden_id: 'r4-summon-search-first', passed: true },
      ]);
      const result = validateIntent(baseGoldenFm());
      expect(result.errors.some((e: string) => e.startsWith('intent.verify_by.type=golden_replay 但'))).toBe(true);
    });
  });

  it('should pass when record exists after created_at', () => {
    withTempCwd(() => {
      writeGoldenResults([
        { ts: '2026-09-01T00:00:00Z', golden_id: 'old-run', passed: true },
        { ts: '2026-09-18T10:00:00Z', golden_id: 'r4-summon-search-first', passed: true },
      ]);
      const result = validateIntent(baseGoldenFm());
      expect(result.errors).toHaveLength(0);
    });
  });

  it('should warn (not error) when results file missing (CI clean env)', () => {
    withTempCwd(() => {
      const result = validateIntent(baseGoldenFm());
      expect(result.errors.some((e: string) => e.startsWith('intent.verify_by.type=golden_replay 但'))).toBe(false);
      expect(result.warnings.some((w: string) => w.includes('golden-results.jsonl 不存在'))).toBe(true);
    });
  });

  it('should skip record check for non-golden_replay types', () => {
    withTempCwd(() => {
      const fm = {
        ...createBaseFm('feature', {
          problem: '纯文字纪律改动',
          expected_effect: 'skill 文本包含固化失败条款',
          verify_by: { type: 'static_only' },
        }),
        modules: ['.pi/skills/troubleshooting/SKILL.md'],
        created_at: '2026-09-17',
      };
      const result = validateIntent(fm);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((w: string) => w.includes('golden-results.jsonl 不存在'))).toBe(false);
    });
  });

  it('should skip record check for non-soft-code golden_replay declaration', () => {
    withTempCwd(() => {
      const fm = {
        ...createBaseFm('feature', {
          problem: '硬代码能力验证',
          expected_effect: 'runner 记录字段含 ts ≥ 8/10',
          verify_by: { type: 'golden_replay' },
        }),
        modules: ['src/frameworks/'],
        created_at: '2026-09-17',
      };
      const result = validateIntent(fm);
      expect(result.errors).toHaveLength(0);
    });
  });
});
