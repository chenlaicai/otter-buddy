/**
 * P2b2：夜间审视编排（night-review orchestrator）。
 *
 * 注册进 scheduler 的 FunctionRegistry（executorType='function'），每日 cron 触发。
 * 治量进代码、LLM 只做核对：编排层负责幂等取档（claim）、区间计算（水位/失败重跑）、
 * 当日 recorded 清单 + 原文注入、夜审獭召唤与解散、审后全量处置校验、变更集存档
 * （complete/recordFailure）、连败跳过 + healing、fyi 汇总 + matter 否决锚。
 *
 * 审-1946 首轮修复要点（均已单测钉住）：
 * - 变更集审计面 = 区间内全部 belief（四状态查询拼全集），不是「当前仍 recorded」——
 *   失败重跑时上轮已迁移条目不丢审计、不丢 fyi 否决锚；
 * - fyi 先于 complete（report 失败 → recordFailure → 重跑补发；complete 失败 → 重跑幂等补齐），
 *   matter 按 title 查重防重复登记；
 * - 召唤全程序 try/finally（CreateOtter/context 写入失败也记账+解散），dissolve 失败报 healing；
 * - invoke 带 race 超时（防 LLM 会话挂死拖住编排）；
 * - 连败达阈值当次即报 healing 并返回 skipped（不 throw——scheduler 不熔断任务，
 *   次日新键新区间自然重试，未清失败区间起点保证不丢审）。
 */
import {
  buildReviewKey,
  MAX_CONSECUTIVE_FAILURES,
  NIGHT_REVIEW_TASK_ID,
  NIGHT_REVIEW_RANGE_CONTEXT_KEY,
} from "@entities/memory/consolidation-state";
import { parseBeliefMetadata, type BeliefStatus } from "@entities/memory/belief";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import type { ConsolidationStateRepository } from "@usecases/memory/consolidation-state-repository";
import type { ManageConsolidationState } from "@usecases/memory/manage-consolidation-state";
import type { MemoryReader } from "@usecases/memory/memory-reader";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { OtterContextRepository } from "@usecases/otter/otter-context-repository";
import type { AgentTurnPort } from "@usecases/ports/agent-turn-port";
import type { RegisterMatter } from "@usecases/matter/register-matter";
import { matterShortAnchor } from "@usecases/matter/register-matter";
import type { MatterRepository } from "@usecases/matter/matter-repository";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SendEntry } from "@usecases/conversation/send-entry";
import { buildNightReviewerPrompt, buildNightReviewMessage } from "./night-review-prompt";
import type { Logger } from "@usecases/ports/logger";

/** 夜审时区（写进配置语义：v4 §4.2 固定时刻按此时区解释） */
export const NIGHT_REVIEW_TIMEZONE = "Asia/Shanghai";

/** 夜审獭 invoke 超时（分钟）——与任务 seed 的 timeoutMinutes 同源（防 LLM 会话挂死拖住编排） */
export const NIGHT_REVIEW_TIMEOUT_MINUTES = 240;

/** 首跑/无档兜底回看窗：30h（覆盖「昨天凌晨到今天凌晨」的完整审视日 + 缓冲） */
const DEFAULT_LOOKBACK_MS = 30 * 60 * 60 * 1000;

/** 区间全集查询的状态面（变更集审计覆盖区间内全部 belief，不只 recorded） */
const RANGE_STATUSES: readonly BeliefStatus[] = ["recorded", "verified", "disputed", "superseded"];

/** 夜审成功变更集（settle 后的 resultJson 契约形态，水位计算回读它） */
export interface NightReviewChangeset {
  date: string;
  after: string;
  through: string;
  reviewed: number;
  changes: Array<{ id: string; to: Exclude<BeliefStatus, "recorded"> }>;
}

/** 编排执行结果（FunctionRegistry 返回值，落 execution 日志） */
export interface NightReviewOutcome {
  reviewKey: string;
  date: string;
  after: string;
  through: string;
  /** true = 幂等撞键（已 settle），未重跑 */
  alreadySettled?: boolean;
  /** true = 连败跳过（同区间连败达阈值） */
  skipped?: boolean;
  reviewed: number;
  changes: NightReviewChangeset["changes"];
  matterAnchor?: string;
}

