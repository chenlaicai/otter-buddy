/**
 * F20260915cfgt：每日复盘 ensure（仿 healing 先例：settings 缓存幂等 + 分布式锁 + pin）
 *
 * 与 healing 的差异：
 * - 任务 body 是完整 prompt 文本（读 git 模板存 body，paper-trading 模式），
 *   不是 [self-healing-analysis] 拦截标记——拦截标记要动 scheduler 模板解析段，本方案刻意不碰
 * - restartBeforeInvoke: true（每日新 session 防上下文污染，paper-trading-daily 同款）
 */

import type { ManageConversation } from '@usecases/conversation/manage-conversation';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { SendEntry } from '@usecases/conversation/send-entry';
import type { OtterRepository } from '@usecases/otter/otter-repository';
import type { Logger } from '@usecases/ports/logger';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import { acquireDistributedLock } from '@usecases/common/distributed-lock';
import {
  DAILY_REVIEW_CONVERSATION_KEY,
  DAILY_REVIEW_BIG_OTTER_ID_KEY,
  DAILY_REVIEW_CONVERSATION_TITLE,
  DAILY_REVIEW_TASK_NAME,
  DAILY_REVIEW_CRON,
  DAILY_REVIEW_TIMEZONE,
  DAILY_REVIEW_PROMPT_PATH,
} from '@usecases/daily-review/constants';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRepoRoot } from '@frameworks/repo-root';

export interface DailyReviewConversationResult {
  conversationId: string;
  bigOtterId: string;
}

/** 置顶复盘对话（失败不中断，下次启动恢复——默认体验中日常频次最高的对话，新用户第一眼要看到） */
async function pinDailyReview(manageConversation: ManageConversation, id: string, logger: Logger): Promise<void> {
  try {
    await manageConversation.pin(id);
  } catch (err) {
    logger.warn('Failed to pin daily-review conversation', { conversationId: id, error: err instanceof Error ? err.message : String(err) });
  }
}

async function createDailyReviewConversation(deps: {
  manageConversation: ManageConversation;
  convRepo: ConversationRepository;
  otterRepo: OtterRepository;
  settings: SettingsRepository;
  sendEntry: SendEntry;
  logger: Logger;
}): Promise<DailyReviewConversationResult> {
  const conversation = await deps.manageConversation.create({ title: DAILY_REVIEW_CONVERSATION_TITLE });
  await pinDailyReview(deps.manageConversation, conversation.id, deps.logger);

  // M1 模式：otterRepo 验证 type === 'big'，不依赖参与者顺序
  const participants = await deps.convRepo.getActiveParticipants(conversation.id);
  let bigOtterId: string | undefined;
  for (const p of participants) {
    const otter = await deps.otterRepo.getById(p.otterId);
    if (otter?.type === 'big') { bigOtterId = otter.id; break; }
  }
  if (!bigOtterId) throw new Error('Daily-review conversation created without a big otter participant');

  await deps.settings.update(DAILY_REVIEW_CONVERSATION_KEY, conversation.id);
  await deps.settings.update(DAILY_REVIEW_BIG_OTTER_ID_KEY, bigOtterId);

  await deps.sendEntry.createSystemEntry({
    conversationId: conversation.id,
    turnId: "",
    body: `📖 **每日复盘对话已创建**

这是你的每日工作复盘对话。每天早上 8:30，我会自动回顾昨天的全部对话与工作，在这里给你一份简报：

- **昨天干了什么**：按对话/主题归纳，聊了什么、做了什么决策、产出了什么
- **未闭环事项**：开了头没做完的、待跟进的决策
- **今日建议**：基于未闭环给出当日工作建议

**你可以：**
- 每天早上看简报，掌握自己昨天的工作脉络
- 随时在这里说"复盘一下最近三天"触发手动复盘
- 嫌吵可以在 config.yaml 的 features 段把 dailyReview 设为 false

**注意**：这是工作复盘（回顾你的工作），不是系统体检（那是 Self-Healing 对话的职责）——发现系统问题会在简报末尾提一句，不展开处理。`,
  });

  return { conversationId: conversation.id, bigOtterId };
}

