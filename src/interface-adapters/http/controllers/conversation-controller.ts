import type { Context } from "hono";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ManageParticipant } from "@usecases/conversation/manage-participant";
import type { CreateConversationInput } from "@usecases/conversation/manage-conversation";
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
      const ids = await this.manageConversation.getAllIds({ limit, offset });
      const items = await Promise.all(
        ids.map(async (id) => {
          const conv = await this.manageConversation.getById(id);
          if (!conv) return null;
          const participantsWithOtter = await this.manageParticipant.getActiveParticipants(id);
          const otterIds = participantsWithOtter.map((p) => p.participant.otterId);
          return toConversationListItemDTO(conv, otterIds);
        }),
      );
      return c.json(items.filter((x): x is NonNullable<typeof x> => x !== null));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async create(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<CreateConversationRequestDTO>();
      const input: CreateConversationInput = {
        title: body.title,
      };
      const conv = await this.manageConversation.create(input);
      return c.json(toConversationDTO(conv), 201);
    } catch (err) {
      return handleError(c, err);
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
      return handleError(c, err);
    }
  }

  async complete(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      await this.manageConversation.complete(id);
      return c.json({ status: "completed" });
    } catch (err) {
      return handleError(c, err);
    }
  }

  async archive(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      await this.manageConversation.archive(id);
      return c.json({ status: "archived" });
    } catch (err) {
      return handleError(c, err);
    }
  }

  async getParticipants(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const participantsWithOtter = await this.manageParticipant.getActiveParticipants(id);
      return c.json(participantsWithOtter.map(({ participant, otterName }) =>
        toParticipantDTO(participant, otterName)
      ));
    } catch (err) {
      return handleError(c, err);
    }
  }
}
