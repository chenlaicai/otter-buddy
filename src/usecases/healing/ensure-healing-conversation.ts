import type { ManageConversation } from '@usecases/conversation/manage-conversation';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { SendMessage } from '@usecases/conversation/send-message';

const HEALING_CONVERSATION_TITLE = '🩺 Self-Healing';
const HEALING_CONVERSATION_KEY = '__self_healing_conversation_id__';
const HEALING_BIG_OTTER_ID_KEY = '__self_healing_big_otter_id__';

export interface HealingConversationResult {
  conversationId: string;
  bigOtterId: string;
}

export async function ensureHealingConversation(deps: {
  manageConversation: ManageConversation;
  convRepo: ConversationRepository;
  settings: SettingsRepository;
  sendMessage: SendMessage;
}): Promise<HealingConversationResult> {
  // 检查是否已有
  const existingId = await deps.settings.get(HEALING_CONVERSATION_KEY);
  if (existingId) {
    const conv = await deps.manageConversation.getById(existingId);
    if (conv && conv.status === 'active') {
      const bigOtterId = await deps.settings.get(HEALING_BIG_OTTER_ID_KEY);
      if (bigOtterId) return { conversationId: existingId, bigOtterId };
    }
  }

  // 创建对话（ManageConversation.create 内部自动创建大獭 + 加入参与者）
  const conversation = await deps.manageConversation.create({
    title: HEALING_CONVERSATION_TITLE,
  });

  // 查询参与者找到大獭 ID
  const participants = await deps.convRepo.getActiveParticipants(conversation.id);
  const bigOtterParticipant = participants.find(p => p.status === 'active');
  if (!bigOtterParticipant) {
    throw new Error('Self-Healing conversation created without a big otter participant');
  }
  const bigOtterId = bigOtterParticipant.otterId;

  // 持久化
  await deps.settings.update(HEALING_CONVERSATION_KEY, conversation.id);
  await deps.settings.update(HEALING_BIG_OTTER_ID_KEY, bigOtterId);

  // 发送首条引导消息
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