export interface NightReviewOrchestratorDeps {
  manageConsolidationState: ManageConsolidationState;
  consolidationRepo: ConsolidationStateRepository;
  memoryReader: MemoryReader;
  createOtter: CreateOtter;
  dissolveOtter: DissolveOtter;
  otterContextRepo: OtterContextRepository;
  agentTurnPort: AgentTurnPort;
  registerMatter: RegisterMatter;
  matterRepo: MatterRepository;
  healingRepo?: HealingEventRepository;
  sendEntry: SendEntry;
  logger: Logger;
}

export interface NightReviewParams {
  conversationId: string;
  senderId?: string;
  /** 时钟注入（测试用）；缺省取当前时间 */
  now?: Date;
}

/** Asia/Shanghai 墙钟日（YYYY-MM-DD）——审视幂等键的 date 维度 */
function reviewDateOf(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** 安全解析 settle 档的变更集（resultJson 损坏/旧形态按 null 处理，水位降级到兜底窗） */
function parseChangeset(resultJson: string): NightReviewChangeset | null {
  try {
    const parsed = JSON.parse(resultJson) as NightReviewChangeset;
    if (typeof parsed?.after !== "string" || typeof parsed?.through !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** settle 档回放视图（幂等撞键时还原原结果；损坏档案降级到空视图）。 */
function replayOf(resultJson: string): Pick<NightReviewOutcome, "after" | "through" | "reviewed" | "changes"> {
  const prior = parseChangeset(resultJson);
  return {
    after: prior?.after ?? "",
    through: prior?.through ?? "",
    reviewed: prior?.reviewed ?? 0,
    changes: prior?.changes ?? [],
  };
}

/** 状态中文标注（fyi 汇总用，与检索端 [已核实]/[存疑] 标注同词汇表） */
function statusLabel(to: Exclude<BeliefStatus, "recorded">): string {
  if (to === "verified") return "已核实";
  if (to === "disputed") return "存疑";
  return "已过期";
}

function statusOf(entry: MemoryEntry): BeliefStatus | null {
  return parseBeliefMetadata(entry)?.status ?? null;
}

export class NightReviewOrchestrator {
  constructor(private readonly deps: NightReviewOrchestratorDeps) {}

  async execute(params: NightReviewParams): Promise<NightReviewOutcome> {
    const now = params.now ?? new Date();
    const date = reviewDateOf(now, NIGHT_REVIEW_TIMEZONE);
    const reviewKey = buildReviewKey(date, NIGHT_REVIEW_TASK_ID);
    const base = { reviewKey, date, reviewed: 0, changes: [] as NightReviewChangeset["changes"] };

    // 1. 幂等取档：已 settle 直接返回原结果（LLM 重跑产出必不同，撞键不重跑）
    const claim = await this.deps.manageConsolidationState.claim(reviewKey);
    if (claim.settled && claim.resultJson) {
      return { ...base, ...replayOf(claim.resultJson), alreadySettled: true };
    }

    // 2. 区间决策：失败重跑用原区间；正常跑用跨档水位推进；连败达阈值跳过 + healing
    const ranged = await this.decideRange(params.conversationId, reviewKey, claim, now);
    if (ranged.skip) return { ...base, after: ranged.after, through: ranged.through, skipped: true };
    const { after, through } = ranged;

    // 3. 区间全集（四状态拼全）——变更集审计面。空集也是合法 settle（当天无现场记录）。
    const rangeAll = await this.loadRangeBeliefs(after, through);
    if (rangeAll.length === 0) {
      await this.settleEmpty(reviewKey, date, after, through);
      return { ...base, after, through };
    }

    // 4-6. 待审清单 = 全集中的 recorded；召唤夜审獭审它；审后按全集终态存档 + fyi
    return this.reviewWithOtter({ params, reviewKey, date, after, through, rangeAll, base });
  }

  /** 区间决策：claim 已有失败区间 → 重跑原区间（连败达阈值则跳过）；否则水位推进。 */
  private async decideRange(
    conversationId: string,
    reviewKey: string,
    claim: { failingRange: { after: string; through: string } | null; failures: number },
    now: Date,
  ): Promise<{ after: string; through: string; skip?: boolean }> {
    if (!claim.failingRange) {
      const through = now.toISOString();
      return { after: await this.resolveWatermarkAfter(through), through };
    }
    const { after, through } = claim.failingRange;
    if (claim.failures >= MAX_CONSECUTIVE_FAILURES) {
      // 同区间连败达阈值：这段没审视成，跳过并报 healing（不 complete——留档待人工介入）。
      // 次日新键 + 未清失败区间起点使水位仍覆盖该段——跳过的是「今天不再撞」，不是丢审。
      await this.reportSkipHealing(conversationId, reviewKey, after, through, claim.failures);
      this.deps.logger.warn("Night review skipped: consecutive failures reached threshold", {
        reviewKey, failures: claim.failures, after, through,
      });
      return { after, through, skip: true };
    }
    return { after, through };
  }

  /**
   * 跨档水位：after = min(最新 settle 档 through, 最早未清失败区间 failedAfter)。
   * settle 档 through 保证「上次成功审到哪」不重跑；未清失败区间保证「停机/失败漏掉的段」
   * 不丢审（v4 §4.4 停机错过 → 从旧水位继续）。无任何档 → 兜底回看窗（首跑）。
   */
  private async resolveWatermarkAfter(nowIso: string): Promise<string> {
    const states = await this.deps.consolidationRepo.listByTaskId(NIGHT_REVIEW_TASK_ID);
    let afterMs: number | undefined;
    for (const state of states) {
      if (state.resultJson !== null) {
        const cs = parseChangeset(state.resultJson);
        if (cs) afterMs = Math.max(afterMs ?? Number.NEGATIVE_INFINITY, Date.parse(cs.through));
      } else if (state.failedAfter !== null) {
        afterMs = Math.min(afterMs ?? Number.POSITIVE_INFINITY, Date.parse(state.failedAfter));
      }
    }
    if (afterMs === undefined || Number.isNaN(afterMs)) {
      return new Date(Date.parse(nowIso) - DEFAULT_LOOKBACK_MS).toISOString();
    }
    return new Date(afterMs).toISOString();
  }

  /** 区间全集：四状态查询拼接（变更集审计面是区间内全部 belief，不只 recorded）。 */
  private async loadRangeBeliefs(after: string, through: string): Promise<MemoryEntry[]> {
    const lists = await Promise.all(
      RANGE_STATUSES.map((status) => this.deps.memoryReader.listBeliefsByStatus(status, after, through)),
    );
    const seen = new Set<string>();
    const all: MemoryEntry[] = [];
    for (const list of lists) {
      for (const entry of list) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          all.push(entry);
        }
      }
    }
    return all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /** 空集 settle：当天无 recorded 也是合法完成（不召唤獭、不挂否决锚）。 */
  private async settleEmpty(reviewKey: string, date: string, after: string, through: string): Promise<void> {
    const changeset: NightReviewChangeset = { date, after, through, reviewed: 0, changes: [] };
    await this.deps.manageConsolidationState.complete(reviewKey, JSON.stringify(changeset));
    this.deps.logger.info("Night review settled with empty range", { reviewKey, after, through });
  }

  /**
   * 召唤獭 → invoke（超时保护）→ 审后校验 + 存档 + fyi。
   * 待审清单空（全集非空但无 recorded——上轮已迁移/全部即时 supersede）时不召唤獭，
   * 直接按全集终态 settle + fyi（审-1946 发现 3b：崩溃重跑的审计补全路径）。
   * 召唤全程序 try/finally：CreateOtter / context 写入 / invoke / settle 任一失败
   * 都走 recordFailure（连败达阈值当次报 healing 返回 skipped，不上抛熔断任务）；
   * 已创建的獭在 finally 解散（失败也报 healing，不留孤儿）。
   */
  private async reviewWithOtter(args: {
    params: NightReviewParams;
    reviewKey: string;
    date: string;
    after: string;
    through: string;
    rangeAll: MemoryEntry[];
    base: Pick<NightReviewOutcome, "reviewKey" | "date" | "reviewed" | "changes">;
  }): Promise<NightReviewOutcome> {
    const { params, reviewKey, date, after, through, rangeAll, base } = args;
    // 待审清单 = 全集中的 recorded。空（首轮全迁后崩溃的重跑/全部即时 supersede）时不
    // 召唤獭，但仍走统一 try/catch 的失败治理（补审计再失败也要 recordFailureOrSkip，
    // 不得直上抛让 scheduler 熔断——delta 复审补审计治理缺口）
    const pending = rangeAll.filter((b) => statusOf(b) === "recorded");
    let otterId: string | null = null;
    try {
      if (pending.length > 0) {
        // 召唤（P2a 档案）+ 快照范围写入獭 context（三迁移工具 fail-closed 校验的数据源）
        const otter = await this.deps.createOtter.execute({
          name: `夜审${date}T${new Date().toISOString().slice(11, 16).replace(":", "")}`,
          type: "night-reviewer",
          systemPrompt: buildNightReviewerPrompt(),
        });
        otterId = otter.id;
        await this.deps.otterContextRepo.set(
          otter.id,
          NIGHT_REVIEW_RANGE_CONTEXT_KEY,
          JSON.stringify({ after, through }),
        );
        // 锚点 entry + 清单注入 + 超时保护的 invoke
        await this.runPendingReview({ params, otterId: otter.id, date, after, through, pending });
      }
      // 审后校验 + 存档 + fyi（全集终态进 changeset——上轮已迁移/本轮迁移都入审计）
      const outcome = await this.settle({
        conversationId: params.conversationId, reviewKey, date, after, through, rangeAll, pending,
      });
      return { ...base, after, through, ...outcome };
    } catch (err) {
      // 失败记账：达阈值当次 skip（不上抛熔断任务）；否则原错误上抛走 failed 记账
      const skipped = await this.recordFailureOrSkip(params.conversationId, reviewKey, after, through);
      if (skipped) return { ...base, after, through, skipped: true };
      throw err;
    } finally {
      // 獭生命周期：创建成功即解散（审完/失败都散；獭不进对话名册，不 dissolve 即孤儿）
      if (otterId !== null) {
        try {
          await this.deps.dissolveOtter.execute(otterId, `夜间审视 ${date} 收尾，按编排解散`);
        } catch (dissolveErr) {
          this.deps.logger.warn("Night reviewer dissolve failed (orphan otter risk)", {
            otterId,
            error: dissolveErr instanceof Error ? dissolveErr.message : String(dissolveErr),
          });
          await this.reportDissolveFailureHealing(params.conversationId, otterId, date);
        }
      }
    }
  }

  /**
   * 失败记账：登记失败区间（同区间连败 +1）。达阈值当次报 healing 并返回 true
   * （调用方返 skipped 不上抛——scheduler 记 completed 不熔断任务，次日新键新区间
   * 自然重试，未清失败区间起点保证水位覆盖该段——跳过是「今天不再撞」，不是丢审）。
   */
  private async recordFailureOrSkip(
    conversationId: string, reviewKey: string, after: string, through: string,
  ): Promise<boolean> {
    try {
      const failure = await this.deps.manageConsolidationState.recordFailure(reviewKey, after, through);
      if (!failure.shouldSkip) return false;
      await this.reportSkipHealing(conversationId, reviewKey, after, through, failure.failures);
      this.deps.logger.warn("Night review skipped after failure: threshold reached in-run", {
        reviewKey, failures: failure.failures, after, through,
      });
      return true;
    } catch (recordErr) {
      this.deps.logger.error("Night review recordFailure failed (original error preserved)", recordErr as Error, { reviewKey });
      return false;
    }
  }

  /** 锚点 entry + 清单注入（原文）+ 超时保护的 invoke。 */
  private async runPendingReview(args: {
    params: NightReviewParams;
    otterId: string;
    date: string;
    after: string;
    through: string;
    pending: MemoryEntry[];
  }): Promise<void> {
    const { params, otterId, date, after, through, pending } = args;
    const anchors = await this.loadAnchors(pending);
    await this.deps.sendEntry.createSystemEntry({
      conversationId: params.conversationId,
      body: `🌙 夜间审视开始（${date}）：快照范围 [${after}, ${through}]，待核 ${pending.length} 条 recorded belief。`,
    });
    await this.invokeWithTimeout(
      () => this.deps.agentTurnPort.invokeConversation({
        otterId,
        conversationId: params.conversationId,
        userMessageContent: buildNightReviewMessage(after, through, pending, anchors),
        senderId: params.senderId ?? "system",
      }),
    );
  }

  /** invoke 的超时保护：超时抛错走 catch 的 recordFailure + finally 的 dissolve（放弃挂死会话）。 */
  private async invokeWithTimeout(invoke: () => Promise<unknown>): Promise<void> {
    const timeoutMs = NIGHT_REVIEW_TIMEOUT_MINUTES * 60_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        invoke(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`夜审獭 invoke 超时（${NIGHT_REVIEW_TIMEOUT_MINUTES} 分钟）——放弃本次会话`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 审后全量处置校验（待审清单里的 recorded 必须全部离开 recorded——残留 = 丢审 →
   * throw 走 catch 的 recordFailure）+ 变更集存档 + fyi 汇总与 matter 否决锚。
   * 顺序：fyi 先于 complete——report 失败可 recordFailure 重跑补发；complete 失败
   * 重跑时全集重读（无 recorded 待审）幂等补齐（matter 按 title 查重防重复登记）。
   */
  private async settle(args: {
    conversationId: string;
    reviewKey: string;
    date: string;
    after: string;
    through: string;
    rangeAll: MemoryEntry[];
    pending: MemoryEntry[];
  }): Promise<{ reviewed: number; changes: NightReviewChangeset["changes"]; matterAnchor?: string }> {
    const { conversationId, reviewKey, date, after, through, rangeAll, pending } = args;
    const terminal = await this.readTerminalStatuses(rangeAll);
    const unprocessed = pending.filter((b) => terminal.get(b.id) === undefined || terminal.get(b.id) === "recorded");
    if (unprocessed.length > 0) {
      this.deps.logger.warn("Night review incomplete: beliefs left unprocessed", {
        reviewKey, unprocessed: unprocessed.map((b) => b.id),
      });
      throw new Error(
        `夜间审视未全量处置：${unprocessed.length}/${pending.length} 条 recorded 未迁移（下次触发重跑同区间 [${after}, ${through}]）`,
      );
    }
    // changeset = 区间全集终态（上轮已迁移 + 本轮迁移 + 即时 supersede 都入审计）
    const changes = rangeAll
      .map((b) => {
        const to = terminal.get(b.id);
        return to !== undefined && to !== "recorded" ? { id: b.id, to: to as Exclude<BeliefStatus, "recorded"> } : null;
      })
      .filter((c): c is { id: string; to: Exclude<BeliefStatus, "recorded"> } => c !== null);
    const changeset: NightReviewChangeset = { date, after, through, reviewed: pending.length, changes };
    const matterAnchor = await this.reportChangeset(conversationId, changeset);
    await this.deps.manageConsolidationState.complete(reviewKey, JSON.stringify(changeset));
    this.deps.logger.info("Night review completed", {
      reviewKey, reviewed: pending.length, inRange: rangeAll.length,
      verified: changes.filter((c) => c.to === "verified").length,
    });
    return { reviewed: pending.length, changes, matterAnchor };
  }

  /** 读 belief 原文（anchors 指向的原始条目）。缺失的锚记 null——prompt 标注「原文缺失」由獭 reject。 */
  private async loadAnchors(beliefs: MemoryEntry[]): Promise<Map<string, MemoryEntry | null>> {
    const ids = new Set<string>();
    for (const b of beliefs) {
      const meta = parseBeliefMetadata(b);
      for (const a of meta?.anchors ?? []) ids.add(a);
      for (const a of meta?.inferredFrom ?? []) ids.add(a);
    }
    const map = new Map<string, MemoryEntry | null>();
    const found = await this.deps.memoryReader.getDetails([...ids]);
    for (const entry of found) map.set(entry.id, entry);
    for (const id of ids) if (!map.has(id)) map.set(id, null);
    return map;
  }

  /** 审后读全集终态。条目消失（被物理清理）按 undefined 处理为未处置（fail-closed）。 */
  private async readTerminalStatuses(beliefs: MemoryEntry[]): Promise<Map<string, BeliefStatus>> {
    const found = await this.deps.memoryReader.getDetails(beliefs.map((b) => b.id));
    const map = new Map<string, BeliefStatus>();
    for (const entry of found) {
      const meta = parseBeliefMetadata(entry);
      if (meta) map.set(entry.id, meta.status);
    }
    return map;
  }

  /** 连败跳过的 healing 上报（「这段没审视成」标记——搭档可见，人工介入入口）。失败仅日志。 */
  private async reportSkipHealing(
    conversationId: string, reviewKey: string, after: string, through: string, failures: number,
  ): Promise<void> {
    if (!this.deps.healingRepo) return;
    try {
      await this.deps.healingRepo.create({
        id: crypto.randomUUID(),
        messageId: "",
        conversationId,
        otterId: "",
        errorType: "other",
        severity: "medium",
        description: `夜间审视区间 [${after}, ${through}] 同区间连败 ${failures} 次，已跳过——这段没审视成（次日新区间自动重试，未清失败区间保证水位覆盖）`,
        suggestion: "检查夜审时段 LLM 会话失败原因（配额/超时/模型状态）；恢复后可手动触发任务重跑该区间",
        context: { reviewKey, after, through, failures },
        status: "open",
        resolution: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
    } catch (err) {
      this.deps.logger.warn("Night review skip healing report failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** dissolve 失败的 healing 上报（孤儿受限写者残留——需要人工清理）。失败仅日志。 */
  private async reportDissolveFailureHealing(conversationId: string, otterId: string, date: string): Promise<void> {
    if (!this.deps.healingRepo) return;
    try {
      await this.deps.healingRepo.create({
        id: crypto.randomUUID(),
        messageId: "",
        conversationId,
        otterId,
        errorType: "other",
        severity: "medium",
        description: `夜审獭（${date}）解散失败——active 受限写者可能残留，需人工清理`,
        suggestion: "检查该獭 session 状态后手动解散（dissolve_otter）；残留獭持有 belief 迁移工具白名单",
        context: { otterId, date },
        status: "open",
        resolution: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
    } catch (err) {
      this.deps.logger.warn("Night review dissolve-failure healing report failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * fyi：变更汇总 system entry + matter 否决锚（payload 存变更集，打回时大獭用
   * belief_dispute 按条目迁 disputed）。matter 按 title 查重幂等（重跑补发不重复登记）。
   */
  private async reportChangeset(conversationId: string, changeset: NightReviewChangeset): Promise<string> {
    const title = `夜间审视 ${changeset.date}：${changeset.changes.length} 条 belief 迁移待过目`;
    // 查重窗口：repo 默认只回最近 50 条（delta 审视发现 17）——夜审 matter 每日累积，
    // 补发重跑与首次登记之间可能隔超过 50 条新 matter。窗口提到 1000（单对话 matter
    // 极端量级），超出窗口的重复登记代价是搭档多闭环一条 WAITING_PARTNER，非数据损坏。
    const existing = await this.deps.matterRepo.findByConversation(conversationId, undefined, 1000);
    const prior = existing.find((m) => m.title === title);
    let matterId: string;
    if (prior) {
      matterId = prior.id; // 重跑补发：同日同标题复用，不重复登记
    } else {
      const matter = await this.deps.registerMatter.execute({
        conversationId,
        title,
        originMessageId: null,
        ownerOtterId: null,
        initialState: "WAITING_PARTNER",
        waitingOn: "partner",
        waitingFor: "回复「打回 <短锚>」即把对应 belief 迁 disputed（大獭执行 belief_dispute）；无异议即保留",
        payload: JSON.stringify(changeset),
      });
      matterId = matter.id;
    }
    const anchor = matterShortAnchor(matterId);
    const lines = changeset.changes.map((c) => `- [${statusLabel(c.to)}] ${c.id} → ${c.to}`);
    await this.deps.sendEntry.createSystemEntry({
      conversationId,
      body: [
        `🌙 **夜间审视完成（${changeset.date}）**`,
        "",
        `快照范围 [${changeset.after}, ${changeset.through}]，核对 ${changeset.reviewed} 条 recorded belief，区间全集 ${changeset.changes.length} 条处置：`,
        ...lines,
        "",
        `否决锚：${anchor}——回复「打回 ${anchor}」即把该批 belief 迁 disputed（存疑重新入审），无异议即保留。`,
      ].join("\n"),
    });
    return anchor;
  }
}
