import type { Otter } from "@entities/otter/otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type {
  OtterDTO,
  OtterSessionDTO,
} from "@contract/api/otter";

export type { OtterDTO, OtterSessionDTO };
export type { CreateOtterRequestDTO } from "@contract/api/otter";

export function toOtterDTO(otter: Otter, modelAlias?: string): OtterDTO {
  return {
    id: otter.id,
    name: otter.name,
    type: otter.type,
    status: otter.status,
    role: otter.role,
    parentOtterId: otter.parentOtterId,
    createdAt: otter.createdAt,
    dissolvedAt: otter.dissolvedAt,
    ...(modelAlias !== undefined && { modelAlias }),
  };
}

export function toOtterSessionDTO(session: OtterSession): OtterSessionDTO {
  return {
    id: session.id,
    otterId: session.otterId,
    status: session.status,
    previousSessionId: session.previousSessionId,
    startedAt: session.startedAt,
    archivedAt: session.archivedAt,
    archiveReason: session.archiveReason,
    isNegativeCase: session.isNegativeCase,
    summary: session.summary,
  };
}
