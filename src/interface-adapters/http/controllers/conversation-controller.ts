import type { Context } from "hono";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ManageParticipant } from "@usecases/conversation/manage-participant";
import type { CreateConversationInput } from "@usecases/conversation/manage-conversation";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { Logger } from "@usecases/ports/logger";
import { HEALING_CONVERSATION_KEY } from "@usecases/healing/constants";
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
    private readonly settings: SettingsRepository,
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
          activityStatus: item.activityStatus,
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
      return c.json(participantsWithOtter.map(({ participant, otterName, otterType, roleName, modelAlias }) =>
        toParticipantDTO(participant, otterName, { otterType, roleName, modelAlias })
      ));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async pin(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      await this.manageConversation.pin(id);
      return c.json({ status: "pinned" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async unpin(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      // healing 保护：settings 返回 healing 对话 ID 时拒绝 unpin。
      // settings 为 null（healing 初始化失败）时不拒绝——此时无 healing 对话需要保护。
      const healingId = await this.settings.get(HEALING_CONVERSATION_KEY);
      if (id === healingId) {
        return c.json({ error: "系统对话不可取消置顶" }, 403);
      }
      await this.manageConversation.unpin(id);
      return c.json({ status: "unpinned" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
