import type { Context } from "hono";
import { DomainError } from "@entities/errors";
import type { OtterSession } from "@entities/otter/otter-session";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { CreateOtterInput } from "@usecases/otter/create-otter";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";
import { toOtterDTO, toOtterSessionDTO } from "../dto/otter-dto";
import type { CreateOtterRequestDTO } from "../dto/otter-dto";

export class OtterController {
  constructor(

    private readonly createOtterUseCase: CreateOtter,
    private readonly dissolveOtterUseCase: DissolveOtter,
    private readonly manageSession: ManageSession,
    private readonly queryOtter: QueryOtter,
      private readonly logger: Logger,
  ) {}

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const otter = await this.queryOtter.getById(id);
      if (!otter) {
        return c.json({ error: "Otter not found" }, 404);
      }
      return c.json(toOtterDTO(otter));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async create(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<CreateOtterRequestDTO>();
      const input: CreateOtterInput = {
        name: body.name,
        type: body.type,
        role: body.role,
        parentOtterId: body.parentOtterId,
        systemPrompt: body.systemPrompt,
        context: body.context,
      };
      const otter = await this.createOtterUseCase.execute(input);
      return c.json(toOtterDTO(otter), 201);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async dissolve(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const body: { summary?: string } = await c.req.json().catch(() => ({}));
      await this.dissolveOtterUseCase.execute(id, body.summary);
      return c.json({ status: "dissolved" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async getSessionHistory(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const sessions = await this.manageSession.getSessionHistory(id);
      return c.json(sessions.map(toOtterSessionDTO));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async restart(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const body: { summary?: string } = await c.req.json().catch(() => ({}));
      const active = await this.manageSession.getActiveSession(id);
      if (active) {
        await this.manageSession.archiveSession(active.id, {
          reason: "restart",
          isNegativeCase: false,
          summary: body.summary,
        });
      }
      /** F20260805rsto：前情摘要同时写入新行——buildDynamicContext 只读新 active 行，
       *  只写旧行的话新獭生永远读不到用户填的前情 */
      try {
        const session = await this.manageSession.createSession(id, { summary: body.summary });
        return c.json(toOtterSessionDTO(session), 201);
      } catch (err) {
        const adopted = await this.tryAdoptBackfilledSession(id, body.summary, err);
        if (adopted) {
          return c.json(toOtterSessionDTO(adopted), 201);
        }
        throw err;
      }
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /**
   * F20260805rsto 竞态认领：archive 内 reset 需等 pi 锁（in-flight invoke 可达数分钟），
   * 窗口内新 invoke 的兜底可能已建新行。此时 archive+reset 已真实执行，
   * 撞 conflict 不是用户错误——认领既有新行、补写 summary，按成功处理。
   */
  private async tryAdoptBackfilledSession(
    otterId: string,
    summary: string | undefined,
    err: unknown,
  ): Promise<OtterSession | null> {
    if (!(err instanceof DomainError) || err.kind !== "conflict") {
      return null;
    }
    const adopted = await this.manageSession.getActiveSession(otterId);
    if (!adopted) {
      return null;
    }
    if (summary) {
      await this.manageSession.setSessionSummary(adopted.id, summary);
    }
    this.logger.info("Restart adopted backfilled session", { otterId, sessionId: adopted.id, action: "restart_adopt" });
    return adopted;
  }
}
