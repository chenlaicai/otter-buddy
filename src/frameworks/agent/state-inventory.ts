/**
 * 活状态盘点生成器（件④）
 *
 * 交接时刻一次性执行的机械查询聚合，盘点 6 类跨 session 存活状态。
 * 输出渲染为 markdown checklist，每类一行"有无+指针"，空行也打印。
 *
 * 零 LLM 成本——全部是 DB 查询或目录列举。
 *
 * 采集可信度（H3）：每项携带 {state, value, error?, collectedAt} 四态——
 * collector 抛错 → unavailable（渲染「不可用」而非「无」，错误不伪装成真空）；
 * 真空 → empty；主源失败走降级源 → stale（值可用但非权威源）。
 * 任一项 unavailable → handoffCompleteness = incomplete，新世不得把「无」全信。
 */

import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
import type { LinkedResource } from '@entities/conversation/conversation';
import { scanWorkspaceFiles } from './file-trail-extractor';
import type { Logger } from '@usecases/ports/logger';

/** 采集四态：ok 有值 / empty 真空 / unavailable 采集失败 / stale 降级源可用 */
export type CollectionState = 'ok' | 'empty' | 'unavailable' | 'stale';

/** 单项采集结果（H3 契约：state 与值显式分名，失败不落成空） */
export interface CollectedItem<T> {
  state: CollectionState;
  value?: T;
  /** unavailable 时的失败原因（截断） */
  error?: string;
  collectedAt: string;
}

/** 发言石值 */
export type TalkingStoneValue = { holders: string[]; from?: string } | null;
/** 调度任务值 */
export type ScheduledTaskValue = Array<{ name: string; schedule: string; nextTrigger?: string }>;
/** 产物统计值 */
export type ArtifactsValue = { active: number; superseded: number; flagged: number; latestTitle?: string };
/** healing 值 */
export type HealingOpenValue = { count: number; latestDesc?: string };
/** 进行中值 */
export type ActivityValue = { status: string; waitingFor?: string };

/** 盘点结果：每项带四态元数据；关键失败由 handoffCompleteness 汇总 */
export interface StateInventory {
  /** 发言石在谁手里 + 悬置 yield */
  talkingStone: CollectedItem<TalkingStoneValue>;
  /** 本对话的 active 调度任务 */
  scheduledTasks: CollectedItem<ScheduledTaskValue>;
  /** 工作区存量文件 */
  workspaceFiles: CollectedItem<string[]>;
  /** 产物统计 */
  artifacts: CollectedItem<ArtifactsValue>;
  /** 未解决 healing events */
  healingOpen: CollectedItem<HealingOpenValue>;
  /** 进行中状态 */
  activity: CollectedItem<ActivityValue>;
  /** 任一项 unavailable → incomplete（matters 等关键失败在调用方并入同口径） */
  handoffCompleteness: 'complete' | 'incomplete';
}

/** entries 读取窄接口（收尾批1：替代 queryMessage，时间线唯一真相源）。
 * 从 handoff-package-builder.ts 迁入——该文件的 buildHandoffPackage 死代码出清后，
 *  本接口的唯一活引用是 state-inventory 发言石盘点与 agent-invoker 保留段读取，归位到本文件。 */
export interface HandoffEntryReader {
  getEntries(conversationId: string, options?: { entryType?: string; limit?: number }): Promise<Array<{
    senderId: string | null;
    senderType: string | null;
    entryType: string;
    body: string | null;
    yieldTargets: string[] | null;
    createdAt: string;
  }>>;
}

/** 盘点依赖（由 DI 注入）。
 * 收尾批1：历史读取切 entries——queryMessage（messages 表）退役，
 *  改用 entryRepo 窄接口（getEntries，sequence_num DESC） */
export interface StateInventoryDeps {
  /** entries 读取（发言石状态 = 最新 user entry 的 yieldTargets） */
  entryReader: { getEntries(conversationId: string, options?: { entryType?: string; limit?: number }): Promise<Array<{ senderId: string | null; senderType: string | null; yieldTargets: string[] | null; createdAt: string }>> };
  conversationRepo: ConversationRepository;
  scheduledTaskRepo?: ScheduledTaskRepository;
  healingRepo?: HealingEventRepository;
  listArtifacts: (conversationId?: string) => Promise<LinkedResource[]>;
  workspacePath?: string;
  logger?: Logger;
}

