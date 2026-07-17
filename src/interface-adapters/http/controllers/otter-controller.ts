import type { Context } from "hono";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { CreateOtterInput } from "@usecases/otter/create-otter";
import { handleError, param } from "../http-error";
import { toOtterDTO, toOtterSessionDTO } from "../dto/otter-dto";
import type { CreateOtterRequestDTO } from "../dto/otter-dto";
import type { OtterPromptConfig } from "@contract/api/otter";

function validateReminder(r: unknown, index: number): string | null {
  if (!r || typeof r !== "object") {
    return `systemPrompt.reminders[${index}] must be an object`;
  }
  const rec = r as Record<string, unknown>;
  if (typeof rec.content !== "string") {
    return `systemPrompt.reminders[${index}].content must be a string`;
  }
  if (rec.priority !== undefined && !["low", "medium", "high"].includes(rec.priority as string)) {
    return `systemPrompt.reminders[${index}].priority must be 'low', 'medium', or 'high'`;
  }
  return null;
}

function validateOtterPromptConfig(value: unknown): string | null {
  if (typeof value === "string") return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "systemPrompt must be a string or OtterPromptConfig object";
  }
  const config = value as Record<string, unknown>;
  if (config.systemPrompt !== undefined && typeof config.systemPrompt !== "string") {
    return "systemPrompt.systemPrompt must be a string";
  }
  if (config.reminders !== undefined) {
    if (!Array.isArray(config.reminders)) {
      return "systemPrompt.reminders must be an array";
    }
    for (let i = 0; i < config.reminders.length; i++) {
      const err = validateReminder(config.reminders[i], i);
      if (err) return err;
    }
  }
  return null;
}

export class OtterController {
  constructor(
    private readonly createOtterUseCase: CreateOtter,
    private readonly dissolveOtterUseCase: DissolveOtter,
    private readonly manageSession: ManageSession,
    private readonly queryOtter: QueryOtter,
  ) {}

  async getBigOtter(c: Context): Promise<Response> {
    try {
      const otter = await this.queryOtter.getBigOtter();
      return c.json(toOtterDTO(otter));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const otter = await this.queryOtter.getById(id);
      if (!otter) {
        return c.json({ error: "Otter not found" }, 404);
      }
      return c.json(toOtterDTO(otter));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async create(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<CreateOtterRequestDTO>();
      if (body.systemPrompt !== undefined) {
        const validationError = validateOtterPromptConfig(body.systemPrompt);
        if (validationError) {
          return c.json({ error: validationError }, 400);
        }
      }
      const input: CreateOtterInput = {
        name: body.name,
        type: body.type,
        role: body.role,
        parentOtterId: body.parentOtterId,
        systemPrompt: body.systemPrompt as string | OtterPromptConfig | undefined,
        context: body.context,
      };
      const otter = await this.createOtterUseCase.execute(input);
      return c.json(toOtterDTO(otter), 201);
    } catch (err) {
      return handleError(c, err);
    }
  }

  async dissolve(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const body: { summary?: string } = await c.req.json().catch(() => ({}));
      await this.dissolveOtterUseCase.execute(id, body.summary);
      return c.json({ status: "dissolved" });
    } catch (err) {
      return handleError(c, err);
    }
  }

  async getSessionHistory(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const sessions = await this.manageSession.getSessionHistory(id);
      return c.json(sessions.map(toOtterSessionDTO));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async createSession(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const session = await this.manageSession.createSession(id);
      return c.json(toOtterSessionDTO(session), 201);
    } catch (err) {
      return handleError(c, err);
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
      const session = await this.manageSession.createSession(id);
      return c.json(toOtterSessionDTO(session), 201);
    } catch (err) {
      return handleError(c, err);
    }
  }
}
