import type { Context } from "hono";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { PlatformPromptGateway } from "@usecases/otter/platform-prompt-gateway";
import { handleError } from "../http-error";
import type { UpdatePlatformPromptRequestDTO } from "@contract/api/platform-prompt";

/** 平台级 system prompt 键名（settings 表） */
const PLATFORM_PROMPT_KEY = "platform_system_prompt";

/** 平台 prompt 最大长度（100KB） */
const MAX_PLATFORM_PROMPT_LENGTH = 100_000;

export class PlatformPromptController {
  constructor(
    private readonly settingsRepo: SettingsRepository,
    private readonly platformPromptGateway: PlatformPromptGateway,
  ) {}

  async get(c: Context): Promise<Response> {
    try {
      const stored = await this.settingsRepo.get(PLATFORM_PROMPT_KEY);
      return c.json({ systemPrompt: stored ?? "" });
    } catch (err) {
      return handleError(c, err);
    }
  }

  async update(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<UpdatePlatformPromptRequestDTO>();
      if (typeof body.systemPrompt !== "string") {
        return c.json({
          error: "systemPrompt must be a string",
          detail: typeof body.systemPrompt === "object"
            ? "Platform prompt only accepts string. OtterPromptConfig objects are for per-Otter config via Otter creation API."
            : `Expected string, got ${typeof body.systemPrompt}`,
        }, 400);
      }
      if (body.systemPrompt.length > MAX_PLATFORM_PROMPT_LENGTH) {
        return c.json({
          error: `systemPrompt exceeds maximum length of ${MAX_PLATFORM_PROMPT_LENGTH} characters`,
        }, 400);
      }
      await this.platformPromptGateway.updatePlatformPrompt(body.systemPrompt);
      return c.json({ systemPrompt: body.systemPrompt });
    } catch (err) {
      return handleError(c, err);
    }
  }
}
