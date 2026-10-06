import type { Context } from 'hono';
import type { MatterRepository } from '@usecases/matter/matter-repository';
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from '../http-error';
import { toMatterDTO } from '../dto/matter-dto';

/**
 * Matter 控制器（F20261005mtlp P1）——只读。
 * P1 范围：右侧栏「待办」tab 列出 open 事项（标题/状态徽章/等待时长/owner），不可操作。
 * 写路径（裁决/闭环/打回）在 P2 板上按钮 + 獭侧 transition_matter 工具，不经 HTTP。
 */
export class MatterController {
  constructor(
    private readonly matterRepo: MatterRepository,
    private readonly logger: Logger,
  ) {}

  /** 列出对话的未闭环 matters（open 清单——P1 只读板数据源） */
  async listOpenByConversation(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, 'id');
      const matters = await this.matterRepo.findByConversation(conversationId, { openOnly: true }, 100);
      return c.json(matters.map(toMatterDTO));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
