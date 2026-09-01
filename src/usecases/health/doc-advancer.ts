/**
 * DocAdvancer: 文档状态自动推进器（Issue #646 段3，合议定稿 review-lunheng.md §二）
 *
 * 根治「干完没归档」假警报（18 条 chain_stall 主因）：按链证据自动推进 F 文档 frontmatter
 * status/substatus。三层交付：
 *   1. planDocAdvancements——纯函数：链证据 → 推进计划（无副作用，单测全覆盖）
 *   2. applyAdvancements——frontmatter 改写（幂等，保留行内注释等手工语义）
 *   3. scripts/docs-advance.mjs——CLI 薄壳：临时 worktree + 每日一个汇总 PR（R1 红线）
 *
 * 推进规则（全部只动已知值，未知 status 一律跳过并留痕）：
 *   R1 迭代标记：纯 implemented ∧ 链上最后 commit ≤ iterationDays → 加 substatus: active
 *      （合入后又有新 commit = 迭代中，参与病态判定——分批合入大特性不提前标完成）
 *   R2 迭代收口：implemented + substatus:active ∧ 最后 commit > iterationDays → 删 substatus
 *      （迭代静默 ≥ 阈值，收口回纯 implemented 豁免）
 *   R3 高置信归档：in-flight ∧ commitCount ≥ 1 ∧ 全 commit 带 prNumber ∧ 最后 commit > quietDays
 *      → status → implemented（issue 定案的高置信子集：全 PR 合入 + 静默 60 天；
 *      其余交僵尸阶梯消化，防「干一半放弃」误标完成污染基线）
 *
 * 不推进：unknown status（留痕）/ final、locked、archived（真终态）/ doc-only 无 commit
 * （无实现证据，git log 区分不了「没干」与「干完没归档」，不猜）。
 */

import * as fs from "node:fs/promises";
import { classifyDocStatus, classifyDocStatusWithSubstatus } from "@entities/document/doc-status";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AdvancerOptions {
  /** 现在时刻（默认 new Date()，测试可注入） */
  now?: Date;
  /** R1/R2 迭代判定阈值天数（默认 14，与 chain-builder stalledDays 同口径） */
  iterationDays?: number;
  /** R3 高置信静默阈值天数（默认 60，issue 定稿口径） */
  quietDays?: number;
}

/** 单条推进动作 */
export interface AdvancementAction {
  fid: string;
  /** 动作类型 */
  kind: "mark-iterating" | "close-iteration" | "archive";
  /** 证据摘要（PR 描述/日志用） */
  reason: string;
  /** 目标文档相对路径 */
  filePath: string;
  /** R3：变更前状态（R1/R2 不改 status） */
  fromStatus?: string;
}

/** 推进计划：动作 + 跳过留痕（issue 验收：未知值跳过且日志留痕） */
export interface AdvancementPlan {
  actions: AdvancementAction[];
  /** 跳过留痕：fid → 原因 */
  skipped: Array<{ fid: string; status: string | null; reason: string }>;
  /** 计划生成时刻 */
  plannedAt: string;
}

/** 链证据视图（planDocAdvancements 的输入子集；直接收 FeatureChain 亦可——结构兼容） */
export interface ChainEvidence {
  featureId: string;
  doc: { status: string | null; substatus?: string | null; filePath: string } | null;
  /** sha 可选：R1 判定需链尾 sha；省略时 R1 保守不标 */
  commits: Array<{ date: Date; prNumber: number | null; sha?: string }>;
  lastCommitAt: Date | null;
  commitCount: number;
  /** 文档文件最后一次被改的 commit sha（#646 实现 R1 修正：区分「标注与 commit 同步」与「标注后叉迭代」。
 *  undefined = 未采集 → 保守不标迭代（无证据不猜） */
  docLastTouchedSha?: string | null;
}

/**
 * 规划推进动作（纯函数，无 IO）。
 */
export function planDocAdvancements(chains: ChainEvidence[], options: AdvancerOptions = {}): AdvancementPlan {
  const now = options.now ?? new Date();
  const iterationDays = options.iterationDays ?? 14;
  const quietDays = options.quietDays ?? 60;

  const actions: AdvancementAction[] = [];
  const skipped: AdvancementPlan["skipped"] = [];

  for (const chain of chains) {
    if (shouldSkipChain(chain)) continue;
    const status = chain.doc!.status;

    // 未知值一律不碰（写死策略，防覆盖手工语义）——留痕
    if (classifyDocStatus(status) === "unknown") {
      skipped.push({ fid: chain.featureId, status, reason: "unknown status：值域外，不碰（防覆盖手工语义）" });
      continue;
    }

    if (status === "implemented") {
      planImplemented(chain, { now, iterationDays }, actions);
    } else {
      planInFlight(chain, { now, quietDays }, actions, skipped);
    }
  }

  return { actions, skipped, plannedAt: now.toISOString() };
}

/** 推进前置守卫：orphan / 真终态 / doc-only 无 commit 一律跳过（各自语义见内联注释）。 */
function shouldSkipChain(chain: ChainEvidence): boolean {
  if (!chain.doc) return true; // orphan 链无文档，无事可推进
  const s = chain.doc.status;
  // 真终态（final/locked/archived）无推进语义
  if (s === "final" || s === "locked" || s === "archived") return true;
  // doc-only 无 commit：无实现证据，不推进（「没干」与「干完没归档」不可区分，不猜）
  return chain.commitCount === 0 || !chain.lastCommitAt;
}

