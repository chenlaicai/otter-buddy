import type { Context } from 'hono';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { SchedulerService } from '@usecases/scheduler/scheduler-service';
import type { CronParser } from '@usecases/scheduler/scheduler-service';
import { handleError, param } from '../http-error';
import {
  toScheduledTaskDTO,
  toExecutionDTO,
  type CreateScheduledTaskRequestDTO,
  type UpdateScheduledTaskRequestDTO,
} from '../dto/scheduled-task-dto';

export class ScheduledTaskController {
  constructor(
    private readonly manageScheduledTask: ManageScheduledTask,
    private readonly schedulerService: SchedulerService,
    private readonly cronParser: CronParser,
  ) {}

  /** 创建定时任务 */
  async create(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, 'id');
      const body = await c.req.json<CreateScheduledTaskRequestDTO>();

      const task = await this.manageScheduledTask.create({
        conversationId,
        name: body.name,
        cron: body.cron,
        timezone: body.timezone,
        body: body.body,
        talkingStonePassedTo: body.talkingStonePassedTo,
        senderId: body.senderId,
      });

      // 计算下次触发时间
      const nextTrigger = this.cronParser.getNextTime(task.cron, task.timezone);

      return c.json(toScheduledTaskDTO(task, nextTrigger.toISOString()), 201);
    } catch (err) {
      return handleError(c, err);
    }
  }

  /** 列出对话的定时任务 */
  async listByConversation(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, 'id');
      const tasks = await this.manageScheduledTask.getByConversationId(conversationId);

      const dtos = tasks.map(task => {
        const nextTrigger = this.cronParser.getNextTime(task.cron, task.timezone);
        return toScheduledTaskDTO(task, nextTrigger.toISOString());
      });

      return c.json(dtos);
    } catch (err) {
      return handleError(c, err);
    }
  }

  /** 获取单个任务详情 */
  async getById(c: Context): Promise<Response> {
    try {
      const taskId = param(c, 'taskId');
      const task = await this.manageScheduledTask.getById(taskId);
      if (!task) {
        return c.json({ error: 'ScheduledTask not found' }, 404);
      }

      const nextTrigger = this.cronParser.getNextTime(task.cron, task.timezone);
      return c.json(toScheduledTaskDTO(task, nextTrigger.toISOString()));
    } catch (err) {
      return handleError(c, err);
    }
  }

  /** 更新任务 */
  async update(c: Context): Promise<Response> {
    try {
      const taskId = param(c, 'taskId');
      const body = await c.req.json<UpdateScheduledTaskRequestDTO>();

      const task = await this.manageScheduledTask.update(taskId, {
        name: body.name,
        cron: body.cron,
        timezone: body.timezone,
        body: body.body,
        talkingStonePassedTo: body.talkingStonePassedTo,
        status: body.status,
      });

      const nextTrigger = this.cronParser.getNextTime(task.cron, task.timezone);
      return c.json(toScheduledTaskDTO(task, nextTrigger.toISOString()));
    } catch (err) {
      return handleError(c, err);
    }
  }

  /** 删除任务 */
  async delete(c: Context): Promise<Response> {
    try {
      const taskId = param(c, 'taskId');
      await this.manageScheduledTask.delete(taskId);
      return c.json({ status: 'deleted' });
    } catch (err) {
      return handleError(c, err);
    }
  }

  /** 手动触发 */
  async trigger(c: Context): Promise<Response> {
    try {
      const taskId = param(c, 'taskId');
      const result = await this.schedulerService.trigger(taskId);
      return c.json({ executionId: result.executionId });
    } catch (err) {
      return handleError(c, err);
    }
  }

  /** 查询执行历史 */
  async listExecutions(c: Context): Promise<Response> {
    try {
      const taskId = param(c, 'taskId');
      const limitStr = c.req.query('limit') ?? '20';
      const offsetStr = c.req.query('offset') ?? '0';
      const limit = parseInt(limitStr, 10);
      const offset = parseInt(offsetStr, 10);

      if (isNaN(limit) || isNaN(offset) || limit < 0 || offset < 0) {
        return c.json({ error: 'Invalid pagination parameters' }, 400);
      }

      const result = await this.manageScheduledTask.getExecutions(taskId, { limit, offset });

      return c.json({
        executions: result.executions.map(toExecutionDTO),
        total: result.total,
        limit,
        offset,
      });
    } catch (err) {
      return handleError(c, err);
    }
  }
}
