/**
 * 活状态盘点生成器（F20260825hndf 件④）
 *
 * 交接时刻一次性执行的机械查询聚合，盘点 6 类跨 session 存活状态。
 * 输出渲染为 markdown checklist，每类一行"有无+指针"，空行也打印。
 *
 * 零 LLM 成本——全部是 DB 查询或目录列举。
 */

import type { QueryMessage } from '@usecases/conversation/query-message';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
import type { LinkedResource } from '@entities/conversation/conversation';
import { scanWorkspaceFiles } from './file-trail-extractor';
import type { Logger } from '@usecases/ports/logger';

/** 盘点结果 */
export interface StateInventory {
  /** B1: 发言石在谁手里 + 悬置 yield */
  talkingStone: { holders: string[]; from?: string } | null;
  /** B2: 本对话的 active 调度任务 */
  scheduledTasks: Array<{ name: string; schedule: string; nextTrigger?: string }>;
  /** B3: 工作区存量文件 */
  workspaceFiles: string[];
  /** B4: 产物统计 */
  artifacts: { active: number; superseded: number; flagged: number; latestTitle?: string };
  /** B5: 未解决 healing events */
  healingOpen: { count: number; latestDesc?: string };
  /** B6: 进行中状态 */
  activity: { status: string; waitingFor?: string };
}

/** 盘点依赖（由 DI 注入） */
export interface StateInventoryDeps {
  queryMessage: QueryMessage;
  conversationRepo: ConversationRepository;
  scheduledTaskRepo?: ScheduledTaskRepository;
  healingRepo?: HealingEventRepository;
  listArtifacts: (conversationId?: string) => Promise<LinkedResource[]>;
  workspacePath?: string;
  logger?: Logger;
}

/**
 * 收集活状态盘点。
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

  const unwrap = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled' ? r.value : fallback;

  return {
    talkingStone: unwrap(results[0], null),
    scheduledTasks: unwrap(results[1], []),
    workspaceFiles: unwrap(results[2], []),
    artifacts: unwrap(results[3], { active: 0, superseded: 0, flagged: 0 }),
    healingOpen: unwrap(results[4], { count: 0 }),
    activity: unwrap(results[5], { status: 'unknown' }),
  };
}

/** B1: 发言石/悬置 yield */
async function collectTalkingStone(
  conversationId: string,
  deps: StateInventoryDeps,
): Promise<{ holders: string[]; from?: string } | null> {
  const msgs = await deps.queryMessage.getMessages(conversationId, { limit: 1 });
    const lastMsg = msgs.length > 0 ? msgs[0] : null;
  if (!lastMsg?.talkingStonePassedTo?.length) return null;
  return {
    holders: lastMsg.talkingStonePassedTo,
    from: lastMsg.senderId,
  };
}

/** B2: 调度任务 */
async function collectScheduledTasks(
  conversationId: string,
  otterId: string,
  deps: StateInventoryDeps,
): Promise<Array<{ name: string; schedule: string; nextTrigger?: string }>> {
  if (!deps.scheduledTaskRepo) return [];
  try {
    const allTasks = await deps.scheduledTaskRepo.getByConversationId(conversationId);
    return allTasks
      .filter(t => t.senderId === otterId && t.status === 'active')
      .map(t => ({
        name: t.name || '(unnamed)',
        schedule: t.scheduleType === 'cron' ? (t.cron ?? '?') : `once ${t.triggerAt ?? '?'}`,
        nextTrigger: (t.scheduleType === 'cron' ? t.cron : t.triggerAt) ?? undefined,
      }));
  } catch (err) {
    deps.logger?.warn('[state-inventory] Failed to collect scheduled tasks', { error: String(err) });
    return [];
  }
}

/** B3: 工作区存量文件 */
function collectWorkspaceFiles(deps: StateInventoryDeps): string[] {
  if (!deps.workspacePath) return [];
  return scanWorkspaceFiles(deps.workspacePath);
}

/** B4: 产物统计 */
async function collectArtifacts(
  conversationId: string,
  deps: StateInventoryDeps,
): Promise<{ active: number; superseded: number; flagged: number; latestTitle?: string }> {
  try {
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

    return { active, superseded, flagged, latestTitle };
  } catch (err) {
    deps.logger?.warn('[state-inventory] Failed to collect artifacts', { error: String(err) });
    return { active: 0, superseded: 0, flagged: 0 };
  }
}

