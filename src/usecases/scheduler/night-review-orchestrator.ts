/**
 * P2b2：夜间审视编排（night-review orchestrator）。
 *
 * 注册进 scheduler 的 FunctionRegistry（executorType='function'），每日 cron 触发。
 * 治量进代码、LLM 只做核对：编排层负责幂等取档（claim）、区间计算（水位/失败重跑）、
 * 当日 recorded 清单 + 原文注入、夜审獭召唤与解散、审后全量处置校验、变更集存档
 * （complete/recordFailure）、连败跳过 + healing、fyi 汇总 + matter 否决锚。
 *
 * 消费 P2b1 接口：ManageConsolidationState(claim/complete/recordFailure)
 * + MemoryReader.listBeliefsByStatus(status, after, through)。
 *
 * 獭召唤（P2a 档案）：CreateOtter(type='night-reviewer')——白名单恒 5 工具
 * （speak/yield + 三迁移），快照范围写进獭 otter context（NIGHT_REVIEW_RANGE_CONTEXT_KEY），
 * 三迁移工具执行时读取校验（fail-closed），白名单不含 set_context 故 LLM 无法篡改。
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
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SendEntry } from "@usecases/conversation/send-entry";
import type { Logger } from "@usecases/ports/logger";

/** 夜审时区（写进配置语义：v4 §4.2 固定时刻按此时区解释） */
export const NIGHT_REVIEW_TIMEZONE = "Asia/Shanghai";

/** 首跑/无档兜底回看窗：30h（覆盖「昨天凌晨到今天凌晨」的完整审视日 + 缓冲） */
const DEFAULT_LOOKBACK_MS = 30 * 60 * 60 * 1000;

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

