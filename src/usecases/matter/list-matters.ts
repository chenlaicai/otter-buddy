/**
 * ListMatters——open 清单查询 usecase（F20261006mtlp P1）。
 *
 * 读路径消费方：①右侧栏「待办」tab 只读 API ②restart 机械供料（handoff_open_matters）
 * ③獭侧 list_matters 工具。按 created_at 倒序，调用方排序展示。
 */

import type { Matter, MatterQueryFilter } from '@entities/matter/matter';
import type { MatterRepository } from './matter-repository';

export class ListMatters {
  constructor(private readonly repo: MatterRepository) {}

  /** 本对话 open 事项清单（存续态四值，不含终态） */
  async openByConversation(conversationId: string, limit = 100): Promise<Matter[]> {
    return this.repo.findByConversation(conversationId, { openOnly: true }, limit);
  }

  /** 按过滤条件查询（獭侧工具参数面） */
  async byConversation(conversationId: string, filter?: MatterQueryFilter, limit = 50): Promise<Matter[]> {
    return this.repo.findByConversation(conversationId, filter, limit);
  }
}
