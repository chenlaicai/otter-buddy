/**
 * F20260910ctlv：user/system 发言目标解析（独立共享模块）。
 *
 * Why: 彻底切换后 user 消息只写 entries（SendEntry.sendUserEntry），
 * 原本挂在 SendMessage.send 内的目标解析链（显式校验 + @提及解析 + 默认派发）
 * 是路由点火的前置依赖，必须随入口一起搬到 entries 世界。
 * 数据源全部切换：参与者名册不变，「最后发言的獭」从 messages 改读 entries.speak。
 */

import type { EntryRepository } from "./entry-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { Logger } from "@usecases/ports/logger";
import { parseMentionsFromText } from "./mention-parser";

/** 目标解析所需的最小 repo 面（依赖注入，避免 SendEntry 与 conversation-repository 硬绑） */
export interface ResolveTargetsDeps {
  /** 参与者名册查询（getActiveParticipants） */
  getActiveParticipants(conversationId: string): Promise<Array<{ otterId: string }>>;
  /** 最后一条 speak entry（默认派发目标 1：最后发言的獭） */
  getLastSpeakEntry(conversationId: string): Promise<{ senderId: string | null } | null>;
  /** otter 实体查询（状态/类型/名字） */
  getOtterById(otterId: string): Promise<{ id: string; name: string; status: string; type: string } | null>;
}

/** 从 repos 组装 ResolveTargetsDeps（装配处用） */
export function buildResolveTargetsDeps(
  participantQuery: (conversationId: string) => Promise<Array<{ otterId: string }>>,
  entryRepo: EntryRepository,
  otterRepo: OtterRepository,
): ResolveTargetsDeps {
  return {
    getActiveParticipants: participantQuery,
    getLastSpeakEntry: async (conversationId) => {
      const entries = await entryRepo.getEntries(conversationId, { entryType: "speak", limit: 1 });
      const last = entries[0];
      return last ? { senderId: last.senderId } : null;
    },
    getOtterById: (otterId) => otterRepo.getById(otterId) as Promise<{ id: string; name: string; status: string; type: string } | null>,
  };
}

/**
 * 解析发言目标（user 消息统一入口；system 消息豁免校验直接用入参目标）。
 *
 * 规则（与原 SendMessage.resolveUserTargets 语义一致）：
 * 1. 有显式目标（@点名/卡片路由）：校验在场 + otter active，不可用退默认派发（带 feedback）
 * 2. 无显式目标且文本含 @：从文本解析提及（F20260820i333）
 * 3. 全空：默认派发——最后发言的獭（仍在场）→ 兜底在场大獭
 */
export async function resolveSendTargets(
  input: {
    deps: ResolveTargetsDeps;
    logger: Logger;
    conversationId: string;
    explicit: string[];
    body?: string;
    senderType?: "user" | "system";
  },
): Promise<{ targets: string[]; feedback?: string }> {
  const { deps, logger, conversationId, explicit, body, senderType = "user" } = input;
  if (senderType !== "user") return { targets: explicit };

  /** 有显式目标或无消息体时直接走校验/默认，不查参与者名册 */
  if (explicit.length > 0) {
    const participants = await deps.getActiveParticipants(conversationId);
    const participantNames = await fetchParticipantNames(deps, participants);
    return validateTargets(deps, logger, conversationId, explicit, { participants, participantNames });
  }
  /** 空显式时：先检查文本是否含 @，无 @ 则跳过名册查询（避免 N+1） */
  if (!body || !body.includes('@')) {
    return { targets: await resolveDefaultTargets(deps, conversationId) };
  }
  const participants = await deps.getActiveParticipants(conversationId);
  const participantNames = await fetchParticipantNames(deps, participants);
  const { resolvedIds, invalidNames } = parseMentionsFromText(body, participantNames);
  if (resolvedIds.length === 0 && invalidNames.length === 0) {
    return { targets: await resolveDefaultTargets(deps, conversationId) };
  }
  if (invalidNames.length > 0) logger.info('从文本解析到无效 @提及', { conversationId, invalidNames });
  return validateTargets(deps, logger, conversationId, resolvedIds, { participants, participantNames });
}

