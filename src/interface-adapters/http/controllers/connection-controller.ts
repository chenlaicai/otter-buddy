import type { Context } from "hono";
import type { ManageConnection } from "@usecases/im/manage-connection";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";
import {
  toConnectionDTO,
  toConnectionSessionDTO,
  type CreateConnectionRequestDTO,
  type EnterConversationRequestDTO,
} from "../dto/connection-dto";

export class ConnectionController {
  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly logger: Logger,
  ) {}

  async list(c: Context): Promise<Response> {
    try {
      const connections = await this.manageConnection.listConnections();
      return c.json(connections.map(toConnectionDTO));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async create(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<CreateConnectionRequestDTO>();
      const connection = await this.manageConnection.createConnection(body.name, body.externalId);
      return c.json(toConnectionDTO(connection), 201);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

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

  async getSession(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const conversation = await this.manageConnection.getCurrentConversation(id);
      if (!conversation) {
        return c.json({ error: "No active session" }, 404);
      }
      return c.json(conversation);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async enterConversation(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const body = await c.req.json<EnterConversationRequestDTO>();
      const session = await this.manageConnection.enterConversation(id, body.conversationId);
      return c.json(toConnectionSessionDTO(session));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async leaveConversation(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      await this.manageConnection.leaveConversation(id);
      return c.json({ status: "left" });
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