/** B5: 未解决 healing events */
async function collectHealing(
  conversationId: string,
  deps: StateInventoryDeps,
): Promise<{ count: number; latestDesc?: string }> {
  if (!deps.healingRepo) return { count: 0 };
  try {
    const events = await deps.healingRepo.findByConversation(conversationId);
    const openEvents = events.filter(e => e.status === 'open');
    return {
      count: openEvents.length,
      latestDesc: openEvents[0]?.description?.slice(0, 100),
    };
  } catch (err) {
    deps.logger?.warn('[state-inventory] Failed to collect healing events', { error: String(err) });
    return { count: 0 };
  }
}

/** B6: 进行中状态 */
async function collectActivity(
  conversationId: string,
  deps: StateInventoryDeps,
): Promise<{ status: string; waitingFor?: string }> {
  try {
    const conversations = await deps.conversationRepo.listConversationsWithMeta('', { limit: 1000 });
    const conv = conversations.find(c => c.id === conversationId);
    if (!conv) return { status: 'unknown' };

    // activityStatus 已在 listConversationsWithMeta 中返回
    const status = (conv as { activityStatus?: string }).activityStatus ?? 'unknown';
    return { status };
  } catch {
    // 降级：查最近消息的状态
    try {
      const msgs = await deps.queryMessage.getMessages(conversationId, { limit: 1 });
    const lastMsg = msgs.length > 0 ? msgs[0] : null;
      if (lastMsg?.talkingStonePassedTo?.length) {
        return { status: 'awaiting', waitingFor: lastMsg.talkingStonePassedTo.join(', ') };
      }
    } catch { /* 忽略 */ }
    return { status: 'idle' };
  }
}

/**
 * 渲染状态盘点为 markdown checklist。
 * 空行也打印——"调度任务：无"比省略好。
 */
// eslint-disable-next-line max-statements, complexity -- 6 类状态渲染
export function renderStateInventory(inv: StateInventory, timestamp?: string): string {
  const ts = timestamp ?? new Date().toISOString();
  const parts: string[] = [`## 活状态盘点（机械生成，${ts}）`];

  // B1: 发言石
  if (inv.talkingStone) {
    const holders = inv.talkingStone.holders.join(', ');
    const from = inv.talkingStone.from ? `（${inv.talkingStone.from} yield）` : '';
    parts.push(`- 发言石：在 ${holders} 手中${from}`);
  } else {
    parts.push('- 发言石：无');
  }

  // B2: 调度任务
  if (inv.scheduledTasks.length > 0) {
    const taskStrs = inv.scheduledTasks.map(t =>
      `"${t.name}" ${t.schedule}${t.nextTrigger ? ` 下次 ${t.nextTrigger}` : ''}`
    );
    parts.push(`- 调度任务：${inv.scheduledTasks.length} 个 active——${taskStrs.join(' ｜ ')}`);
  } else {
    parts.push('- 调度任务：无');
  }

  // B3: 工作区
  if (inv.workspaceFiles.length > 0) {
    parts.push(`- 工作区：${inv.workspaceFiles.length} 个文件——${inv.workspaceFiles.join(', ')}`);
  } else {
    parts.push('- 工作区：空');
  }

  // B4: 产物
  const artParts = [`${inv.artifacts.active} active`];
  if (inv.artifacts.flagged > 0) artParts.push(`${inv.artifacts.flagged} flagged`);
  let artLine = `- 产物：${artParts.join('（')}）`;
  if (inv.artifacts.latestTitle) artLine += `｜ 最近：${inv.artifacts.latestTitle}`;
  parts.push(artLine);

  // B5: Healing
  if (inv.healingOpen.count > 0) {
    let healLine = `- Healing：${inv.healingOpen.count} open`;
    if (inv.healingOpen.latestDesc) healLine += `｜ 最近：${inv.healingOpen.latestDesc}`;
    parts.push(healLine);
  } else {
    parts.push('- Healing：无 open');
  }

  // B6: 进行中
  if (inv.activity.status !== 'idle' && inv.activity.status !== 'unknown') {
    let actLine = `- 进行中：${inv.activity.status}`;
    if (inv.activity.waitingFor) actLine += `，等待 ${inv.activity.waitingFor}`;
    parts.push(actLine);
  } else {
    parts.push('- 进行中：无');
  }

  return parts.join('\n');
}
