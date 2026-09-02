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
  async dispatch(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
    injection?: InjectionPayload,
  ): Promise<AgentDispatchResult> {
    try {
      // F20260901sgpv P1：IM 入口换轨——信号路由（消息自带 talkingStonePassedTo 是
      // 唯一目标真相源）。四入口勘测硬约束 1：resolveFirstTurnTargets 读库最新 user
      // 消息定目标在并发时有竞态，隐式查询必须删而非双轨——注入路由器后旧路径不可达。
      // 多模态例外与 web 同理：带注入载荷暂留直连链（载荷在请求内存，信号路由拿不到）
      if (this.deps.signalRouter && !injection) {
        await this.deps.signalRouter.routePendingSignals(conversationId);
        return {};
      }

      const firstTurnTargets = await this.resolveFirstTurnTargets(conversationId);
      if (firstTurnTargets.length === 0) {
        return { error: "无可用的 Otter 参与者" };
      }

      let lastMessageId: string | undefined;

      const result = await this.deps.dispatchChainEngine.executeChain({
        conversationId,
        userMessageContent: this.withDocumentBlock(userMessageContent, injection?.documentBlock),
        senderId,
        initialTargets: firstTurnTargets,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('Agent 派发异常', err instanceof Error ? err : new Error(msg), { conversationId });
      return { error: `Agent 派发失败: ${msg}` };
    }
  }

  /** document 文本块拼接（与 message-controller.withDocumentBlock 同语义：追加在消息文本后） */
  private withDocumentBlock(body: string, documentBlock?: string): string {
    return documentBlock ? `${body}\n\n${documentBlock}` : body;
  }

  /** resolveFirstTurnTargets：读库最新 user 消息的 talkingStonePassedTo 定目标（旧路径，路由器未注入时降级）。
   *  F20260901sgpv P1 已知竞态（四入口勘测硬约束 1）：并发两条 user 消息时可能读到错误目标——
   *  信号路由路径（消息自带目标）不受此影响；旧路径随 P2 链驱动替换一并退役 */
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
