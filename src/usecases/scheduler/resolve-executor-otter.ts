import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { OtterRepository } from '@usecases/otter/otter-repository';

export const DEFAULT_EXECUTOR_ROLE = '大獭';

/** 角色名不是任意獭名的别名：同名小獭不能冒充大獭执行编排任务。 */
const ROLE_TO_OTTER_TYPE: Readonly<Record<string, 'big' | 'small'>> = {
  [DEFAULT_EXECUTOR_ROLE]: 'big',
};

type ExecutorTask = Pick<ScheduledTask, 'conversationId' | 'executorRole' | 'talkingStonePassedTo'>;
type ExecutorDeps = {
  convRepo: Pick<ConversationRepository, 'getActiveParticipants' | 'getLastInvokeStartedAtByOtter' | 'getLastSpeakBySender'>;
  otterRepo?: Pick<OtterRepository, 'getById'>;
};
type Candidate = { id: string; name: string; type: string; createdAt: string };

export interface ResolvedExecutorOtter {
  id: string;
  name: string;
  type: string;
  source: 'role' | 'fallback';
}

export type ExecutorResolution =
  | { otter: ResolvedExecutorOtter; reason?: undefined }
  | { otter: null; reason: 'no-such-role-in-roster' };

async function resolveLegacy(task: ExecutorTask, deps: ExecutorDeps): Promise<ExecutorResolution> {
  const legacyId = task.talkingStonePassedTo[0];
  // 最小装配没有实体仓库时只能走显式兼容出口，不能假装完成名册解析。
  if (!deps.otterRepo) {
    return legacyId
      ? { otter: { id: legacyId, name: task.executorRole || DEFAULT_EXECUTOR_ROLE, type: '', source: 'fallback' } }
      : { otter: null, reason: 'no-such-role-in-roster' };
  }
  // Why fallback 不校验名册：这是已声明的优雅降级（任务不丢优先），不是新的按名解析路径。
  const legacy = legacyId ? await deps.otterRepo.getById(legacyId) : null;
  if (legacy?.status !== 'active') return { otter: null, reason: 'no-such-role-in-roster' };
  return { otter: { id: legacy.id, name: legacy.name, type: legacy.type, source: 'fallback' } };
}

async function findRoleCandidates(task: ExecutorTask, deps: ExecutorDeps, expectedType: string): Promise<Candidate[]> {
  const participants = (await deps.convRepo.getActiveParticipants(task.conversationId)) ?? [];
  const candidates: Candidate[] = [];
  for (const participant of participants) {
    const otter = await deps.otterRepo!.getById(participant.otterId);
    if (otter?.status === 'active' && otter.name === task.executorRole && otter.type === expectedType) {
      candidates.push({ id: otter.id, name: otter.name, type: otter.type, createdAt: otter.createdAt });
    }
  }
  return candidates;
}

function latestActivity(candidate: Candidate, invokedAt: Map<string, string>, spokenAt: Map<string, { createdAt: string }>): string {
  return [invokedAt.get(candidate.id), spokenAt.get(candidate.id)?.createdAt, candidate.createdAt]
    .filter((value): value is string => !!value).sort().at(-1) ?? candidate.createdAt;
}

async function selectMostRecent(task: ExecutorTask, deps: ExecutorDeps, candidates: Candidate[]): Promise<Candidate> {
  const [invokedAt, spokenAt] = await Promise.all([
    Promise.resolve(deps.convRepo.getLastInvokeStartedAtByOtter(task.conversationId)).catch(() => new Map<string, string>()),
    Promise.resolve(deps.convRepo.getLastSpeakBySender(task.conversationId)).catch(() => new Map<string, { seq: number; createdAt: string }>()),
  ]);
  return [...candidates].sort((a, b) =>
    latestActivity(b, invokedAt, spokenAt).localeCompare(latestActivity(a, invokedAt, spokenAt)) || a.id.localeCompare(b.id),
  )[0]!;
}

/** 触发时从 active 名册解析当前实例；角色落空才读旧实例字段（保留的兼容出口）。 */
export async function resolveExecutorOtter(task: ExecutorTask, deps: ExecutorDeps): Promise<ExecutorResolution> {
  const role = task.executorRole || DEFAULT_EXECUTOR_ROLE;
  const expectedType = ROLE_TO_OTTER_TYPE[role];
  if (!deps.otterRepo || !expectedType) return resolveLegacy(task, deps);
  const normalizedTask = task.executorRole ? task : { ...task, executorRole: role };
  const candidates = await findRoleCandidates(normalizedTask, deps, expectedType);
  if (candidates.length === 0) return resolveLegacy(normalizedTask, deps);
  const selected = await selectMostRecent(normalizedTask, deps, candidates);
  return { otter: { ...selected, source: 'role' } };
}
