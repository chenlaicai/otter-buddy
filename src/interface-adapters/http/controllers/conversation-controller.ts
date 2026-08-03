import type { Context } from "hono";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ManageParticipant } from "@usecases/conversation/manage-participant";
import type { CreateConversationInput } from "@usecases/conversation/manage-conversation";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";
import {
  toConversationDTO,
  toConversationListItemDTO,
  toParticipantDTO,
} from "../dto/conversation-dto";
import type { CreateConversationRequestDTO } from "../dto/conversation-dto";

export class ConversationController {
  constructor(

    private readonly manageConversation: ManageConversation,
    private readonly manageParticipant: ManageParticipant,
      private readonly logger: Logger,
  ) {}

  async list(c: Context): Promise<Response> {
    try {
      const limitStr = c.req.query("limit") ?? "50";
      const offsetStr = c.req.query("offset") ?? "0";
      const limit = parseInt(limitStr, 10);
      const offset = parseInt(offsetStr, 10);
      if (isNaN(limit) || isNaN(offset) || limit < 0 || offset < 0) {
        return c.json({ error: "Invalid pagination parameters" }, 400);
      }
      /** 批量 JOIN 查询（含未读计数 + last_message），替代 N+1 */
      const userId = c.req.query("userId") ?? "web-user";
      const items = await this.manageConversation.listWithMeta(userId, { limit, offset });
      return c.json(items.map((item) => toConversationListItemDTO(
        item,
        item.otterIds,
        {
          unreadCount: item.unreadCount,
          lastMessagePreview: item.lastMessagePreview,
          lastMessageTs: item.lastMessageTs,
        },
      )));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async create(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<CreateConversationRequestDTO>();
      const input: CreateConversationInput = {
        title: body.title,
      };
      const conv = await this.manageConversation.create(input);
      const participantsWithOtter = await this.manageParticipant.getActiveParticipants(conv.id);
      const otterIds = participantsWithOtter.map((p) => p.participant.otterId);
      return c.json(toConversationListItemDTO(conv, otterIds), 201);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const conv = await this.manageConversation.getById(id);
      if (!conv) {
        return c.json({ error: "Conversation not found" }, 404);
      }
      return c.json(toConversationDTO(conv));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async complete(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      await this.manageConversation.complete(id);
      return c.json({ status: "completed" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async archive(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      await this.manageConversation.archive(id);
      return c.json({ status: "archived" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async getParticipants(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const participantsWithOtter = await this.manageParticipant.getActiveParticipants(id);
      return c.json(participantsWithOtter.map(({ participant, otterName, otterType, roleName }) =>
        toParticipantDTO(participant, otterName, { otterType, roleName })
      ));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
