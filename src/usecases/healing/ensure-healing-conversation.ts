import type { ManageConversation } from '@usecases/conversation/manage-conversation';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { OtterRepository } from '@usecases/otter/otter-repository';
import type { Logger } from '@usecases/ports/logger';
import { HEALING_CONVERSATION_KEY, HEALING_BIG_OTTER_ID_KEY } from '@usecases/healing/constants';

const HEALING_CONVERSATION_TITLE = '🩺 Self-Healing';

/** 置顶 healing 对话（失败不中断，记录日志，下次启动恢复） */
async function pinHealing(manageConversation: ManageConversation, id: string, logger: Logger): Promise<void> {
  try {
    await manageConversation.pin(id);
  } catch (err) {
    logger.warn('Failed to pin healing conversation', { error: err instanceof Error ? err.message : String(err) });
  }
}

export interface HealingConversationResult {
  conversationId: string;
  bigOtterId: string;
}

/** 尝试复用已有的 healing 对话（TOCTOU 防护：每次创建前都调用） */
async function tryReuseExisting(
  manageConversation: ManageConversation,
  settings: SettingsRepository,
  logger: Logger,
): Promise<HealingConversationResult | null> {
  const existingId = await settings.get(HEALING_CONVERSATION_KEY);
  if (!existingId) return null;
  const conv = await manageConversation.getById(existingId);
  if (!conv || conv.status !== 'active') return null;
  const bigOtterId = await settings.get(HEALING_BIG_OTTER_ID_KEY);
  if (!bigOtterId) return null;
  await pinHealing(manageConversation, existingId, logger);
  return { conversationId: existingId, bigOtterId };
}

export async function ensureHealingConversation(deps: {
  manageConversation: ManageConversation;
  convRepo: ConversationRepository;
  otterRepo: OtterRepository;
  settings: SettingsRepository;
  sendMessage: SendMessage;
  logger: Logger;
}): Promise<HealingConversationResult> {
  // 1. 检查已有
  const existing = await tryReuseExisting(deps.manageConversation, deps.settings, deps.logger);
  if (existing) return existing;

  // 2. 二次检查：缩小并发创建的竞态窗口（TOCTOU 防护）
  const recheck = await tryReuseExisting(deps.manageConversation, deps.settings, deps.logger);
  if (recheck) return recheck;

  // 3. 创建新对话
  const conversation = await deps.manageConversation.create({ title: HEALING_CONVERSATION_TITLE });
  await pinHealing(deps.manageConversation, conversation.id, deps.logger);

  // M1: 通过 otterRepo 验证 type === 'big'，不依赖参与者顺序
  const participants = await deps.convRepo.getActiveParticipants(conversation.id);
  let bigOtterId: string | undefined;
  for (const p of participants) {
    const otter = await deps.otterRepo.getById(p.otterId);
    if (otter?.type === 'big') { bigOtterId = otter.id; break; }
  }
  if (!bigOtterId) throw new Error('Self-Healing conversation created without a big otter participant');

  await deps.settings.update(HEALING_CONVERSATION_KEY, conversation.id);
  await deps.settings.update(HEALING_BIG_OTTER_ID_KEY, bigOtterId);

  await deps.sendMessage.sendSystem(conversation.id,
    `🩺 **Self-Healing 对话已创建**

这是系统的自愈对话。系统会自动收集日常使用中发现的问题（如工具报错、检索不准等），并定期在此对话中汇报分析结果。

**你可以：**
- 查看 agent 的分析报告和修复建议
- 对修复建议说"同意"让 agent 执行（术语/记忆类）
- 对修复建议说"驳回"标记为已忽略
- 随时在这里说"分析最近的问题"触发即时分析

**定时分析**：每天上午 10 点自动触发。`
  );

  return { conversationId: conversation.id, bigOtterId };
}
