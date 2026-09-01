/**
 * 文档状态值域契约（Issue #646，合议定稿 review-lunheng.md §二 / 大獭三项拍板）。
 *
 * 背景：docs/features 的 status 实查值域无权威 schema（8 种已知值 + 行内注释变体 +
 * review/reviewed 等零星值），chain-builder 白名单、classifyDocOnly、feature-doc-collector
 * 三处触点各自硬编码，判定语义随时间漂移。本模块收敛为单一真相源：
 *
 * 契约要点（写死策略）：
 * 1. 已知在途值（IN_FLIGHT）：参与 stalled/zombie/regressed 病态判定
 * 2. 已知终态值（TERMINAL）：视为稳定，豁免病态判定
 * 3. 未知值一律不碰（UNKNOWN）：状态机/推进器/回填跳过并留痕，防覆盖手工语义
 *
 * locked/final 是否终态的定案（#646 实现时裁定，理由见特性文档）：
 * - locked：实查 37 篇全部是 2026-07-08~07-20 初创期设计文档（data-model/infra/domain
 *   设计稿），此后 40+ 天零新增——语义冻结在「设计定稿」，按终态处理
 * - final：语义自明（最终态），终态
 * - reviewed / review：8 月初 2 篇「待对抗审视/delta 复核」文档在用，语义明确在途
 *   （对抗审视是工作流中间环节），收编为在途值
 *
 * 值域与 known-values.ts 的关系：KNOWN_FEATURE_STATUSES 是「文档写作时允许写的值」
 * （validator 层，未知进 warning）；本模块是「健康链判定/推进器消费的语义分组」
 * （判定层）。review/reviewed 待存量文档终态化后可提 add 到 known-values（另案）。
 */

import { KNOWN_FEATURE_STATUSES } from "./known-values";

/** 已知在途值：参与病态判定（stalled/zombie/regressed）。
 *  review/reviewed 是实查发现的存量变体（8 月初 2 篇），语义「待对抗审视/delta 复核」= 在途。 */
export const IN_FLIGHT_DOC_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "proposed",
  "design",
  "development",
  "active",
  "review",
  "reviewed",
]);

/** 已知终态值：豁免病态判定（链已收口，无「该干没干」诉求）。 */
export const TERMINAL_DOC_STATUSES: ReadonlySet<string> = new Set([
  "locked",
  "final",
  "implemented",
  "archived",
]);

/** 状态归属判定结果 */
export type DocStatusClass = "in-flight" | "terminal" | "unknown";

/**
 * 判定 status 值的契约归属。
 * null/undefined 归 in-flight（feature-doc-collector 语义：缺省视为草稿在途，
 * 与 chain-builder 原 `doc.status ?? "draft"` 行为一致）。
 * 行内注释变体（如 `implemented   # 代码已实现...`）由 yaml 解析器剥离，
 * 本函数收到的已是裸值——防御性 trim（万一手写文档夹带空白）。
 */
export function classifyDocStatus(status: string | null | undefined): DocStatusClass {
  if (status === null || status === undefined) return "in-flight";
  const v = status.trim();
  if (IN_FLIGHT_DOC_STATUSES.has(v)) return "in-flight";
  if (TERMINAL_DOC_STATUSES.has(v)) return "terminal";
  return "unknown";
}

/**
 * 值域契约完整性自检（模块加载时执行一次）：
 * 在途 ∪ 终态 必须 ⊆ KNOWN_FEATURE_STATUSES ∪ {review, reviewed}——
 * 若 known-values 未来扩值而本模块没同步分组，测试会在此处先炸。
 * 反向不要求（known-values 允许有值未分组，如新加但语义未定案的值——归 unknown 兜底）。
 */
const EXTRA_LEGACY = new Set(["review", "reviewed"]);
for (const s of [...IN_FLIGHT_DOC_STATUSES, ...TERMINAL_DOC_STATUSES]) {
  if (!(KNOWN_FEATURE_STATUSES as readonly string[]).includes(s) && !EXTRA_LEGACY.has(s)) {
    throw new Error(
      `doc-status contract drift: "${s}" not in KNOWN_FEATURE_STATUSES nor legacy extras — ` +
        "sync src/entities/document/doc-status.ts with known-values.ts",
    );
  }
}
