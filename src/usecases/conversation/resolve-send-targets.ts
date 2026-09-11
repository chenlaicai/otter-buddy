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
  /** 最新一条 speak entry（默认派发回退 1：最后发言的獭） */
  getLastSpeakEntry(conversationId: string): Promise<{ senderId: string | null } | null>;
  /** speak 序最近 N 条的发言者（多只 running 时按最近发言取——搭档拍板优先级 2） */
  getRecentSpeakSenders(conversationId: string, limit: number): Promise<Array<string | null>>;
  /** otter 实体查询（状态/类型/名字） */
  getOtterById(otterId: string): Promise<{ id: string; name: string; status: string; type: string } | null>;
  /** F20260910ctlv test12：当前 running invoke 的獭集合（steer/followUp 语义的优先目标源） */
  getRunningOtterIds(conversationId: string): Promise<string[]>;
}

/** 从 repos 组装 ResolveTargetsDeps（装配处用） */
export function buildResolveTargetsDeps(
  participantQuery: (conversationId: string) => Promise<Array<{ otterId: string }>>,
  entryRepo: EntryRepository,
  otterRepo: OtterRepository,
  invokeRepo?: { getInvokes(conversationId: string, options?: { status?: string; limit?: number }): Promise<Array<{ otterId: string; status: string }>> },
): ResolveTargetsDeps {
  return {
    getActiveParticipants: participantQuery,
    getLastSpeakEntry: async (conversationId) => {
      const entries = await entryRepo.getEntries(conversationId, { entryType: "speak", limit: 1 });
      const last = entries[0];
      return last ? { senderId: last.senderId } : null;
    },
    getRecentSpeakSenders: async (conversationId, limit) => {
      const entries = await entryRepo.getEntries(conversationId, { entryType: "speak", limit });
      return entries.map(e => e.senderId);
    },
    getOtterById: (otterId) => otterRepo.getById(otterId) as Promise<{ id: string; name: string; status: string; type: string } | null>,
    // F20260910ctlv test12：running 判定用 invokes 表（唯一状态机）；未注入时返回空（退回旧逻辑）
    getRunningOtterIds: invokeRepo
      ? async (conversationId) => {
          const invokes = await invokeRepo.getInvokes(conversationId, { status: "running", limit: 200 });
          return [...new Set(invokes.filter(i => i.status === "running").map(i => i.otterId))];
        }
      : async () => [],
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
 * 默认派发对象（F20260910ctlv test12 搭档拍板优先级）:
 * 1. 当前 running 的獭（invokes 表 status=running）——steer/followUp 语义：用户在獭行动中
 *    插话应注入那只 running 的獭，而不是按「最后完成发言」另选目标新开 invoke
 *    （test12 案发：话獭 running 时说「停下」被解析给大獭 → 双大獭 invoke 并发）
 *    - 单只 running → 选它
 *    - 多只 running → 选「用户发言前最新一次 speak」的那只（在 running 集合里按最近 speak 取）
 * 2. 无 running → 最后完成发言的獭（entries.speak 最新一条 senderId），且仍在场、未解散
 * 3. 兜底：在场且未解散的大獭（type=big）
 * 全部找不到抛错（不退化为全员广播）
 */
async function resolveDefaultTargets(
  deps: ResolveTargetsDeps,
  conversationId: string,
): Promise<string[]> {
  const participants = await deps.getActiveParticipants(conversationId);
  const activeOtterIds = new Set(participants.map((p) => p.otterId));

  // 优先级 1：running 的獭（在场 + active 过滤）——steer/followUp 语义
  const running = await pickRunningTarget(deps, conversationId, activeOtterIds);
  if (running) return [running];

  // 优先级 2：最后完成发言的獭
  const lastSpeak = await deps.getLastSpeakEntry(conversationId);
  if (lastSpeak?.senderId && activeOtterIds.has(lastSpeak.senderId)) {
    const lastSpeaker = await deps.getOtterById(lastSpeak.senderId);
    if (lastSpeaker?.status === "active") {
      return [lastSpeaker.id];
    }
  }

  // 优先级 3：兜底在场大獭
  for (const p of participants) {
    const otter = await deps.getOtterById(p.otterId);
    if (otter?.type === "big" && otter.status === "active") {
      return [otter.id];
    }
  }

  const { DomainError } = await import("@entities/errors");
  throw new DomainError(
    "Cannot resolve default dispatch target: no running otter, no last speaker and no big otter among participants",
    "validation",
  );
}

/** 优先级 1 子步骤：running 獭选取（单只直选；多只按最近 speak；空集回 null 走下级优先级）。
 *  F20260910ctlv test12 搭档拍板：用户在獭 running 期间插话应 steer 进那只獭 */
async function pickRunningTarget(
  deps: ResolveTargetsDeps,
  conversationId: string,
  activeOtterIds: Set<string>,
): Promise<string | null> {
  const runningIds = (await deps.getRunningOtterIds(conversationId))
    .filter(id => activeOtterIds.has(id));
  if (runningIds.length === 0) return null;

  const runnableRunning: string[] = [];
  for (const id of runningIds) {
    const otter = await deps.getOtterById(id);
    if (otter?.status === "active") runnableRunning.push(id);
  }
  if (runnableRunning.length === 0) return null;
  if (runnableRunning.length === 1) return runnableRunning[0]!;

  // 多只 running：按全局 speak 序（sequence_num DESC）扫，第一个属于 running 集合的发言者胜出
  //（搭档拍板：多只都在跑时看发言前最新一次 speak 是谁的）
  const recentSpeakers = await deps.getRecentSpeakSenders(conversationId, 50);
  for (const sender of recentSpeakers) {
    if (sender && runnableRunning.includes(sender)) return sender;
  }
  // running 集合里无任何 speak 记录（同时开工无发言，无从比较）→ 取首只
  return runnableRunning[0]!;
}
