import type { Context } from "hono";
import type { ManageConnection } from "@usecases/im/manage-connection";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";
import { safeJsonBody } from "../parse-json-body";
import {
  toConnectionDTO,
  toConnectionSessionDTO,
  type EnterConversationRequestDTO,
} from "../dto/connection-dto";

// F20261023cnct（issue #1063）：死端点下线——list/create/getSession/leaveConversation 四个
// HTTP 方法已删（对应 GET/POST /api/connections、GET :id/session、POST :id/leave）。
// usecase ManageConnection 方法全部保留给 IM 命令体系（feishu command-dispatcher.ts /
// weixin message-processor.ts 复用 leaveConversation 等），仅 HTTP 层退役。

export class ConnectionController {
  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly logger: Logger,
  ) {}

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const connection = await this.manageConnection.getConnection(id);
      if (!connection) {
        return c.json({ error: "Connection not found" }, 404);
      }
      return c.json(toConnectionDTO(connection));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async enterConversation(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const body = await safeJsonBody<EnterConversationRequestDTO>(c);
      const session = await this.manageConnection.enterConversation(id, body.conversationId);
      return c.json(toConnectionSessionDTO(session));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async listActiveConversations(c: Context): Promise<Response> {
    try {
      const conversations = await this.manageConnection.listActiveConversations();
      return c.json(conversations);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