/** 获取参与者对应 otter 名字 */
async function fetchParticipantNames(
  deps: ResolveTargetsDeps,
  participants: Array<{ otterId: string }>,
): Promise<Array<{ otterId: string; otterName: string }>> {
  const names: Array<{ otterId: string; otterName: string }> = [];
  for (const p of participants) {
    const otter = await deps.getOtterById(p.otterId);
    if (otter) names.push({ otterId: p.otterId, otterName: otter.name });
  }
  return names;
}

/** 校验显式目标 + 构建 feedback（F20260820i333） */
async function validateTargets(
  deps: ResolveTargetsDeps,
  logger: Logger,
  conversationId: string,
  effectiveExplicit: string[],
  roster: { participants: Array<{ otterId: string }>; participantNames: Array<{ otterId: string; otterName: string }> },
): Promise<{ targets: string[]; feedback?: string }> {
  const { participants, participantNames } = roster;
  const participantIds = new Set(participants.map((p) => p.otterId));
  const otterNameMap = new Map<string, string>();
  for (const n of participantNames) otterNameMap.set(n.otterId, n.otterName);
  const valid: string[] = [];
  const invalidIds: string[] = [];
  for (const id of effectiveExplicit) {
    if (!participantIds.has(id)) { invalidIds.push(id); continue; }
    const otter = await deps.getOtterById(id);
    if (otter?.status === 'active') valid.push(id);
    else invalidIds.push(id);
  }
  if (valid.length > 0) {
    if (invalidIds.length > 0) {
      logger.info('部分显式发言石目标不可用，已过滤', { conversationId, explicitTargets: effectiveExplicit, validTargets: valid });
      return { targets: valid, feedback: `@提及的目标不可用：${invalidIds.map(id => otterNameMap.get(id) ?? id).join('、')}（可能已退场或解散）` };
    }
    return { targets: valid };
  }
  logger.warn('显式发言石目标全部不可用，退默认派发', { conversationId, explicitTargets: effectiveExplicit });
  const defaultTargets = await resolveDefaultTargets(deps, conversationId);
  const feedback = `@提及的目标不可用：${invalidIds.map(id => otterNameMap.get(id) ?? id).join('、')}（可能已退场或解散），已派给 ${otterNameMap.get(defaultTargets[0]) ?? '大獭'}`;
  return { targets: defaultTargets, feedback };
}

/**
 * 默认派发对象：
 * 1. 最后发言的 otter（entries.speak 最新一条的 senderId），且仍在场、未解散
 * 2. 兜底：在场且未解散的大獭（type=big）
 * 两者都找不到抛错（不退化为全员广播）
 */
async function resolveDefaultTargets(
  deps: ResolveTargetsDeps,
  conversationId: string,
): Promise<string[]> {
  const participants = await deps.getActiveParticipants(conversationId);
  const activeOtterIds = new Set(participants.map((p) => p.otterId));

  const lastSpeak = await deps.getLastSpeakEntry(conversationId);
  if (lastSpeak?.senderId && activeOtterIds.has(lastSpeak.senderId)) {
    const lastSpeaker = await deps.getOtterById(lastSpeak.senderId);
    if (lastSpeaker?.status === "active") {
      return [lastSpeaker.id];
    }
  }

  for (const p of participants) {
    const otter = await deps.getOtterById(p.otterId);
    if (otter?.type === "big" && otter.status === "active") {
      return [otter.id];
    }
  }

  const { DomainError } = await import("@entities/errors");
  throw new DomainError(
    "Cannot resolve default dispatch target: no last speaker and no big otter among participants",
    "validation",
  );
}