/** 单项失败原因提取（供调用方并入 handoffCompleteness 汇总） */
export function collectUnavailabilityReasons(inv: unknown): string[] {
  const items = inv as Partial<Record<string, CollectedItem<unknown>>> | null | undefined;
  if (!items || typeof items !== 'object') return [];
  const reasons: string[] = [];
  for (const [key, item] of Object.entries(items)) {
    if (item && typeof item === 'object' && 'state' in item && (item as CollectedItem<unknown>).state === 'unavailable') {
      reasons.push(`${key}:${(item as CollectedItem<unknown>).error ?? '采集失败'}`);
    }
  }
  return reasons;
}

const nowIso = () => new Date().toISOString();
const errBrief = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 120);

function item<T>(state: CollectionState, value: T, error?: string): CollectedItem<T> {
  return { state, value, ...(error !== undefined ? { error } : {}), collectedAt: nowIso() };
}

function emptyItem<T>(value: T): CollectedItem<T> {
  return item('empty', value);
}

function unavailableItem<T>(err: unknown): CollectedItem<T> {
  return { state: 'unavailable', error: errBrief(err), collectedAt: nowIso() };
}

/**
 * 收集活状态盘点。
 * collector 抛错经 Promise.allSettled 落为 unavailable，不吞成空值。
 */
export async function collectStateInventory(
  conversationId: string,
  otterId: string,
  deps: StateInventoryDeps,
): Promise<StateInventory> {
  const results = await Promise.allSettled([
    collectTalkingStone(conversationId, deps),
    collectScheduledTasks(conversationId, otterId, deps),
    collectWorkspaceFiles(deps),
    collectArtifacts(conversationId, deps),
    collectHealing(conversationId, deps),
    collectActivity(conversationId, deps),
  ]);

  const unwrap = <T>(r: PromiseSettledResult<CollectedItem<T>>, fallback: CollectedItem<T>): CollectedItem<T> =>
    r.status === 'fulfilled' ? r.value : fallback;

  const inventory: StateInventory = {
    talkingStone: unwrap(results[0], unavailableItem(results[0].status === 'rejected' ? results[0].reason : 'unknown')),
    scheduledTasks: unwrap(results[1], unavailableItem(results[1].status === 'rejected' ? results[1].reason : 'unknown')),
    workspaceFiles: unwrap(results[2], unavailableItem(results[2].status === 'rejected' ? results[2].reason : 'unknown')),
    artifacts: unwrap(results[3], unavailableItem(results[3].status === 'rejected' ? results[3].reason : 'unknown')),
    healingOpen: unwrap(results[4], unavailableItem(results[4].status === 'rejected' ? results[4].reason : 'unknown')),
    activity: unwrap(results[5], unavailableItem(results[5].status === 'rejected' ? results[5].reason : 'unknown')),
    handoffCompleteness: 'complete',
  };
  if (collectUnavailabilityReasons(inventory).length > 0) inventory.handoffCompleteness = 'incomplete';
  return inventory;
}

/** 发言石/悬置 yield（读最新 user entry 的 yieldTargets） */
async function collectTalkingStone(
  conversationId: string,
  deps: StateInventoryDeps,
): Promise<CollectedItem<TalkingStoneValue>> {
  const entries = await deps.entryReader.getEntries(conversationId, { entryType: 'user', limit: 1 });
  const lastEntry = entries.length > 0 ? entries[0] : null;
  if (!lastEntry?.yieldTargets?.length) return emptyItem(null);
  return item('ok', {
    holders: lastEntry.yieldTargets,
    from: lastEntry.senderId ?? undefined,
  });
}

