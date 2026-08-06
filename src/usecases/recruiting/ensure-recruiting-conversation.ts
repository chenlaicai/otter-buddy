import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Conversation, ConversationParticipant } from '@entities/conversation/conversation';
import { DomainError } from '@entities/errors';
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { OtterRepository } from '@usecases/otter/otter-repository';
import type { CreateOtter } from '@usecases/otter/create-otter';
import type { Logger } from '@usecases/ports/logger';
import { acquireDistributedLock } from '@usecases/common/distributed-lock';
import {
  RECRUITING_CONVERSATION_KEY,
  RECRUITING_BIG_OTTER_ID_KEY,
  RECRUITING_CONVERSATION_TITLE,
  RECRUITING_SYSTEM_PROMPT_PATH,
} from './constants';

export interface RecruitingConversationResult {
  conversationId: string;
  bigOtterId: string;
  /** true = 本次新建；false = 已存在直接复用 */
  created: boolean;
}

/** 已存在的对话是否仍可用（status=active + 有 bigOtterId） */
async function tryReuseExisting(
  settings: SettingsRepository,
  convRepo: ConversationRepository,
): Promise<RecruitingConversationResult | null> {
  const existingId = await settings.get(RECRUITING_CONVERSATION_KEY);
  if (!existingId) return null;
  const conv = await convRepo.getById(existingId);
  if (!conv || conv.status !== 'active') return null;
  const bigOtterId = await settings.get(RECRUITING_BIG_OTTER_ID_KEY);
  if (!bigOtterId) return null;
  return { conversationId: existingId, bigOtterId, created: false };
}

