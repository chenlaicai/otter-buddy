import type { Context } from "hono";
import type { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { KeyFactInput, LinkedResourceInput } from "@usecases/conversation/manage-key-info";
import { handleError, param } from "../http-error";
import { toKeyInfoDTO, toKeyFactDTO, toLinkedResourceDTO } from "../dto/key-info-dto";
import type { AddKeyFactRequestDTO, LinkResourceRequestDTO } from "../dto/key-info-dto";

export class KeyInfoController {
  constructor(
    private readonly manageKeyInfo: ManageKeyInfo,
  ) {}

  async getKeyInfo(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const info = await this.manageKeyInfo.getKeyInfo(conversationId);
      return c.json(toKeyInfoDTO(info));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async addKeyFact(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const body = await c.req.json<AddKeyFactRequestDTO>();
      const input: KeyFactInput = {
        conversationId,
        content: body.content,
        category: body.category,
        createdBy: body.createdBy,
        otterId: body.otterId,
      };
      const fact = await this.manageKeyInfo.addKeyFact(input);
      return c.json(toKeyFactDTO(fact), 201);
    } catch (err) {
      return handleError(c, err);
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
        metadata: body.metadata,
        linkedBy: body.linkedBy,
        otterId: body.otterId,
        autoLinked: body.autoLinked,
      };
      const resource = await this.manageKeyInfo.linkResource(input);
      return c.json(toLinkedResourceDTO(resource), 201);
    } catch (err) {
      return handleError(c, err);
    }
  }
}
