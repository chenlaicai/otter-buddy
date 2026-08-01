import type { Context } from "hono";
import type { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { LinkedResourceInput } from "@usecases/conversation/manage-key-info";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";
import { toKeyInfoDTO, toLinkedResourceDTO } from "../dto/key-info-dto";
import type { LinkResourceRequestDTO } from "../dto/key-info-dto";

export class KeyInfoController {
  constructor(

    private readonly manageKeyInfo: ManageKeyInfo,
      private readonly logger: Logger,
  ) {}

  async getKeyResources(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const resources = await this.manageKeyInfo.getLinkedResources(conversationId);
      return c.json(toKeyInfoDTO(resources));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async linkResource(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const body = await c.req.json<LinkResourceRequestDTO>();
      const input: LinkedResourceInput = {
        conversationId,
        resourceType: body.resourceType,
        url: body.url,
        title: body.title,
        content: body.content,
        category: body.category,
        metadata: body.metadata,
        linkedBy: body.linkedBy,
        otterId: body.otterId,
        autoLinked: body.autoLinked,
        groupId: body.groupId,
      };
      const resource = await this.manageKeyInfo.linkResource(input);
      return c.json(toLinkedResourceDTO(resource), 201);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async flagResource(c: Context): Promise<Response> {
    try {
      const resourceId = param(c, "resourceId");
      const body = await c.req.json<{ flagged: boolean }>();
      await this.manageKeyInfo.flagResource(resourceId, body.flagged);
      return c.json({ status: "ok" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async deleteLinkedResource(c: Context): Promise<Response> {
    try {
      const resourceId = param(c, "resourceId");
      await this.manageKeyInfo.deleteLinkedResource(resourceId);
      return c.body(null, 204);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