/** 读取 systemPrompt 文件 */
function readSystemPrompt(promptPathOverride: string | undefined): string {
  const promptPath = promptPathOverride
    ?? path.resolve(process.cwd(), RECRUITING_SYSTEM_PROMPT_PATH);
  try {
    return fs.readFileSync(promptPath, 'utf8');
  } catch (err) {
    throw new DomainError(
      `Recruiting system prompt file not found at ${promptPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'not_found',
    );
  }
}

/** 单事务建 conversation + conversation_otters + ConversationParticipant */
async function createConversationAndParticipant(
  convRepo: ConversationRepository,
  bigOtterId: string,
): Promise<string> {
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: conversationId,
    title: RECRUITING_CONVERSATION_TITLE,
    status: 'active',
    summary: null,
    pinned: false,
    workspaceDir: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    archivedAt: null,
  };
  await convRepo.create(conversation, [bigOtterId]);

  const participant: ConversationParticipant = {
    id: crypto.randomUUID(),
    conversationId,
    otterId: bigOtterId,
    joinedAtTurnId: null,
    joinedAtTurnNumber: 0,
    leftAtTurnId: null,
    leftAtTurnNumber: null,
    status: 'active',
    createdAt: now,
    leftAt: null,
    lastReadTurnNumber: 0,
  };
  await convRepo.createParticipants([participant]);
  return conversationId;
}

/** 发欢迎系统消息（仅作为对话起点上下文，不期望大獭回复） */
async function sendWelcomeMessage(
  sendMessage: SendMessage,
  conversationId: string,
): Promise<void> {
  await sendMessage.sendSystem(
    conversationId,
    `💼 **求职助手对话已创建**

这是你的求职助手对话。BOSS 直聘扩展（boss-zhipin-bridge）会把新收到的招聘消息批量转发到这里，你将：
- 按 5 类（寒暄/要简历/面试邀请/拒信/其他）分类
- 起草回复供搭档参考（绝不替搭档发送）
- 把新公司/HR 入库到 memory，便于后续追溯

**定时摘要**：每天 9:07 自动触发，用 search_memory 的 created_after 参数查今日新接触。

**桥接状态**：扩展会把异常（反爬、登录失效等）也推到这里，critical 事件需要你立即通知搭档。

---

## ⚠️ 搭档必读：启用招聘消息接入

**如果你看到这条消息但还没有看到任何 [招聘消息批次·...] 或 [桥接状态·...] 消息进入**——说明你还没配置 Chrome 扩展。按下面步骤来（5 分钟）：

1. otter-buddy 的 \`config/config.yaml\` 加：
   \`\`\`yaml
   inbound:
     recruiting:
       apiKey: "随机长字符串"  # openssl rand -hex 32 生成
   \`\`\`
   保存后重启 otter-buddy
2. Chrome → \`chrome://extensions\` → 开"开发者模式" → "加载已解压的扩展程序" → 选 \`extensions/boss-zhipin-bridge\` 目录
3. 右键扩展图标 → 选项 → 填 otter URL（默认 \`http://localhost:3010/api/inbound/events\`）+ apiKey → 点"测试连接"（应绿）→ "保存配置"
4. 在 Chrome 登录一次 BOSS 直聘（\`https://www.zhipin.com/web/geek/chat\`）
5. 等 alarm 自动触发（最多 35 分钟），或在扩展 options 页点"立即扫描一次"

**注意**：首次扫描只设置水位线（记录当前消息位置），**不推送任何历史消息**——这是防全量历史推送的设计。第二轮扫描（再等 30-35 分钟）才会推送水位线之后的**新消息**。所以装好扩展后，最快约 60-70 分钟才能看到第一条招聘消息进入本对话。

完整指南见：\`docs/user-guide/recruiting-bridge.md\`

如果搭档问"为什么没消息进来"或"扩展怎么配"，请引用上面步骤。`,
  );
}

/**
 * F20260805rbrg：boot 时幂等创建"💼 求职助手"专用对话。
 *
 * 参考 F20260730heal 的 ensureHealingConversation 并扩展：healing 对话无 systemPrompt，
 * recruiting 需要注入求职助手角色 systemPrompt。
 *
 * **不动 ManageConversation.create**（避免抽象层级泄漏——通用 conversation 创建 API
 * 不应该看到 recruiting 特定的 systemPrompt 字段）。这里自己编排：
 *   1. createOtter.execute({ name, type: 'big', systemPrompt })
 *   2. repo.create(conversation, [bigOtterId]) + repo.createParticipants(...)
 *   3. settings 持久化 conversationId + bigOtterId
 *   4. sendSystem 发欢迎消息
 *
 * systemPrompt 注入路径：createOtter.execute 内部链路会自动通过 otterConfigProvider
 * 持久化到 otter_configs 表。后续 invoke 时 PiSessionFactory 自动读取拼入 prompt。
 * 实现者只需调 createOtter 一行，不需要直接操作 otterConfigProvider。
 */
export async function ensureRecruitingConversation(deps: {
  convRepo: ConversationRepository;
  otterRepo: OtterRepository;
  createOtter: CreateOtter;
  settings: SettingsRepository;
  sendMessage: SendMessage;
  logger: Logger;
  /** 覆盖 prompt 文件路径（测试用） */
  promptPathOverride?: string;
}): Promise<RecruitingConversationResult> {
  // 1. 检查已有
  const existing = await tryReuseExisting(deps.settings, deps.convRepo);
  if (existing) return existing;

  // 2. 获取分布式锁
  const lockResult = await acquireDistributedLock(deps.settings, RECRUITING_CONVERSATION_KEY, deps.logger);
  if (!lockResult.acquired) {
    // 另一个进程已完成，重新检查已有
    const recheck = await tryReuseExisting(deps.settings, deps.convRepo);
    if (recheck) return recheck;
    throw new Error('Failed to acquire lock for Recruiting conversation creation');
  }

  // 3. 创建对话（失败时清理 pending 值，避免阻塞其他进程）
  try {
    // 3.1 读 systemPrompt
    const systemPrompt = readSystemPrompt(deps.promptPathOverride);

    // 3.2 创建带角色 prompt 的大獭
    const bigOtter = await deps.createOtter.execute({
      name: '大獭',
      type: 'big',
      systemPrompt,
    });

    // 3.3 建 conversation + participant
    const conversationId = await createConversationAndParticipant(deps.convRepo, bigOtter.id);

    // 3.4 持久化到 settings
    await deps.settings.update(RECRUITING_CONVERSATION_KEY, conversationId);
    await deps.settings.update(RECRUITING_BIG_OTTER_ID_KEY, bigOtter.id);

    // 3.5 发欢迎消息
    await sendWelcomeMessage(deps.sendMessage, conversationId);

    deps.logger.info('Recruiting conversation created', { conversationId, bigOtterId: bigOtter.id });

    return { conversationId, bigOtterId: bigOtter.id, created: true };
  } catch (err) {
    // 创建失败，清理 pending 值，让其他进程可以立即重试
    const currentValue = await deps.settings.get(RECRUITING_CONVERSATION_KEY);
    if (currentValue?.startsWith('pending:')) {
      await deps.settings.tryDeleteIfValueMatches(RECRUITING_CONVERSATION_KEY, currentValue);
      deps.logger.info('Cleaned pending lock after creation failure', { key: RECRUITING_CONVERSATION_KEY });
    }
    throw err;
  }
}
