import type { Context } from "hono";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ManageParticipant } from "@usecases/conversation/manage-participant";
import type { CreateConversationInput } from "@usecases/conversation/manage-conversation";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { Logger } from "@usecases/ports/logger";
import { HEALING_CONVERSATION_KEY } from "@usecases/healing/constants";
import { handleError, param } from "../http-error";
import { safeJsonBody } from "../parse-json-body";
import {
  toConversationDTO,
  toConversationListItemDTO,
  toParticipantDTO,
} from "../dto/conversation-dto";
import type { CreateConversationRequestDTO } from "../dto/conversation-dto";
import { DomainError } from "@entities/errors";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import type { ListConversationsFilter } from "@usecases/conversation/conversation-repository";

/**
 * 解析 GET /api/conversations 的过滤参数（F20260922cgrp：status/kind 过滤——三分组分页数据源）。
 * 非法 limit/offset 返回错误消息字符串（400）；非法 status/kind 静默忽略（缺省行为兜底）。
 */
function parseListFilter(c: Context): ListConversationsFilter | string {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  if (isNaN(limit) || isNaN(offset) || limit < 0 || offset < 0) {
    return "Invalid pagination parameters";
  }
  /** search：对话标题关键字过滤（LIKE 子串匹配，仓储层转义通配符） */
  const search = c.req.query("search") || undefined;
  const statusRaw = c.req.query("status");
  const status = statusRaw === "active" || statusRaw === "archived" ? statusRaw : undefined;
  const kindRaw = c.req.query("kind");
  const kind = kindRaw === "assistant" || kindRaw === "normal" ? kindRaw : undefined;
  return { limit, offset, search, status, kind };
}

export class ConversationController {
  constructor(
    private readonly manageConversation: ManageConversation,
    private readonly manageParticipant: ManageParticipant,
    private readonly settings: SettingsRepository,
    private readonly logger: Logger,
    /** 新建对话选大獭模型：modelAlias 校验（otter-controller 同层先例）。
     *  可选注入保持测试兼容；未注入时跳过校验，usecase 层缺省走默认模型 */
    private readonly modelPool?: ModelPoolLike,
  ) {}

  async list(c: Context): Promise<Response> {
    try {
      const filter = parseListFilter(c);
      if (typeof filter === "string") {
        return c.json({ error: filter }, 400);
      }
      /** 批量 JOIN 查询（含未读计数 + last_message），替代 N+1 */
      const userId = c.req.query("userId") ?? "web-user";
      const { items, total } = await this.manageConversation.listWithMeta(userId, filter);
      return c.json({
        items: items.map((item) => toConversationListItemDTO(
          item,
          item.otterIds,
          {
            unreadCount: item.unreadCount,
            lastMessagePreview: item.lastMessagePreview,
            lastMessageTs: item.lastMessageTs,
            activityStatus: item.activityStatus,
          },
        )),
        total,
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async create(c: Context): Promise<Response> {
    try {
      const body = await safeJsonBody<CreateConversationRequestDTO>(c);
      /** 新建对话选大獭模型：与 otter-controller.create 同款校验（400 附可用列表）。
       *  未注入 modelPool 时跳过校验（测试/降级场景） */
      if (this.modelPool && body.modelAlias && !this.modelPool.hasModel(body.modelAlias)) {
        const available = this.modelPool.describeModels().map(m => m.alias).join(", ");
        throw new DomainError(
          `[错误] 未知的模型别名「${body.modelAlias}」。可用模型：${available}`,
          "validation",
        );
      }
      const input: CreateConversationInput = {
        title: body.title,
        modelAlias: body.modelAlias,
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
      return c.json(participantsWithOtter.map(({ participant, otterName, otterType, otterColor, roleName, modelAlias, modelIsDefault }) =>
        toParticipantDTO(participant, otterName, { otterType, otterColor, roleName, modelAlias, modelIsDefault })
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
