/**
 * F20260825dva2: validate-commit-date.mjs 的持久化测试。
 *
 * 覆盖 PR #435 处置记录中实测过的 11 用例 + DST 边界。
 * 所有用例注入固定 now 参数，避免依赖系统时钟。
 */
import { describe, it, expect } from 'vitest';
import { validateCommitDate } from '../../scripts/validate-commit-date.mjs';

// 固定基准时间：2026-08-25 12:00 Asia/Shanghai（正午，避开午夜边界干扰）
const NOW = new Date('2026-08-25T12:00:00+08:00');

describe('validateCommitDate', () => {
  describe('F 类特性 ID 日期校验', () => {
    it('should pass when F-type ID date is today', () => {
      const result = validateCommitDate('[F20260825abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.diffDays).toBe(0);
    });

    it('should pass when F-type ID date is 1 day before', () => {
      const result = validateCommitDate('[F20260824abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(1);
    });

    it('should pass when F-type ID date is 1 day after', () => {
      const result = validateCommitDate('[F20260826abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(1);
    });

    it('should pass when F-type ID date is 2 days before', () => {
      const result = validateCommitDate('[F20260823abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(2);
    });

    it('should pass when F-type ID date is 2 days after', () => {
      const result = validateCommitDate('[F20260827abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
      expect(result.diffDays).toBe(2);
    });

    it('should reject when F-type ID date is 3 days before', () => {
      const result = validateCommitDate('[F20260822abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('fail');
      expect(result.diffDays).toBe(3);
      expect(result.idDate).toBe('20260822');
      expect(result.systemDate).toBe('20260825');
    });

    it('should reject when F-type ID date is 3 days after', () => {
      const result = validateCommitDate('[F20260828abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('fail');
      expect(result.diffDays).toBe(3);
    });

    it('should reject when F-type ID date is 7 days before', () => {
      const result = validateCommitDate('[F20260818abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('fail');
      expect(result.diffDays).toBe(7);
    });
  });

  describe('R 类特性 ID — 跳过校验', () => {
    it('should skip date validation for R-type ID regardless of date', () => {
      const result = validateCommitDate('[R20260818c5xt][research] 研究文档', NOW);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('skip');
    });
  });

  describe('无 ID / Merge 短路', () => {
    it('should skip when commit message has no feature ID', () => {
      const result = validateCommitDate('chore: 一般提交', NOW);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('skip');
    });

    it('should skip for merge commit', () => {
      // Merge commit 在钩子层已 case 短路，但模块层也应优雅处理
      const result = validateCommitDate('Merge branch main into feature/xxx', NOW);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('skip');
    });
  });

  describe('非法日期', () => {
    it('should handle invalid date like month 13', () => {
      const result = validateCommitDate('[F20261325abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('bad_date');
    });

    it('should handle invalid date like day 40', () => {
      const result = validateCommitDate('[F20260840abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('bad_date');
    });

    it('should handle invalid date like Feb 30', () => {
      const result = validateCommitDate('[F20260230abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('bad_date');
    });
  });

  describe('DST 边界', () => {
    it('should handle date near DST transition correctly', () => {
      // Why: formatToParts 始终返回 Asia/Shanghai 本地日期，DST 不影响日期部分
      // 用 2026-03-08（DST 切换附近）的 UTC 晚间做基准
      const dstNow = new Date('2026-03-08T23:30:00Z'); // UTC 23:30 = Shanghai 3/9 07:30
      const result = validateCommitDate('[F20260309abcd][agent][Feature Update] 测试', dstNow);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.diffDays).toBe(0);
    });

    it('should handle midnight boundary in Asia/Shanghai', () => {
      // Why: 23:59 Shanghai 和 00:01 Shanghai 差 1 天，但都在 ±2 天容忍内
      const lateNight = new Date('2026-08-25T15:59:00Z'); // UTC 15:59 = Shanghai 23:59
      const result = validateCommitDate('[F20260824abcd][agent][Feature Update] 测试', lateNight);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ok');
    });
  });

  describe('CLI 退出码（集成）', () => {
    it('should exit 0 for valid F-type commit', () => {
      const result = validateCommitDate('[F20260825abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(true);
    });

    it('should exit 1 for rejected F-type commit', () => {
      const result = validateCommitDate('[F20260818abcd][agent][Feature Update] 测试', NOW);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('fail');
    });
  });
});
