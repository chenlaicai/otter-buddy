import type { LinkedResource } from "@entities/conversation/conversation";
import type {
  LinkedResourceDTO,
  KeyInfoDTO,
} from "@contract/api/key-info";

export type { LinkedResourceDTO, KeyInfoDTO };
export type { LinkResourceRequestDTO } from "@contract/api/key-info";

export function toLinkedResourceDTO(
  res: LinkedResource & { unfurl?: LinkedResourceDTO["unfurl"] },
): LinkedResourceDTO {
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
    groupId: res.groupId,
    supersededBy: res.supersededBy,
    // F20261030draft（检视 r1 处置中发现的同族断链）：unfurl join 投影透传——
    // getKeyResources 经 toKeyInfoDTO 重映射时此处曾整体丢弃 unfurl（GET 列表永不携带，
    // ArtifactCard 徽章数据源断链）。undefined 不带键（未抓取语义），null 保留（落空语义）。
    ...(res.unfurl !== undefined ? { unfurl: res.unfurl } : {}),
  };
}

export function toKeyInfoDTO(resources: LinkedResource[]): KeyInfoDTO {
  return {
    resources: resources.map(toLinkedResourceDTO),
  };
}
