import type { ConversationParticipant } from "@entities/conversation/conversation";
import {
  canJoinConversation,
  canLeaveConversation,
} from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
import { DomainError } from "@entities/errors";
import type { ConversationRepository } from "./conversation-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { OtterConfig, OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import { resolveEffectiveModel } from "@usecases/ports/otter-config-provider";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import { tryCloseTurn, ensureActiveTurn } from "./turn-utils";
import type { EntryRepository } from "./entry-repository";
import type { InvokeRepository } from "./invoke-repository";
import type { Entry } from "@entities/conversation/entry";

export interface ParticipantWithOtter {
  participant: ConversationParticipant;
  otterName: string;
  otterType?: string;
  roleName?: string;
  /** 模型别名（有效模型解析后，恒非空——默认模型回退后也有值） */
  modelAlias?: string;
  /** F20260908efmd: true = 配置未显式指定，跟随默认 */
  modelIsDefault?: boolean;
}

export class ManageParticipant {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly otterRepo: OtterRepository,
    /** F20260913ctlv 批4c：系统消息写入依赖（进场/退场 system entry + turn 关闭判据）——必注入 */
    private readonly entryDeps: { entryRepo: EntryRepository; invokeRepo: InvokeRepository },
    /** 可选：老数据/测试场景无 config 注入时 modelAlias 缺省不返回 */
    private readonly configProvider?: OtterConfigProvider,
    /** F20260908efmd: 可选——用于有效模型解析。未注入时 modelAlias 降级为配置裸值（旧行为） */
    private readonly modelPool?: ModelPoolLike,
  ) {}

  /**
   * Otter 进场：创建参与记录 + 进场系统消息。
   * F20260913ctlv 彻底切换：去掉「必须 open turn」硬校验（invokes 状态机下 turns 不再
   * 长期 open，test11 实测 getActiveTurn 恒 null → create_otter 全挂）；turn 用
   * ensureActiveTurn 兜底创建，系统消息改写 system entry（messages 停写）。
   */
  async join(
    conversationId: string,
    otterId: string,
    systemMessageBody: string,
  ): Promise<{
    participant: ConversationParticipant;
    systemMessage: Message | Entry;
  }> {
    /** 1. UA-10: 无已有参与记录才可进场 */
    const existing = await this.repo.getParticipant(conversationId, otterId);
    if (!canJoinConversation(existing)) {
      throw new DomainError(`Otter ${otterId} already joined conversation ${conversationId}`, "conflict");
    }

    /** 2. turn 锚点：ensureActiveTurn 兜底（无 open turn 时创建）*/
    const turn = await ensureActiveTurn(this.repo, conversationId);

    const now = new Date().toISOString();

    /** 3. 创建参与记录 */
    const participant: ConversationParticipant = {
      id: crypto.randomUUID(),
      conversationId,
      otterId,
      joinedAtTurnId: turn.id,
      joinedAtTurnNumber: turn.turnNumber,
      leftAtTurnId: null,
      leftAtTurnNumber: null,
      status: "active",
      createdAt: now,
      leftAt: null,
      lastReadTurnNumber: turn.turnNumber,
      lastActiveTurnNumber: 0,
    };
    await this.repo.createParticipant(participant);

    /** 4. 进场系统消息：新路径 system entry / 旧路径降级 messages */
    const systemMessage = await this.writeSystemRecord(conversationId, turn.id, otterId, systemMessageBody, now);

    /** 5. 更新已读位置到当前 turn（小獭能看到整个 turn 的所有消息） */
    await this.repo.updateLastReadTurnNumber(conversationId, otterId, turn.turnNumber);

    /** 6. 尝试关闭 Turn（system entry 已终态；invoke 状态机判据） */
    await this.closeTurnAfterRecord(turn.id);

    return { participant, systemMessage };
  }

  /** F20260913ctlv：进场/退场系统消息写入——entry 新路径 + messages 降级路径 */
  private async writeSystemRecord(
    conversationId: string,
    turnId: string,
    otterId: string,
    body: string,
    now: string,
  ): Promise<Entry> {
    // F20260913ctlv 批4c：messages 降级路径删除（entryDeps 必注入——装配唯一路径）
    const entry: Entry = {
        id: crypto.randomUUID(),
        conversationId,
        sequenceNum: 0, // 原子分配（createEntryAtomic 忽略入参）
        entryType: "system",
        senderType: "system",
        senderId: otterId,
        body,
        invokeId: null,
        yieldTargets: null,
        turnId,
        status: "completed",
        source: null,
        metadata: null,
        senderName: "system",
        contextTokens: null,
        contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };
    return this.entryDeps.entryRepo.createEntryAtomic(entry);
  }


  /** F20260913ctlv 批4a：turn 关闭（invokes 判据；messages 降级分支已删） */
  private async closeTurnAfterRecord(turnId: string): Promise<void> {
    await tryCloseTurn(this.repo, turnId, this.entryDeps);
  }

  /**
   * Otter 退场：更新参与记录 + 系统消息。
   * 前置条件：当前有活跃 Turn。
   */
  /**
   * Otter 退场：更新参与记录 + 退场系统消息。
   * F20260913ctlv 彻底切换：与 join 同款去 open-turn 硬校验（ensureActiveTurn 兜底）+
   * 系统消息改 system entry。生产调用方已退役（clients.ts 走 markLeft），保留供测试/
   * 未来场景使用。
   */
  async leave(
    conversationId: string,
    otterId: string,
    systemMessageBody: string,
  ): Promise<{
    participant: ConversationParticipant;
    systemMessage: Message | Entry;
  }> {
    /** 1. 当前状态为 active 才可退场 */
    const participant = await this.repo.getParticipant(conversationId, otterId);
    if (!participant || !canLeaveConversation(participant)) {
      throw new DomainError(`Otter ${otterId} is not an active participant`, "validation");
    }

    /** 2. turn 锚点：ensureActiveTurn 兜底 */
    const turn = await ensureActiveTurn(this.repo, conversationId);

    const now = new Date().toISOString();

    /** 3. 更新参与记录（B19: 记录退场 Turn） */
    await this.repo.updateParticipantLeave(
      participant.id,
      turn.id,
      turn.turnNumber,
      now,
    );

    /** 4. 退场系统消息：新路径 system entry / 旧路径降级 messages */
    const systemMessage = await this.writeSystemRecord(conversationId, turn.id, otterId, systemMessageBody, now);

    /** 5. 尝试关闭 Turn */
    await this.closeTurnAfterRecord(turn.id);

    return {
      participant: {
        ...participant,
        leftAtTurnId: turn.id,
        leftAtTurnNumber: turn.turnNumber,
        status: "left",
        leftAt: now,
      },
      systemMessage,
    };
  }

  /**
   * 标记 otter 在对话中已离开（F20260803trrf: dissolve_otter 顺带修）。
   * 与 leave() 的区别：不要求 active turn、不创建系统消息--仅更新 participant status。
   * 用于 dissolve 场景（otter 被解散时，可能无 active turn）。
   */
  async markLeft(conversationId: string, otterId: string): Promise<void> {
    await this.repo.markParticipantLeft(conversationId, otterId);
  }

  /** 获取当前在场的所有 Otter（UA-7） */
  // eslint-disable-next-line complexity -- F20260908efmd: 有效模型解析分支增加（configProvider + modelPool 可选组合）
  async getActiveParticipants(
    conversationId: string,
  ): Promise<ParticipantWithOtter[]> {
    const participants = await this.repo.getActiveParticipants(conversationId);
    // #446: 批量预取消除循环内 N+1——otterRepo.getById + configProvider.getConfig 原本每参与者各一次 DB 查询
    const ottersById = await this.otterRepo.getByIds(participants.map(p => p.otterId));
    const configsByOtterId = this.configProvider
      ? this.configProvider.getConfigs(participants.map(p => p.otterId))
      : new Map<string, OtterConfig>();
    const result: ParticipantWithOtter[] = [];
    for (const participant of participants) {
      const otter = ottersById.get(participant.otterId);
      const otterName = otter?.name ?? `Otter ${participant.otterId.slice(0, 8)}`;
      const config = configsByOtterId.get(participant.otterId);
      // F20260908efmd: 有效模型解析——空配置回退默认并标注
      if (this.configProvider && this.modelPool) {
        const effective = resolveEffectiveModel(config, this.modelPool);
        result.push({ participant, otterName, otterType: otter?.type, roleName: otter?.role?.name, modelAlias: effective.alias, modelIsDefault: effective.isDefault });
      } else {
        // 降级：旧行为（configProvider/modelPool 未注入）
        const modelAlias = config?.modelAlias;
        result.push({ participant, otterName, otterType: otter?.type, roleName: otter?.role?.name, modelAlias });
      }
    }
    return result;
  }

}
