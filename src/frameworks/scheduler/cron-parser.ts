import type { CronParser } from '@usecases/scheduler/scheduler-service';

/**
 * 简单的 Cron 解析器实现
 * 使用 croner 库解析 cron 表达式并计算下次触发时间
 *
 * 注意：需要安装 croner 依赖
 * npm install croner
 */
export class SimpleCronParser implements CronParser {
  getNextTime(cron: string, timezone: string): Date {
    try {
      // 动态导入 croner（如果可用）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const croner = require('croner');
      const job = croner(cron, { timezone });
      const next = job.nextRun();
      if (!next) {
        throw new Error('No next run time found');
      }
      return next;
    } catch (error) {
      // 如果 croner 不可用，使用简单的回退逻辑
      console.warn('Croner not available, using fallback cron parser:', error);
      return this.fallbackGetNextTime(cron, timezone);
    }
  }

  /**
   * 简单的回退实现：假设每分钟触发一次
   * 仅用于开发/测试环境
   */
  private fallbackGetNextTime(_cron: string, _timezone: string): Date {
    const now = new Date();
    // 设置为下一分钟的 0 秒
    now.setSeconds(0);
    now.setMilliseconds(0);
    now.setMinutes(now.getMinutes() + 1);
    return now;
  }
}
