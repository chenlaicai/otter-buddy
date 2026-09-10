import type { QueryMessage } from "./query-message";
import type { AgentTurnPort } from "@usecases/ports/agent-turn-port";
import type { InjectionPayload } from "./attachment-injection-service";
import type { Logger } from "@usecases/ports/logger";
import type { DispatchChainEngine } from "./dispatch-chain-engine";
import type { SignalRouter } from "./signal-router";

export interface AgentDispatchResult {
  otterReply?: string;
  messageId?: string;
  error?: string;
}

export class AgentDispatchService {
  constructor(
    private readonly deps: {
      dispatchChainEngine: DispatchChainEngine;
      queryMessage: QueryMessage;
      agentInvokePort: AgentTurnPort;
      logger: Logger;
      /** F20260901sgpv P1：信号路由器（可选注入）——注入后 IM 入口走信号路由，
       *  resolveFirstTurnTargets 隐式查询随之停用（四入口勘测硬约束 1：删，不双轨） */
      signalRouter?: SignalRouter;
    },
  ) {}

  /** 触发 Agent 派发（用于飞书等非 Web 路径；事件通过 AgentInvoker 内部的 broadcastEvent 统一推送）。
   *  多模态 Phase 2：injection 为飞书 ingress 附件的注入载荷（与 Web 路径同一份组装策略）——
   *  documentBlock 拼接在消息文本后（与 message-controller.withDocumentBlock 同语义），
   *  images 走 executeChain 透传到当前任务消息。 */
  async dispatch(input: {
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    injection?: InjectionPayload;
    /** F20260908rlcp：本条触发消息的 ID（feishu/weixin 调用点在消息落库后传入）。只路由本轮触发，不扫历史。 */
    messageId?: string;
    /** F20260910ctlv 彻底切换：entries 解析的目标——传入时直连链点火（IM 入口不再写 messages 信号行，
     *  路由器的 messages 扫描路径对 IM 失效；显式目标直连链是唯一点火路径） */
    resolvedTargets?: string[];
  }): Promise<AgentDispatchResult> {
    const { conversationId, userMessageContent, senderId, injection, messageId, resolvedTargets } = input;
    try {
      // F20260910ctlv 彻底切换：IM 入口带显式目标时直连链（entries 目标）
      if (this.deps.signalRouter && resolvedTargets && resolvedTargets.length > 0) {
        this.fireDirectChain(conversationId, userMessageContent, senderId, resolvedTargets, injection);
        return {};
      }

      // F20260901sgpv P1：IM 入口换轨——信号路由（消息自带 talkingStonePassedTo 是
      // 唯一目标真相源）。四入口勘测硬约束 1：resolveFirstTurnTargets 读库最新 user
      // 消息定目标在并发时有竞态，隐式查询必须删而非双轨——注入路由器后旧路径不可达。
      // #826 多模态收口：带附件消息从此过信号路由器闸门+台账（注入载荷由路由器从 attachments 重建）
      if (this.deps.signalRouter) {
        // F20260908rlcp：IM 入口路由——dispatch 调用点（feishu/weixin message-processor）
        // 传 triggerMessageId 只路由本轮触发消息（不扫历史，防已处理信号重燃）。
        // messageId 缺省（老调用点）时降级为「每目标最新一条」补扫语义。
        await this.deps.signalRouter.routeSignals(conversationId, messageId ? { triggerMessageId: messageId } : undefined);
        return {};
      }

      return this.dispatchLegacyChain(conversationId, userMessageContent, senderId, injection);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('Agent 派发异常', err instanceof Error ? err : new Error(msg), { conversationId });
      return { error: `Agent 派发失败: ${msg}` };
    }
  }

  /** 旧降级路径（路由器未注入时）：读库最新 user 消息定目标——F20260901sgpv P1 已知竞态，随 P2 退役 */
  private async dispatchLegacyChain(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
    injection?: InjectionPayload,
  ): Promise<AgentDispatchResult> {
    const firstTurnTargets = await this.resolveFirstTurnTargets(conversationId);
    if (firstTurnTargets.length === 0) {
      return { error: "无可用的 Otter 参与者" };
    }

    // F20260902sgp2 S1：首 hop 记账用触发消息（与 resolveFirstTurnTargets 同源——
    // 最新 user 消息；旧路径已知竞态下两者至少自洽，目标与消息 ID 来自同一次读取）
    const triggerMessage = await this.deps.queryMessage.getMessages(conversationId, { limit: 1, senderType: "user" });

    let lastMessageId: string | undefined;

    const result = await this.deps.dispatchChainEngine.executeChain({
      conversationId,
      userMessageContent: this.withDocumentBlock(userMessageContent, injection?.documentBlock),
      senderId,
      initialTargets: firstTurnTargets,
      triggerMessageId: triggerMessage[0]?.id,
      ...(injection?.images && { images: injection.images }),
      invokeFn: async (params) => {
        const invokeResult = await this.deps.agentInvokePort.invokeConversation({
          otterId: params.otterId,
          conversationId: params.conversationId,
          userMessageContent: params.userMessageContent,
          senderId: params.senderId,
          ...(params.images && { images: params.images }),
        });
        lastMessageId = invokeResult.messageId;
        return invokeResult;
      },
    });

    return { otterReply: result.otterReply, messageId: lastMessageId };
  }

  /** document 文本块拼接（与 message-controller.withDocumentBlock 同语义：追加在消息文本后） */
  private withDocumentBlock(body: string, documentBlock?: string): string {
    return documentBlock ? `${body}\n\n${documentBlock}` : body;
  }

  /** resolveFirstTurnTargets：读库最新 user 消息的 talkingStonePassedTo 定目标（旧路径，路由器未注入时降级）。
   *  F20260901sgpv P1 已知竞态（四入口勘测硬约束 1）：并发两条 user 消息时可能读到错误目标——
   *  信号路由路径（消息自带目标）不受此影响；旧路径随 P2 链驱动替换一并退役 */
  /** F20260910ctlv：IM 显式目标直连链（fire-and-forget，与 invokeTarget 同款语义） */
  private fireDirectChain(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
    targets: string[],
    injection?: InjectionPayload,
  ): void {
    void (async () => {
      try {
        await this.deps.dispatchChainEngine.executeChain({
          conversationId,
          userMessageContent,
          senderId,
          initialTargets: targets,
          ...(injection?.images && { images: injection.images }),
          invokeFn: (params) => this.deps.agentInvokePort.invokeConversation({
            otterId: params.otterId,
            conversationId: params.conversationId,
            userMessageContent: params.userMessageContent,
            senderId: params.senderId,
            ...(params.images && { images: params.images }),
          }).then(r => ({ messageId: r.messageId })),
        });
      } catch (err) {
        this.deps.logger.error("IM direct dispatch failed", err instanceof Error ? err : new Error(String(err)), {
          conversationId, targets,
        });
      }
    })();
  }

  private async resolveFirstTurnTargets(conversationId: string): Promise<string[]> {
    // 获取最新用户消息的 talkingStonePassedTo
    const messages = await this.deps.queryMessage.getMessages(conversationId, { limit: 1, senderType: "user" });
    if (messages.length === 0) return [];

    const lastUserMsg = messages[0];
    const targets = lastUserMsg.talkingStonePassedTo ?? [];

    this.deps.logger.info('resolveFirstTurnTargets', {
      conversationId,
      messageId: lastUserMsg.id,
      talkingStonePassedTo: targets,
    });

    return targets;
  }
}
