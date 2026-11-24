import { createHash } from "node:crypto";
import type { Entry } from "@entities/conversation/entry";
import type { AttachmentRef } from "@entities/conversation/attachment";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";
import { redactSecrets } from "@usecases/security/redact-secrets";
import { buildUserIndexBody } from "@usecases/conversation/send-entry-index-helpers";
import type { MemoryEntryInput } from "./store-memory";

/** 独立政策版本：旧 entry_memory_index_backfilled=done 不代表本政策已执行。 */
export const ENTRY_MEMORY_POLICY_VERSION = "c2-entry-projection-v1";

export interface EntryProjectionInput {
  entry: Entry;
  conversationKind: "normal" | "external";
  /** invoke.metadata.externalProfile=restricted 的领域事实；不能只看历史 source。 */
  externalSpeak: boolean;
  /** user 按发送 intent 传入；迁移使用已绑定附件的同一投影格式。 */
  attachments: AttachmentRef[];
}

export type ProjectionDecision =
  | { kind: "skip"; reason: "external" | "unsupported-type" | "empty"; policyVersion: string }
  | { kind: "project"; value: MemoryEntryInput; contentHash: string; policyVersion: string };

export function hashEntryProjectionContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * entries → memory 的唯一业务政策。
 * 顺序固定：类型/external 准入 → 卡片剥离与附件投影 → secrets 脱敏 → hash。
 * external 在脱敏和 hash 前返回，避免为其生成 embedding 或审计正文指纹。
 */
export function decideEntryProjection(input: EntryProjectionInput): ProjectionDecision {
  const { entry } = input;
  if (entry.entryType !== "user" && entry.entryType !== "speak") {
    return { kind: "skip", reason: "unsupported-type", policyVersion: ENTRY_MEMORY_POLICY_VERSION };
  }
  if (input.conversationKind === "external" || entry.source === "external" || input.externalSpeak) {
    return { kind: "skip", reason: "external", policyVersion: ENTRY_MEMORY_POLICY_VERSION };
  }

  const body = entry.body ?? "";
  const projected = entry.entryType === "user"
    ? buildUserIndexBody(body, input.attachments)
    : stripHtmlCardFences(body);
  const content = redactSecrets(projected);
  if (content.trim().length === 0) {
    return { kind: "skip", reason: "empty", policyVersion: ENTRY_MEMORY_POLICY_VERSION };
  }

  return {
    kind: "project",
    value: {
      layer: "working",
      contentType: "message",
      sourceId: entry.id,
      sourceTable: "entries",
      conversationId: entry.conversationId,
      granularity: "fine",
      content,
    },
    contentHash: hashEntryProjectionContent(content),
    policyVersion: ENTRY_MEMORY_POLICY_VERSION,
  };
}
