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
      throw new Error('Invalid cron expression: unable to parse', { cause: error });
    }
  }
}
