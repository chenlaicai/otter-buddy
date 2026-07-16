import type { Context } from "hono";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { AgentInvoker } from "../../agent-runtime/agent-invoker";
import { handleError, param } from "../http-error";
import { toMessageDTO, toMessageEventDTO } from "../dto/message-dto";
import type { SendMessageRequestDTO } from "../dto/message-dto";
import { streamEvents } from "../sse-streamer";

export class MessageController {
  constructor(
    private readonly sendMessageUseCase: SendMessage,
    private readonly queryMessage: QueryMessage,
    private readonly agentInvoker: AgentInvoker,
  ) {}

  async list(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const limit = Number(c.req.query("limit") ?? "50");
      const before = c.req.query("before");
      const messages = await this.queryMessage.getMessages(conversationId, {
        limit,
        before,
      });
      return c.json(messages.map(toMessageDTO));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async sendMessage(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const body = await c.req.json<SendMessageRequestDTO>();

      /** 1. 创建用户消息（completed 状态） */
      const _userMessage = await this.sendMessageUseCase.send({
        conversationId,
        senderId: body.senderId,
        talkingStonePassedTo: body.talkingStonePassedTo,
        body: body.body,
        attachments: body.attachments,
      });

      /** 2. 确定 Agent Otter（talkingStonePassedTo 的第一个） */
      const otterId = body.talkingStonePassedTo[0];

      /** 3. 创建 SSE 流并启动 Agent 响应 */
      const { response, push } = streamEvents(c, () => {
        this.agentInvoker.abort(otterId, "");
      });

      /** 4. 异步驱动 Agent 对话（不 await） */
      this.agentInvoker.invokeConversation({
        otterId,
        conversationId,
        userMessageContent: body.body,
        senderId: body.senderId,
        onSSEEvent: push,
      }).catch((err) => {
        push({ event: "error", data: { message: err.message } });
      });

      return response;
    } catch (err) {
      return handleError(c, err);
    }
  }

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const msg = await this.queryMessage.getMessageById(id);
      if (!msg) {
        return c.json({ error: "Message not found" }, 404);
      }
      return c.json(toMessageDTO(msg));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async getEvents(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const events = await this.queryMessage.getMessageEvents(id);
      return c.json(events.map(toMessageEventDTO));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async abort(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const msg = await this.queryMessage.getMessageById(id);
      if (!msg) {
        return c.json({ error: "Message not found" }, 404);
      }
      this.agentInvoker.abort(msg.senderId, id);
      return c.json({ status: "aborted" }, 202);
    } catch (err) {
      return handleError(c, err);
    }
  }
}
