/**
 * PR5: ensure paper-trading 定时任务（幂等）
 *
 * 仿 healing 先例：ensure 真实 conversation + bigOtterId → seed 定时任务。
 * conversationId/talkingStonePassedTo 填真实 id，不使用幽灵 'system'。
 */

import type { ManageConversation } from '@usecases/conversation/manage-conversation';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { OtterRepository } from '@usecases/otter/otter-repository';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { Logger } from '@usecases/ports/logger';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAPER_TRADING_CONVERSATION_KEY = 'paper-trading-conversation-id';
const PAPER_TRADING_BIG_OTTER_ID_KEY = 'paper-trading-big-otter-id';

const TASK_NAMES = {
  matchOrders: 'paper-trading-match-orders',
  dailyTrading: 'paper-trading-daily-trading',
} as const;

/** ensure paper-trading 对话（幂等）——创建真实 conversation 满足 FK */
async function ensurePaperTradingConversation(deps: {
  manageConversation: ManageConversation;
  convRepo: ConversationRepository;
  otterRepo: OtterRepository;
  settings: SettingsRepository;
  logger: Logger;
}): Promise<{ conversationId: string; bigOtterId: string }> {
  // 1. 检查 settings 缓存
  const existingId = await deps.settings.get(PAPER_TRADING_CONVERSATION_KEY);
  if (existingId) {
    const conv = await deps.manageConversation.getById(existingId);
    const bigOtterId = await deps.settings.get(PAPER_TRADING_BIG_OTTER_ID_KEY);
    if (conv && conv.status === 'active' && bigOtterId) {
      return { conversationId: existingId, bigOtterId };
    }
  }

  // 2. 创建新对话（manageConversation.create 自动创建 big otter 并加入参与者）
  const conversation = await deps.manageConversation.create({ title: '📈 纸面交易' });

  // 3. 从参与者中找到 bigOtterId
  const participants = await deps.convRepo.getActiveParticipants(conversation.id);
  let bigOtterId: string | undefined;
  for (const p of participants) {
    const otter = await deps.otterRepo.getById(p.otterId);
    if (otter?.type === 'big') { bigOtterId = otter.id; break; }
  }
  if (!bigOtterId) throw new Error('Paper-trading conversation created without a big otter participant');

  // 4. 存 settings（幂等）
  await deps.settings.update(PAPER_TRADING_CONVERSATION_KEY, conversation.id);
  await deps.settings.update(PAPER_TRADING_BIG_OTTER_ID_KEY, bigOtterId);
  deps.logger.info('Ensured paper-trading conversation', { conversationId: conversation.id, bigOtterId });

  return { conversationId: conversation.id, bigOtterId };
}

/** PR5: seed 纸面交易定时任务（幂等） */
export async function seedPaperTradingTasks(deps: {
  manageScheduledTask: ManageScheduledTask;
  manageConversation: ManageConversation;
  convRepo: ConversationRepository;
  otterRepo: OtterRepository;
  settings: SettingsRepository;
  logger: Logger;
}): Promise<void> {
  const { manageScheduledTask, logger } = deps;

  try {
    // 1. ensure 真实 conversation + bigOtterId（FK 安全）
    const { conversationId, bigOtterId } = await ensurePaperTradingConversation(deps);

    // 2. 检查已有任务（用真实 conversationId 查询）
    const existingTasks = await manageScheduledTask.getByConversationId(conversationId);
    const existingNames = new Set(existingTasks.map(t => t.name));

    // 3. 15:05 撮合任务（function executor）
    if (!existingNames.has(TASK_NAMES.matchOrders)) {
      await manageScheduledTask.create({
        conversationId,
        name: TASK_NAMES.matchOrders,
        scheduleType: 'cron',
        cron: '5 15 * * 1-5', // 工作日 15:05
        timezone: 'Asia/Shanghai',
        body: '{}', // 撮合函数参数：accountId/tradeDate 缺省时自动取值（见 register-functions.ts）
        talkingStonePassedTo: [bigOtterId], // FK 要求非空，function executor 不实际使用
        executorType: 'function',
        functionName: 'match_orders',
        restartBeforeInvoke: false,
      });
      logger.info('Seeded paper-trading-match-orders task', { conversationId });
    }

    // 4. 15:30 操盘獭任务（agent executor）
    if (!existingNames.has(TASK_NAMES.dailyTrading)) {
      // fail loud：读不到文件直接 throw（外层 catch 记日志，下次启动重试）
      const promptPath = resolve(process.cwd(), 'prompts/scheduled/paper-trading-daily.md');
      const promptBody = readFileSync(promptPath, 'utf-8');

      // PR5: 自选池管理——存定时任务 body，搭档维护+AI 提议确认
      const initialWatchlist = ['600519', '000001', '300750'];
      const taskBody = JSON.stringify({
        prompt: promptBody,
        watchlist: initialWatchlist,
      });

      await manageScheduledTask.create({
        conversationId,
        name: TASK_NAMES.dailyTrading,
        scheduleType: 'cron',
        cron: '30 15 * * 1-5', // 工作日 15:30
        timezone: 'Asia/Shanghai',
        body: taskBody,
        talkingStonePassedTo: [bigOtterId], // F20260829ppta 发现 3 修复：指向真实大獭
        executorType: 'agent',
        restartBeforeInvoke: true, // 每日新 session 防上下文污染
      });
      logger.info('Seeded paper-trading-daily-trading task', { conversationId, bigOtterId, watchlist: initialWatchlist });
    }
  } catch (err) {
    logger.error('Failed to seed paper-trading tasks', err instanceof Error ? err : new Error(String(err)));
  }
}