/** 调度任务（依赖未装配 → unavailable：不能确认「无任务」，不伪装真空） */
async function collectScheduledTasks(
  conversationId: string,
  otterId: string,
  deps: StateInventoryDeps,
): Promise<CollectedItem<ScheduledTaskValue>> {
  if (!deps.scheduledTaskRepo) {
    return { state: 'unavailable', error: 'scheduledTaskRepo 未装配', collectedAt: nowIso() };
  }
  const allTasks = await deps.scheduledTaskRepo.getByConversationId(conversationId);
  const active = allTasks
    .filter(t => t.senderId === otterId && t.status === 'active')
    .map(t => ({
      name: t.name || '(unnamed)',
      schedule: t.scheduleType === 'cron' ? (t.cron ?? '?') : `once ${t.triggerAt ?? '?'}`,
      nextTrigger: (t.scheduleType === 'cron' ? t.cron : t.triggerAt) ?? undefined,
    }));
  return active.length > 0 ? item('ok', active) : emptyItem(active);
}

/** 工作区存量文件（同步扫描，异常经 allSettled 落 unavailable） */
function collectWorkspaceFiles(deps: StateInventoryDeps): CollectedItem<string[]> {
  if (!deps.workspacePath) return { state: 'unavailable', error: 'workspacePath 未提供', collectedAt: nowIso() };
  const files = scanWorkspaceFiles(deps.workspacePath);
  return files.length > 0 ? item('ok', files) : emptyItem(files);
}

/** 产物统计 */
async function collectArtifacts(
  conversationId: string,
  deps: StateInventoryDeps,
): Promise<CollectedItem<ArtifactsValue>> {
  const artifacts = await deps.listArtifacts(conversationId);
  let active = 0, superseded = 0, flagged = 0;
  let latestTitle: string | undefined;
  let latestTime = 0;

  for (const a of artifacts) {
    if (a.status === 'active') active++;
    else if (a.status === 'superseded') superseded++;
    if (a.userFlagged) flagged++;
    const t = new Date(a.createdAt).getTime();
    if (t > latestTime) {
      latestTime = t;
      if (a.title) latestTitle = a.title;
    }
  }

  const value = { active, superseded, flagged, latestTitle };
  return active > 0 || superseded > 0 ? item('ok', value) : emptyItem(value);
}

/** 未解决 healing events（依赖未装配 → unavailable，理由同调度任务） */
async function collectHealing(
  conversationId: string,
  deps: StateInventoryDeps,
): Promise<CollectedItem<HealingOpenValue>> {
  if (!deps.healingRepo) {
    return { state: 'unavailable', error: 'healingRepo 未装配', collectedAt: nowIso() };
  }
  const events = await deps.healingRepo.findByConversation(conversationId);
  const openEvents = events.filter(e => e.status === 'open');
  const value = {
    count: openEvents.length,
    latestDesc: openEvents[0]?.description?.slice(0, 100),
  };
  return openEvents.length > 0 ? item('ok', value) : emptyItem(value);
}

/** 进行中状态：主源 conversationRepo 失败走 entries 降级 → stale（值可用但非权威源） */
async function collectActivity(
  conversationId: string,
  deps: StateInventoryDeps,
): Promise<CollectedItem<ActivityValue>> {
  try {
    // listConversationsWithMeta 返回 { items, total }（分组分页）
    const { items } = await deps.conversationRepo.listConversationsWithMeta('', { limit: 1000 });
    const conv = items.find(c => c.id === conversationId);
    if (!conv) return emptyItem({ status: 'unknown' });

    // activityStatus 已在 listConversationsWithMeta 中返回
    const status = (conv as { activityStatus?: string }).activityStatus ?? 'unknown';
    const value = { status };
    return status === 'idle' || status === 'unknown' ? emptyItem(value) : item('ok', value);
  } catch (primaryError) {
    // 降级：查最新 user entry 的发言石去向（entries）——非权威源，标 stale
    try {
      const entries = await deps.entryReader.getEntries(conversationId, { entryType: 'user', limit: 1 });
      const lastEntry = entries.length > 0 ? entries[0] : null;
      if (lastEntry?.yieldTargets?.length) {
        return { state: 'stale', value: { status: 'awaiting', waitingFor: lastEntry.yieldTargets.join(', ') }, error: errBrief(primaryError), collectedAt: nowIso() };
      }
    } catch { /* 双源皆败 → 主源错误上抛，落 unavailable */ }
    throw primaryError;
  }
}