/** 状态中文标注（fyi 汇总用，与检索端 [已核实]/[存疑] 标注同词汇表） */
function statusLabel(to: Exclude<BeliefStatus, "recorded">): string {
  if (to === "verified") return "已核实";
  if (to === "disputed") return "存疑";
  return "已过期";
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

    // 3. 当日 recorded 清单：空集也是合法 settle（当天无现场记录）
    const beliefs = await this.deps.memoryReader.listBeliefsByStatus("recorded", after, through);
    if (beliefs.length === 0) {
      await this.settleEmpty(reviewKey, date, after, through);
      return { ...base, after, through };
    }

    // 4-6. 召唤夜审獭 + invoke + 审后校验存档（失败统一 recordFailure，獭 finally 解散）
    return this.reviewWithOtter({ params, reviewKey, date, after, through, beliefs, base });
  }

  /** 空集 settle：当天无 recorded 也是合法完成（不召唤獭、不挂否决锚）。 */
  private async settleEmpty(reviewKey: string, date: string, after: string, through: string): Promise<void> {
    const changeset: NightReviewChangeset = { date, after, through, reviewed: 0, changes: [] };
    await this.deps.manageConsolidationState.complete(reviewKey, JSON.stringify(changeset));
    this.deps.logger.info("Night review settled with empty range", { reviewKey, after, through });
  }

  /** 召唤獭 → invoke → 审后校验 + 存档 + fyi；任一环节失败 recordFailure 后上抛（獭 finally 解散）。 */
  private async reviewWithOtter(args: {
    params: NightReviewParams;
    reviewKey: string;
    date: string;
    after: string;
    through: string;
    beliefs: MemoryEntry[];
    base: Pick<NightReviewOutcome, "reviewKey" | "date" | "reviewed" | "changes">;
  }): Promise<NightReviewOutcome> {
    const { params, reviewKey, date, after, through, beliefs, base } = args;
    const otter = await this.summonReviewer(date, after, through);
    try {
      await this.runReviewer({ params, otterId: otter.id, date, after, through, beliefs });
      const outcome = await this.settle({ conversationId: params.conversationId, reviewKey, date, after, through, beliefs });
      return { ...base, after, through, ...outcome };
    } catch (err) {
      // invoke/校验任一环节失败：登记失败区间（同区间连败 +1），错误上抛走 function executor
      // 的 failed 记账（scheduler 3 连败熔断 + 迟到补跑对账自然衔接）
      try {
        await this.deps.manageConsolidationState.recordFailure(reviewKey, after, through);
      } catch (recordErr) {
        this.deps.logger.error("Night review recordFailure failed (original error preserved)", recordErr as Error, { reviewKey });
      }
      throw err;
    } finally {
      // 獭生命周期：审完即解散（獭不进对话名册，不 dissolve 即孤儿）
      try {
        await this.deps.dissolveOtter.execute(otter.id, `夜间审视 ${date} 完成，按编排解散`);
      } catch (dissolveErr) {
        this.deps.logger.warn("Night reviewer dissolve failed (orphan otter risk)", {
          otterId: otter.id,
          error: dissolveErr instanceof Error ? dissolveErr.message : String(dissolveErr),
        });
      }
    }
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
      // 同区间连败达阈值：这段没审视成，跳过并报 healing（不 complete——留档待人工介入）
      await this.reportSkipHealing(conversationId, reviewKey, after, through, claim.failures);
      this.deps.logger.warn("Night review skipped: consecutive failures reached threshold", {
        reviewKey, failures: claim.failures, after, through,
      });
      return { after, through, skip: true };
    }
    return { after, through };
  }

  /** 召唤夜审獭（P2a 档案）+ 快照范围写入獭 context（三迁移工具 fail-closed 校验的数据源）。 */
  private async summonReviewer(date: string, after: string, through: string) {
    const nowStamp = new Date().toISOString().slice(11, 16).replace(":", "");
    const otter = await this.deps.createOtter.execute({
      name: `夜审${date}T${nowStamp}`,
      type: "night-reviewer",
      systemPrompt: buildNightReviewerPrompt(),
    });
    await this.deps.otterContextRepo.set(
      otter.id,
      NIGHT_REVIEW_RANGE_CONTEXT_KEY,
      JSON.stringify({ after, through }),
    );
    return otter;
  }

  /** 触发锚点（时间线可见性）+ invoke 夜审獭（清单 + 原文注入）。 */
  private async runReviewer(args: {
    params: NightReviewParams;
    otterId: string;
    date: string;
    after: string;
    through: string;
    beliefs: MemoryEntry[];
  }): Promise<void> {
    const { params, otterId, date, after, through, beliefs } = args;
    await this.deps.sendEntry.createSystemEntry({
      conversationId: params.conversationId,
      body: `🌙 夜间审视开始（${date}）：快照范围 [${after}, ${through}]，待核 ${beliefs.length} 条 recorded belief。`,
    });
    await this.deps.agentTurnPort.invokeConversation({
      otterId,
      conversationId: params.conversationId,
      userMessageContent: buildNightReviewMessage(after, through, beliefs, await this.loadAnchors(beliefs)),
      senderId: params.senderId ?? "system",
    });
  }

  /**
   * 审后全量处置校验（recorded 残留 = 丢审 → throw 走 catch 的 recordFailure）
   * + 变更集存档（complete）+ fyi 汇总与 matter 否决锚。
   */
  private async settle(args: {
    conversationId: string;
    reviewKey: string;
    date: string;
    after: string;
    through: string;
    beliefs: MemoryEntry[];
  }): Promise<{ reviewed: number; changes: NightReviewChangeset["changes"]; matterAnchor?: string }> {
    const { conversationId, reviewKey, date, after, through, beliefs } = args;
    const terminal = await this.readTerminalStatuses(beliefs);
    const pending = beliefs.filter((b) => terminal.get(b.id) === undefined || terminal.get(b.id) === "recorded");
    if (pending.length > 0) {
      this.deps.logger.warn("Night review incomplete: beliefs left unprocessed", {
        reviewKey, pending: pending.map((b) => b.id),
      });
      throw new Error(
        `夜间审视未全量处置：${pending.length}/${beliefs.length} 条 recorded 未迁移（下次触发重跑同区间 [${after}, ${through}]）`,
      );
    }
    const changes = beliefs
      .map((b) => ({ id: b.id, to: terminal.get(b.id) as Exclude<BeliefStatus, "recorded"> }))
      .filter((c) => c.to !== undefined);
    const changeset: NightReviewChangeset = { date, after, through, reviewed: beliefs.length, changes };
    await this.deps.manageConsolidationState.complete(reviewKey, JSON.stringify(changeset));
    const matterAnchor = await this.reportChangeset(conversationId, changeset);
    this.deps.logger.info("Night review completed", {
      reviewKey, reviewed: beliefs.length, verified: changes.filter((c) => c.to === "verified").length,
    });
    return { reviewed: beliefs.length, changes, matterAnchor };
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

  /** 审后读终态：审前 id 集 → 当前状态。条目消失（被物理清理）按 undefined 处理为未处置。 */
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
        description: `夜间审视区间 [${after}, ${through}] 同区间连败 ${failures} 次，已跳过——这段没审视成`,
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

  /** fyi：变更汇总 system entry + matter 否决锚（payload 存变更集，打回时大獭按 id 迁 disputed）。 */
  private async reportChangeset(conversationId: string, changeset: NightReviewChangeset): Promise<string> {
    const matter = await this.deps.registerMatter.execute({
      conversationId,
      title: `夜间审视 ${changeset.date}：${changeset.changes.length} 条 belief 迁移待过目`,
      originMessageId: null,
      ownerOtterId: null,
      initialState: "WAITING_PARTNER",
      waitingOn: "partner",
      waitingFor: "回复「打回 <短锚>」即把对应 belief 迁 disputed；无异议即保留",
      payload: JSON.stringify(changeset),
    });
    const anchor = matterShortAnchor(matter.id);
    const lines = changeset.changes.map((c) => `- [${statusLabel(c.to)}] ${c.id} → ${c.to}`);
    await this.deps.sendEntry.createSystemEntry({
      conversationId,
      body: [
        `🌙 **夜间审视完成（${changeset.date}）**`,
        "",
        `快照范围 [${changeset.after}, ${changeset.through}]，核对 ${changeset.reviewed} 条 recorded belief：`,
        ...lines,
        "",
        `否决锚：${anchor}——回复「打回 ${anchor}」即把该批 belief 迁 disputed（存疑重新入审），无异议即保留。`,
      ].join("\n"),
    });
    return anchor;
  }
}

