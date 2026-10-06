/**
 * RegisterMatter——准入白名单三条的登记 usecase（F20261006mtlp §3 生死线）。
 *
 * matter 只能由白名单动作产生：
 * 1. L2 显式拍板项的 yield to user（yield 工具 expects_partner_decision 打标 →
 *    yield 工具内调本 usecase，state=WAITING_PARTNER，owner=调用獭）
 * 2. 搭档说「回头再说」（P2 板上入口；P1 仅工具/系统路径可达）
 * 3. 跨日未收尾任务（P3 三省吾身扫描）
 *
 * 獭随手不能开 matter（调用方权限不在本层——本 usecase 是登记物理入口，
 * 防泛滥靠「白名单硬编码在产生路径」：只有 yield 工具与扫描器调这里）。
 * L0 不产生 matter（准入白名单三条均产生不了 L0，不造 L0 登记路径）。
 */

import { DomainError } from '@entities/errors';
import type { Matter, MatterLevel, MatterState } from '@entities/matter/matter';
import type { MatterRepository } from './matter-repository';

/** 登记输入 */
export interface RegisterMatterInput {
  conversationId: string;
  title: string;
  /** 准入路径 1 = yield entry ID（也是路径 3 的去重键） */
  originMessageId?: string | null;
  /** 负责獭：路径 1=发起 yield 的獭 */
  ownerOtterId?: string | null;
  level?: MatterLevel | null;
  /** 登记即态：路径 1=WAITING_PARTNER；路径 2/3=OPEN */
  initialState: Extract<MatterState, 'WAITING_PARTNER' | 'OPEN'>;
  waitingOn?: string | null;
  waitingFor?: string | null;
  /** 决策请求挂点（L2 = 简报卡三层结构 JSON） */
  payload?: string | null;
}

/** matter 人可读短锚（M-xxx + UUID 拼接——跨 session 稳定引用，比消息 ID 轻、比 F 文档 ID 短） */
export function matterShortAnchor(id: string): string {
  return `M-${id.slice(0, 8)}`;
}

export class RegisterMatter {
  constructor(private readonly repo: MatterRepository) {}

  async execute(input: RegisterMatterInput): Promise<Matter> {
    if (!input.title?.trim()) {
      throw new DomainError('matter 登记失败：title 必填（一句话事情名）', 'validation');
    }
    if (input.initialState !== 'WAITING_PARTNER' && input.initialState !== 'OPEN') {
      throw new DomainError(
        `matter 登记失败：initialState 只能是 WAITING_PARTNER（准入路径 1）或 OPEN（路径 2/3），收到 ${input.initialState}`,
        'validation',
      );
    }

    const now = new Date().toISOString();
    const matter: Matter = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      title: input.title.trim(),
      originMessageId: input.originMessageId ?? null,
      ownerOtterId: input.ownerOtterId ?? null,
      level: input.level ?? null,
      state: input.initialState,
      waitingOn: input.waitingOn ?? (input.initialState === 'WAITING_PARTNER' ? 'partner' : null),
      waitingFor: input.waitingFor ?? null,
      payload: input.payload ?? null,
      resolution: null,
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    await this.repo.create(matter);
    return matter;
  }
}