/**
 * 渲染状态盘点为 markdown checklist。
 * 空行也打印——"调度任务：无"比省略好；采集失败打印「不可用」+原因，绝不写成「无」。
 */
// eslint-disable-next-line max-statements, complexity, max-lines-per-function -- 6 类状态逐态渲染（判别测试锁「不可用」文案）
export function renderStateInventory(inv: StateInventory, timestamp?: string): string {
  const ts = timestamp ?? new Date().toISOString();
  const parts: string[] = [`## 活状态盘点（机械生成，${ts}）`];

  // 发言石
  if (inv.talkingStone.state === 'unavailable') {
    parts.push(`- 发言石：不可用（采集失败：${inv.talkingStone.error ?? 'unknown'}）`);
  } else if (inv.talkingStone.value) {
    const holders = inv.talkingStone.value.holders.join(', ');
    const from = inv.talkingStone.value.from ? `（${inv.talkingStone.value.from} yield）` : '';
    parts.push(`- 发言石：在 ${holders} 手中${from}`);
  } else {
    parts.push('- 发言石：无');
  }

  // 调度任务
  if (inv.scheduledTasks.state === 'unavailable') {
    parts.push(`- 调度任务：不可用（采集失败：${inv.scheduledTasks.error ?? 'unknown'}）`);
  } else if ((inv.scheduledTasks.value ?? []).length > 0) {
    const taskStrs = inv.scheduledTasks.value!.map(t =>
      `"${t.name}" ${t.schedule}${t.nextTrigger ? ` 下次 ${t.nextTrigger}` : ''}`
    );
    parts.push(`- 调度任务：${inv.scheduledTasks.value!.length} 个 active——${taskStrs.join(' ｜ ')}`);
  } else {
    parts.push('- 调度任务：无');
  }

  // 工作区
  if (inv.workspaceFiles.state === 'unavailable') {
    parts.push(`- 工作区：不可用（采集失败：${inv.workspaceFiles.error ?? 'unknown'}）`);
  } else if ((inv.workspaceFiles.value ?? []).length > 0) {
    parts.push(`- 工作区：${inv.workspaceFiles.value!.length} 个文件——${inv.workspaceFiles.value!.join(', ')}`);
  } else {
    parts.push('- 工作区：空');
  }

  // 产物
  if (inv.artifacts.state === 'unavailable') {
    parts.push(`- 产物：不可用（采集失败：${inv.artifacts.error ?? 'unknown'}）`);
  } else {
    const art = inv.artifacts.value ?? { active: 0, superseded: 0, flagged: 0 };
    const artParts = [`${art.active} active`];
    if (art.flagged > 0) artParts.push(`${art.flagged} flagged`);
    let artLine = `- 产物：${artParts.join('（')}）`;
    if (art.latestTitle) artLine += `｜ 最近：${art.latestTitle}`;
    parts.push(artLine);
  }

  // Healing
  if (inv.healingOpen.state === 'unavailable') {
    parts.push(`- Healing：不可用（采集失败：${inv.healingOpen.error ?? 'unknown'}）`);
  } else {
    const heal = inv.healingOpen.value ?? { count: 0 };
    if (heal.count > 0) {
      let healLine = `- Healing：${heal.count} open`;
      if (heal.latestDesc) healLine += `｜ 最近：${heal.latestDesc}`;
      parts.push(healLine);
    } else {
      parts.push('- Healing：无 open');
    }
  }

  // 进行中
  if (inv.activity.state === 'unavailable') {
    parts.push(`- 进行中：不可用（采集失败：${inv.activity.error ?? 'unknown'}）`);
  } else {
    const act = inv.activity.value ?? { status: 'idle' };
    if (act.status !== 'idle' && act.status !== 'unknown') {
      let actLine = `- 进行中：${act.status}`;
      if (act.waitingFor) actLine += `，等待 ${act.waitingFor}`;
      if (inv.activity.state === 'stale') actLine += '（降级源，非权威口径）';
      parts.push(actLine);
    } else {
      parts.push('- 进行中：无');
    }
  }

  return parts.join('\n');
}
