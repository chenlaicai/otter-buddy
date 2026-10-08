import type { Context } from 'hono';
import type { MatterRepository } from '@usecases/matter/matter-repository';
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from '../http-error';
import { toMatterDTO } from '../dto/matter-dto';

/**
 * Matter 控制器（F20261006mtlp P1 只读 + F20261006mlp2 P2 近期闭环区）。
 * P2 范围：右侧栏「待办」tab 交互层的只读数据源——open 清单 + 折叠「近期闭环」区
 * （closed 清单，翻案入口）。写路径（裁决/闭环/打回/登记）在 P2 仍不经 HTTP：
 * 板上按钮合成回执路由 owner 獭代执行（特性文档「按钮挂点架构定案」）。
 */
export class MatterController {
  constructor(
    private readonly matterRepo: MatterRepository,
    private readonly logger: Logger,
  ) {}

  /** 列出对话 matters——默认 open 清单（P1 只读板数据源）；?includeClosed=1 含终态（P2 近期闭环区） */
  async listOpenByConversation(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, 'id');
      const includeClosed = c.req.query('includeClosed') === '1';
      const matters = includeClosed
        ? await this.matterRepo.findByConversation(conversationId, undefined, 100)
        : await this.matterRepo.findByConversation(conversationId, { openOnly: true }, 100);
      return c.json(matters.map(toMatterDTO));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