/** 夜审獭系统提示词（受限写者身份 + 承重不变量：全量核对、默认拒、禁删只迁移）。 */
export function buildNightReviewerPrompt(): string {
  return [
    "你是夜间审视獭（night-reviewer），主动记忆层的独立核实者。你的唯一职责：对快照范围内的 recorded belief 逐条核对原文，做出状态迁移。",
    "",
    "判断规则（防编造链承重不变量）：",
    "- 全量核对、非抽样、默认拒——审视是整条防编造链的承重件，不是安检表演。",
    "- 原文与 belief 正文语义吻合 → belief_verify（核实 → verified）",
    "- 原文与 belief 正文不吻合（曲解、过度引申、无中生有）→ belief_reject（打回 → disputed）",
    "- 原文真实但已被后续事实取代（认识过期）→ belief_supersede（标记过期 → superseded，旧条目保留）",
    "- 工具只接受快照范围内创建的条目（范围外调用会被拒）。",
    "- 禁止删除：三个工具都只迁状态，改不了条目内容。",
    "",
    "流程要求：",
    "1. 逐条核对清单中的 belief（正文 + 原文锚点）；每条必须处置——没有「保持原状」选项，拿不准就是 reject。",
    "2. 全部处置完后：speak 一条变更汇总（每条标注 [已核实]/[存疑]/[已过期]），然后 yield 交给 user 收尾。",
    "3. 不要发起讨论、不要派工、不要调用清单外的工具。",
  ].join("\n");
}

/** 夜审任务消息（当日清单 + 原文 + 快照范围注入）。 */
export function buildNightReviewMessage(
  after: string,
  through: string,
  beliefs: MemoryEntry[],
  anchors: Map<string, MemoryEntry | null>,
): string {
  const items = beliefs.map((b, i) => {
    const meta = parseBeliefMetadata(b);
    const anchorLines = (meta?.anchors ?? []).map((a) => {
      const src = anchors.get(a);
      return src
        ? `  - [${a}] ${src.content}`
        : `  - [${a}]（原文缺失——按 reject 处置）`;
    });
    const inferredLines = (meta?.inferredFrom ?? []).map((a) => {
      const src = anchors.get(a);
      return src ? `  - [${a}] ${src.content}` : `  - [${a}]（依据缺失）`;
    });
    return [
      `## 条目 ${i + 1}`,
      `- id: ${b.id}`,
      `- kind: ${meta?.kind ?? "unknown"}`,
      `- belief 正文: ${b.content}`,
      "- 原文锚点:",
      ...anchorLines,
      ...(inferredLines.length > 0 ? ["- 推断依据:", ...inferredLines] : []),
    ].join("\n");
  });
  return [
    `# 夜间审视任务（快照范围 [${after}, ${through}]）`,
    "",
    `当日 recorded belief 共 ${beliefs.length} 条。逐条核对原文，对每条调用 belief_verify / belief_reject / belief_supersede 之一，全部处置完后 speak 汇总并 yield user。`,
    "",
    ...items,
  ].join("\n");
}
