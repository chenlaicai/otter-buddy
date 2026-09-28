import type { Conversation } from "@entities/conversation/conversation";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { Logger } from "@usecases/ports/logger";

/**
 * F20260924wast：web 助理开户（全局唯一 kind=web-assistant 对话）。
 *
 * 语义（T2b/N2/N3）：
 * - web 助理 = 全局唯一对话（与 IM 助理零关联），首唤时由前端经 POST /api/conversations
 *   {kind:'web-assistant'} 触发创建——controller 层调本模块完成幂等收敛
 * - 人设 systemPrompt 创建时后端注入（前端只传 kind，不传 prompt）：
 *   IM 助理同款「构建一次全链共用」模式适配 web 场景
 * - 幂等（N3）：创建前按 kind=web-assistant 查询，多条并发残留时取最早创建的
 *   一条（并发收敛——双 tab 同 tick 首唤的极端 race 产生的多条以第一条为准）
 *
 * 不动 ManageConversation.create（避免通用 API 看到特化人设字段——recruiting 同款
 * 编排模式）：createOtter（带 systemPrompt）→ repo.create + createParticipants。
 */

/** web 助理固定标题（首唤自动开户，无用户输入） */
export const WEB_ASSISTANT_TITLE = "web 助理";

/** web 助理人设（IM 助理同款模板语义适配 web：全局随问、session 超时自动重置） */
export const WEB_ASSISTANT_SYSTEM_PROMPT = `你是 web 助理——搭档在 web 端的常驻随问助手。

## 定位
- 搭档日常随口问小问题用的全局入口：快速问答、查一下、算一下、帮我想想
- 回答要直接、简洁——能一句话说清的绝不铺陈；需要展开时分点但保持紧凑
- 这里不是任务型对话：深度工作该去正式对话里做，必要时提醒搭档「这个问题开个对话做更合适」

## 会话语义
- 你的 session 在静默 8 小时后自动重置（重启獭生，交接摘要自动沉淀）——跨天的连续感由记忆承载
- 用户隔天回来时不用重新自我介绍，自然接住话题即可；记忆检索是你的连续性锚

## 行为边界
- 使用中文与搭档交流
- 不确定就说不确定，不编造；需要检索记忆/文档时先查再说
- 你只在被问到时出现（浮动獭形态的召唤式交互），不主动发起长篇输出`;

export interface WebAssistantConversationResult {
  conversationId: string;
  /** true = 本次新建；false = 已存在直接复用 */
  created: boolean;
}

export class WebAssistantProvisioner {
  constructor(
    private readonly deps: {
      conversationRepo: Pick<ConversationRepository, "listConversationsWithMeta" | "create" | "createParticipants">;
      createOtter: CreateOtter;
      /** 8h session 重启的模型配置（共用 im.assistant.modelAlias，对话实例各自独立） */
      modelAlias?: string;
      logger: Logger;
    },
  ) {}

  /** 幂等获取/创建 web 助理对话（并发收敛：多条时取最早创建） */
  async ensure(): Promise<WebAssistantConversationResult> {
    const existing = await this.findExisting();
    if (existing) return { conversationId: existing.id, created: false };

    // 创建路径（recruiting 同款编排：createOtter 带 systemPrompt → 单事务建对话+参与者）
    const bigOtter = await this.deps.createOtter.execute({
      name: "大獭",
      type: "big",
      systemPrompt: WEB_ASSISTANT_SYSTEM_PROMPT,
      ...(this.deps.modelAlias && { modelAlias: this.deps.modelAlias }),
    });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      title: WEB_ASSISTANT_TITLE,
      status: "active",
      summary: null,
      pinned: false,
      kind: "web-assistant",
      workspaceDir: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
    };
    await this.deps.conversationRepo.create(conversation, [bigOtter.id]);
    await this.deps.conversationRepo.createParticipants([
      {
        id: crypto.randomUUID(),
        conversationId: id,
        otterId: bigOtter.id,
        status: "active",
        createdAt: now,
        leftAt: null,
      },
    ]);
    this.deps.logger.info("Web assistant conversation provisioned", { conversationId: id, otterId: bigOtter.id });
    return { conversationId: id, created: true };
  }

  /** 按 kind=web-assistant 查询已有对话；多条（并发残留）取最早创建 */
  private async findExisting(): Promise<{ id: string } | null> {
    const { items } = await this.deps.conversationRepo.listConversationsWithMeta("web-user", {
      kind: "web-assistant",
      limit: 10,
    });
    const active = items.filter(c => c.status === "active");
    if (active.length === 0) return null;
    if (active.length > 1) {
      // 并发收敛（N3）：取最早创建的一条；多余的残留记 warn 供诊断（不自动归档——
      // 归档是副作用，留给搭档手动处理更安全）
      this.deps.logger.warn("Multiple web-assistant conversations found (concurrent provision residue), using earliest", {
        count: active.length,
        usingId: active[0].id,
      });
    }
    return { id: active[0].id };
  }
}
