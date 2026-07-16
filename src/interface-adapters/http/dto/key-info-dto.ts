import type { KeyFact, LinkedResource, KeyInfo } from "@entities/conversation/conversation";
import type {
  KeyFactDTO,
  LinkedResourceDTO,
  KeyInfoDTO,
} from "@contract/api/key-info";

export type { KeyFactDTO, LinkedResourceDTO, KeyInfoDTO };
export type { AddKeyFactRequestDTO, LinkResourceRequestDTO } from "@contract/api/key-info";

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
