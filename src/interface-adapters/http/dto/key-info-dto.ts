import type { LinkedResource } from "@entities/conversation/conversation";
import type {
  LinkedResourceDTO,
  KeyInfoDTO,
} from "@contract/api/key-info";

export type { LinkedResourceDTO, KeyInfoDTO };
export type { LinkResourceRequestDTO } from "@contract/api/key-info";

export function toLinkedResourceDTO(res: LinkedResource): LinkedResourceDTO {
  return {
    id: res.id,
    conversationId: res.conversationId,
    resourceType: res.resourceType,
    url: res.url,
    title: res.title,
    content: res.content,
    category: res.category,
    userFlagged: res.userFlagged,
    metadata: res.metadata,
    linkedBy: res.linkedBy,
    otterId: res.otterId,
    autoLinked: res.autoLinked,
    createdAt: res.createdAt,
    status: res.status,
    linkedAtTurnNumber: res.linkedAtTurnNumber,
    statusChangedAtTurnNumber: res.statusChangedAtTurnNumber,
    groupId: res.groupId,
    supersededBy: res.supersededBy,
  };
}

export function toKeyInfoDTO(resources: LinkedResource[]): KeyInfoDTO {
  return {
    resources: resources.map(toLinkedResourceDTO),
  };
}
