import { createHash } from "node:crypto";
import type { OtterPromptConfig, SystemReminder } from "@contract/api/otter";
import {
  buildOtterPrompt,
  buildRestrictedExternalSystemPrompt,
  RESTRICTED_EXTERNAL_IDENTITY,
} from "./session-helpers";
import type { PromptAssetSnapshot } from "./prompt-asset-provider";

export interface ExternalTaskConfig {
  instructions?: string;
  reminders?: SystemReminder[];
}

interface PromptScope {
  otterId: string;
  conversationId: string;
  otterType: string;
  externalProfile?: "restricted";
}

export interface InternalPromptComposeInput {
  scope: PromptScope & { externalProfile?: undefined };
  identity: string;
  taskConfig: string | OtterPromptConfig | undefined;
  assets: PromptAssetSnapshot;
  mcpInstructions?: string;
}

export interface RestrictedPromptComposeInput {
  scope: PromptScope & { externalProfile: "restricted" };
  externalTaskConfig?: ExternalTaskConfig;
  publicMcpInstructions?: string;
}

export type PromptComposeInput = InternalPromptComposeInput | RestrictedPromptComposeInput;

export interface ComposedPromptSection {
  kind: "system" | "identity" | "skills" | "task" | "mcp" | "safety";
  revision: string;
  bytes: number;
}

export interface ComposedPrompt {
  text: string;
  revision: string;
  sections: ComposedPromptSection[];
}

function revision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function composeSections(parts: Array<{ kind: ComposedPromptSection["kind"]; text: string | undefined }>): ComposedPrompt {
  const visible = parts.filter((part): part is { kind: ComposedPromptSection["kind"]; text: string } => Boolean(part.text?.trim()));
  const sections = visible.map(part => ({
    kind: part.kind,
    revision: revision(part.text),
    bytes: Buffer.byteLength(part.text, "utf8"),
  }));
  return {
    text: visible.map(part => part.text).join("\n\n"),
    revision: revision(sections.map(section => `${section.kind}:${section.revision}`).join("\n")),
    sections,
  };
}

function isRestricted(input: PromptComposeInput): input is RestrictedPromptComposeInput {
  return input.scope.externalProfile === "restricted";
}

/** The only business-policy renderer consumed by DurableSession. */
export function composePrompt(input: PromptComposeInput): ComposedPrompt {
  if (isRestricted(input)) {
    const task = input.externalTaskConfig
      ? buildOtterPrompt({
          systemPrompt: input.externalTaskConfig.instructions,
          reminders: input.externalTaskConfig.reminders,
        })
      : "";
    return composeSections([
      { kind: "identity", text: RESTRICTED_EXTERNAL_IDENTITY },
      { kind: "task", text: task },
      { kind: "mcp", text: input.publicMcpInstructions },
      // Why: the untrusted-input boundary must be the final instruction so public
      // connector configuration cannot weaken it by appearing later in the prompt.
      { kind: "safety", text: buildRestrictedExternalSystemPrompt("") },
    ]);
  }

  return composeSections([
    { kind: "system", text: input.assets.systemPrompt },
    { kind: "identity", text: input.identity },
    { kind: "skills", text: input.assets.skillsPrompt },
    { kind: "task", text: buildOtterPrompt(input.taskConfig) },
    { kind: "mcp", text: input.mcpInstructions },
  ]);
}
