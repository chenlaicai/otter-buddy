import type { Matter } from '@entities/matter/matter';

/** matter 响应（P1 只读——右侧栏「待办」tab 数据源） */
export interface MatterDTO {
  id: string;
  conversationId: string;
  title: string;
  originMessageId: string | null;
  ownerOtterId: string | null;
  level: 'L1' | 'L2' | null;
  state: string;
  waitingOn: string | null;
  waitingFor: string | null;
  payload: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** Entity -> DTO（P1 只读投影，字段全集透传——payload 供裁决界面渲染 P2 用） */
export function toMatterDTO(matter: Matter): MatterDTO {
  return {
    id: matter.id,
    conversationId: matter.conversationId,
    title: matter.title,
    originMessageId: matter.originMessageId,
    ownerOtterId: matter.ownerOtterId,
    level: matter.level,
    state: matter.state,
    waitingOn: matter.waitingOn,
    waitingFor: matter.waitingFor,
    payload: matter.payload,
    resolution: matter.resolution,
    resolvedBy: matter.resolvedBy,
    createdAt: matter.createdAt,
    updatedAt: matter.updatedAt,
    closedAt: matter.closedAt,
  };
}
