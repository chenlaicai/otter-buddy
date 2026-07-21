import type { CronParser } from '@usecases/scheduler/scheduler-service';
import { Cron } from 'croner';

/**
 * Cron 解析器实现
 * 使用 croner 库解析 cron 表达式并计算下次触发时间
 */
export class SimpleCronParser implements CronParser {
  getNextTime(cron: string, timezone: string): Date {
    try {
      const job = new Cron(cron, { timezone });
      const next = job.nextRun();
      if (!next) {
        throw new Error('No next run time found');
      }
      return next;
    } catch (error) {
      // 如果 croner 解析失败，使用简单的回退逻辑
      console.warn('Cron parsing failed, using fallback:', error);
      return this.fallbackGetNextTime();
    }
  }

  /**
   * 简单的回退实现：假设每分钟触发一次
   * 仅用于 cron 解析失败时
   */
  private fallbackGetNextTime(): Date {
    const now = new Date();
    now.setSeconds(0);
    now.setMilliseconds(0);
    now.setMinutes(now.getMinutes() + 1);
    return now;
  }
}
