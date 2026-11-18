/**
 * F20261118belif P1a：主动记忆层（belief）实体。
 *
 * belief = 「现在什么是真的」的蒸馏层，区别于沉淀物（发生过什么，永不变）。
 * 物理形态：memory_entries 之上的分区——content_type 新增 "belief"（不建平行新库），
 * 沿用 FTS+向量+记忆图+supersedes 边。状态机与出处约束见 belief-guard.ts。
 *
 * 本体论（otter-memory-design v4 §1）：belief 分两类——
 * - preference：搭档个人喜好，来源只能是搭档原话（四维校验第 2 条）；
 * - state：agent 推得的当前认识，必须标「推断」并给依据，永不当硬规则用。
 */
import type { MemoryEntry } from "./memory-entry";

/** belief 分类：preference=搭档喜好；state=agent 推断的当前认识 */
export type BeliefKind = "preference" | "state";

/** belief 生命周期状态（otter-memory-design v4 §3.3） */
export type BeliefStatus = "recorded" | "verified" | "disputed" | "superseded";

/** belief 条目 metadata（MemoryEntry.metadata 的契约形态） */
export interface BeliefMetadata {
  kind: BeliefKind;
  status: BeliefStatus;
  /**
   * 出处锚点：记录本 belief 所依据的原始条目 ID（memory_entries 里的 message/fact/document）。
   * 四维校验：非空、ID 真实存在、preference 须搭档原话、属于本会话可引用范围。
   */
  anchors: string[];
  /**
   * state（推断类）必填：推断所依据的条目 ID。四维校验第 4 条「推断也要依据」。
   * preference 可为空（出处就是搭档原话本身，已由 anchors 承载）。
   */
  inferredFrom?: string[];
  /**
   * 即时 supersede（现场纠错）：本 belief 取代的旧 belief 条目 ID。
   * 防环：目标条目 createdAt 必须早于本条目，否则拒（记忆图上不允许 A↔B 互替环）。
   */
  supersedes?: string;
}

/** 运行时校验字符串是否为合法 BeliefKind */
const VALID_KINDS: ReadonlySet<string> = new Set<BeliefKind>(["preference", "state"]);
export function isBeliefKind(s: unknown): s is BeliefKind {
  return typeof s === "string" && VALID_KINDS.has(s);
}

/** 运行时校验字符串是否为合法 BeliefStatus */
const VALID_STATUSES: ReadonlySet<string> = new Set<BeliefStatus>([
  "recorded", "verified", "disputed", "superseded",
]);
export function isBeliefStatus(s: unknown): s is BeliefStatus {
  return typeof s === "string" && VALID_STATUSES.has(s);
}

/** 字符串数组（每项非空）类型守卫 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

/** 必填字段合法（kind/status/anchors 非空） */
function hasValidBase(m: Partial<BeliefMetadata>): boolean {
  return isBeliefKind(m.kind)
    && isBeliefStatus(m.status)
    && isStringArray(m.anchors)
    && m.anchors.length > 0;
}

/** 可选字段合法（inferredFrom 若在则须字符串数组；supersedes 若在则须字符串） */
function hasValidOptionalFields(m: Partial<BeliefMetadata>): boolean {
  if (m.inferredFrom !== undefined && !isStringArray(m.inferredFrom)) return false;
  if (m.supersedes !== undefined && typeof m.supersedes !== "string") return false;
  return true;
}

/** 从 MemoryEntry.metadata 解析 belief 契约（未知/不合法返回 null） */
export function parseBeliefMetadata(entry: Pick<MemoryEntry, "contentType" | "metadata">): BeliefMetadata | null {
  if (entry.contentType !== "belief") return null;
  const m = entry.metadata as Partial<BeliefMetadata> | null;
  if (!m || typeof m !== "object" || !hasValidBase(m) || !hasValidOptionalFields(m)) return null;
  return {
    kind: m.kind as BeliefKind,
    status: m.status as BeliefStatus,
    anchors: m.anchors as string[],
    ...(m.inferredFrom !== undefined ? { inferredFrom: m.inferredFrom } : {}),
    ...(m.supersedes !== undefined ? { supersedes: m.supersedes } : {}),
  };
}
