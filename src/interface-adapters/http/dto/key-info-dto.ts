import type { KeyFact, LinkedResource, KeyInfo } from "@entities/conversation/conversation";

/** 关键事实 DTO */
export interface KeyFactDTO {
  id: string;
  conversationId: string;
  content: string;
  category: string | null;
  userFlagged: boolean;
  createdBy: string;
  otterId: string | null;
  createdAt: string;
}

/** 链接资源 DTO */
export interface LinkedResourceDTO {
  id: string;
  conversationId: string;
  resourceType: string;
  url: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
}

/** 关键信息组合 DTO */
export interface KeyInfoDTO {
  keyFacts: KeyFactDTO[];
  linkedResources: LinkedResourceDTO[];
}

/** 添加关键事实请求 DTO */
export interface AddKeyFactRequestDTO {
  content: string;
  category?: string;
  createdBy: string;
  otterId?: string;
}

/** 链接资源请求 DTO */
export interface LinkResourceRequestDTO {
  resourceType: string;
  url: string;
  title?: string;
  metadata?: Record<string, unknown>;
  linkedBy: string;
  otterId?: string;
  autoLinked: boolean;
}

export function toKeyFactDTO(fact: KeyFact): KeyFactDTO {
  return {
    id: fact.id,
    conversationId: fact.conversationId,
    content: fact.content,
    category: fact.category,
    userFlagged: fact.userFlagged,
    createdBy: fact.createdBy,
    otterId: fact.otterId,
    createdAt: fact.createdAt,
  };
}

export function toLinkedResourceDTO(res: LinkedResource): LinkedResourceDTO {
  return {
    id: res.id,
    conversationId: res.conversationId,
    resourceType: res.resourceType,
    url: res.url,
    title: res.title,
    metadata: res.metadata,
    linkedBy: res.linkedBy,
    otterId: res.otterId,
    autoLinked: res.autoLinked,
    createdAt: res.createdAt,
  };
}

export function toKeyInfoDTO(info: KeyInfo): KeyInfoDTO {
  return {
    keyFacts: info.keyFacts.map(toKeyFactDTO),
    linkedResources: info.linkedResources.map(toLinkedResourceDTO),
  };
}