/** R1/R2：implemented 的迭代标记与收口。
 *  R1 关键区分：仅当「链尾 commit 未触碰文档」（标注早于代码活动 = 标完后叉迭代）才标迭代。
 *  反例（2026-09-01 dry-run 实测）：文档随 PR 同步标 implemented（docLastTouchedSha == 链尾 sha）
 *  ——那是完成拍板，不是迭代。无 docLastTouchedSha 证据时保守不标（宁可漏标不可误标）。 */
function planImplemented(
  chain: ChainEvidence,
  ctx: { now: Date; iterationDays: number },
  actions: AdvancementAction[],
): void {
  const idleDays = Math.floor((ctx.now.getTime() - chain.lastCommitAt!.getTime()) / DAY_MS);
  const lastSha = chain.commits[chain.commits.length - 1]?.sha ?? null;
  const docTouchedAfterLastCommit =
    lastSha !== null && chain.docLastTouchedSha !== undefined && chain.docLastTouchedSha !== lastSha;
  const iterating = chain.doc!.substatus === "active";

  if (!iterating && docTouchedAfterLastCommit && idleDays <= ctx.iterationDays) {
    actions.push({
      fid: chain.featureId,
      kind: "mark-iterating",
      reason: `implemented 后 ${idleDays} 天内有新 commit（最后 ${chain.lastCommitAt!.toISOString().slice(0, 10)}）→ 标记迭代中`,
      filePath: chain.doc!.filePath,
    });
  } else if (iterating && idleDays > ctx.iterationDays) {
    actions.push({
      fid: chain.featureId,
      kind: "close-iteration",
      reason: `迭代已静默 ${idleDays} 天（> ${ctx.iterationDays}）→ 收口回纯 implemented`,
      filePath: chain.doc!.filePath,
    });
  }
}

/** R3：在途链的高置信归档（全 commit 带 PR 号 ∧ 静默超阈值）。其余交僵尸阶梯。 */
function planInFlight(
  chain: ChainEvidence,
  ctx: { now: Date; quietDays: number },
  actions: AdvancementAction[],
  skipped: AdvancementPlan["skipped"],
): void {
  const status = chain.doc!.status;
  if (classifyDocStatusWithSubstatus(status, chain.doc!.substatus) !== "in-flight") return;

  const idleDays = Math.floor((ctx.now.getTime() - chain.lastCommitAt!.getTime()) / DAY_MS);
  const allViaPr = chain.commits.length > 0 && chain.commits.every(c => c.prNumber !== null);

  if (allViaPr && idleDays > ctx.quietDays) {
    actions.push({
      fid: chain.featureId,
      kind: "archive",
      reason: `在途 ${status} 但 ${chain.commits.length} 个 commit 全带 PR 号且静默 ${idleDays} 天（> ${ctx.quietDays}）→ 高置信归档为 implemented`,
      filePath: chain.doc!.filePath,
      fromStatus: status ?? "",
    });
  } else if (!allViaPr && idleDays > ctx.quietDays) {
    skipped.push({
      fid: chain.featureId,
      status,
      reason: `静默 ${idleDays} 天但存在无 PR 号 commit（非高置信子集）→ 交僵尸阶梯消化`,
    });
  }
}

/**
 * 应用推进计划：改写 docs frontmatter（幂等——重复 apply 同一计划，第二次无变更）。
 * 保留行内注释（如 `status: implemented   # 代码已实现...`）等手工语义，只动目标字段值。
 * @param repoPath 仓库根（actions[].filePath 相对于它）
 * @returns 实际改动的文件数（幂等重跑为 0）
 */
export async function applyAdvancements(plan: AdvancementPlan, repoPath: string): Promise<number> {
  let changed = 0;
  for (const action of plan.actions) {
    const abs = `${repoPath}/${action.filePath}`;
    let content: string;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      continue; // 文件被移动/删除：跳过（下轮扫描自然更新 filePath）
    }
    const updated = rewriteFrontmatter(content, action);
    if (updated !== content) {
      await fs.writeFile(abs, updated, "utf-8");
      changed++;
    }
  }
  return changed;
}

/** frontmatter 块内逐行改写（保留注释/缩进/其他字段原样） */
function rewriteFrontmatter(content: string, action: AdvancementAction): string {
  const lines = content.split("\n");
  const fmEnd = lines.indexOf("---", 1); // 第二个 ---（frontmatter 结束）
  if (fmEnd === -1) return content;

  let statusLineIdx = -1;
  let substatusLineIdx = -1;
  for (let i = 1; i < fmEnd; i++) {
    if (/^status:/.test(lines[i]!)) statusLineIdx = i;
    if (/^substatus:/.test(lines[i]!)) substatusLineIdx = i;
  }
  if (statusLineIdx === -1) return content; // 无 status 字段，不猜

  switch (action.kind) {
    case "mark-iterating":
      if (substatusLineIdx !== -1) return content; // 已有 substatus，幂等
      // status 行后插 substatus: active
      lines.splice(statusLineIdx + 1, 0, "substatus: active");
      return lines.join("\n");
    case "close-iteration":
      if (substatusLineIdx === -1) return content; // 本无 substatus，幂等
      lines.splice(substatusLineIdx, 1);
      return lines.join("\n");
    case "archive":
      return replaceStatusValue(lines, statusLineIdx, "implemented");
  }
}

/** 改 status 值保留行内注释：`status: development   # 备注` → `status: implemented   # 备注` */
function replaceStatusValue(lines: string[], idx: number, newValue: string): string {
  const line = lines[idx]!;
  const m = line.match(/^(status:\s*)(\S+)(.*)$/);
  if (!m) return lines.join("\n");
  lines[idx] = `${m[1]}${newValue}${m[3]}`;
  return lines.join("\n");
}
