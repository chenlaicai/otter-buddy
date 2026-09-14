import type { CronParser } from '@usecases/scheduler/scheduler-service';
import { Cron } from 'croner';

/**
 * Cron 解析器实现
 * 使用 croner 库解析 cron 表达式并计算下次触发时间
 */
export class SimpleCronParser implements CronParser {
  getNextTime(cron: string, timezone: string, referenceTime?: Date): Date {
    try {
      const job = new Cron(cron, { timezone });
      // #640: 轮询模式下传入 referenceTime 计算从该时间点起的下次触发
      // croner nextRun(ref) 返回 ref 之后的第一次触发时间
      const next = referenceTime ? job.nextRun(referenceTime) : job.nextRun();
      if (!next) {
        throw new Error('No next run time found');
      }
      return next;
    } catch (error) {
      throw new Error('Invalid cron expression: unable to parse', { cause: error });
    }
  }

  /** #814：referenceTime 之前最近一次应触发时间（调度完整性对账）。
   *  croner previousRuns(1, ref) 返回 ref 之前最近一次匹配；无匹配返回 null。 */
  getPrevTime(cron: string, timezone: string, referenceTime?: Date): Date | null {
    try {
      const job = new Cron(cron, { timezone });
      const prevs = referenceTime ? job.previousRuns(1, referenceTime) : job.previousRuns(1);
      return prevs && prevs.length > 0 ? prevs[0]! : null;
    } catch (error) {
      throw new Error('Invalid cron expression: unable to parse', { cause: error });
    }
  }
}