async function tryReuseExisting(
  manageConversation: ManageConversation,
  settings: SettingsRepository,
  logger: Logger,
): Promise<DailyReviewConversationResult | null> {
  const existingId = await settings.get(DAILY_REVIEW_CONVERSATION_KEY);
  if (!existingId) return null;
  const conv = await manageConversation.getById(existingId);
  if (!conv || conv.status !== 'active') return null;
  const bigOtterId = await settings.get(DAILY_REVIEW_BIG_OTTER_ID_KEY);
  if (!bigOtterId) return null;
  await pinDailyReview(manageConversation, existingId, logger);
  return { conversationId: existingId, bigOtterId };
}

export async function ensureDailyReviewConversation(deps: {
  manageConversation: ManageConversation;
  convRepo: ConversationRepository;
  otterRepo: OtterRepository;
  settings: SettingsRepository;
  sendEntry: SendEntry;
  logger: Logger;
}): Promise<DailyReviewConversationResult> {
  const existing = await tryReuseExisting(deps.manageConversation, deps.settings, deps.logger);
  if (existing) return existing;

  const lockResult = await acquireDistributedLock(deps.settings, DAILY_REVIEW_CONVERSATION_KEY, deps.logger);
  if (!lockResult.acquired) {
    const recheck = await tryReuseExisting(deps.manageConversation, deps.settings, deps.logger);
    if (recheck) return recheck;
    throw new Error('Failed to acquire lock for daily-review conversation creation');
  }

  try {
    return await createDailyReviewConversation(deps);
  } catch (err) {
    // 创建失败清 pending 值，让其他进程可立即重试（healing 同款容错）
    const currentValue = await deps.settings.get(DAILY_REVIEW_CONVERSATION_KEY);
    if (currentValue?.startsWith('pending:')) {
      await deps.settings.tryDeleteIfValueMatches(DAILY_REVIEW_CONVERSATION_KEY, currentValue);
      deps.logger.info('Cleaned pending lock after daily-review creation failure', { key: DAILY_REVIEW_CONVERSATION_KEY });
    }
    throw err;
  }
}

/** seed 每日复盘任务（幂等：同名 active 任务存在则跳过） */
export async function ensureDailyReviewScheduler(deps: {
  manageScheduledTask: ManageScheduledTask;
  scheduledTaskRepo: ScheduledTaskRepository;
  dailyReviewConversationId: string;
  bigOtterId: string;
  logger: Logger;
}): Promise<void> {
  const tasks = await deps.scheduledTaskRepo.getByConversationId(deps.dailyReviewConversationId);
  const existing = tasks.find(t => t.name === DAILY_REVIEW_TASK_NAME);
  if (existing && existing.status === 'active') return;

  // fail loud：读不到模板直接 throw（外层 catch 记日志，下次启动重试——paper-trading 同款）
  // Why: prompt 路径基于代码位置解析（#429），cwd 非项目根也能读到
  const promptPath = resolve(getRepoRoot(), DAILY_REVIEW_PROMPT_PATH);
  const promptBody = readFileSync(promptPath, 'utf-8');

  await deps.manageScheduledTask.create({
    conversationId: deps.dailyReviewConversationId,
    name: DAILY_REVIEW_TASK_NAME,
    cron: DAILY_REVIEW_CRON,
    timezone: DAILY_REVIEW_TIMEZONE,
    body: promptBody,
    talkingStonePassedTo: [deps.bigOtterId],
    senderId: 'system',
    restartBeforeInvoke: true, // 每日新 session 防上下文污染
    timeoutMinutes: 30, // 跨对话检索耗时余量（方案 R5 缓解）
  });
  deps.logger.info('Seeded daily-review task', { conversationId: deps.dailyReviewConversationId });
}
